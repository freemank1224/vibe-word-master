-- ================================================================
-- Global Image Assets (Zero-downtime migration)
-- Date: 2026-06-08
-- Purpose:
--   1) Build a shared image asset library across all users
--   2) Map per-user words to shared image assets
--   3) Add storage cleanup jobs for orphan image files
--   4) Extend orphan cleanup function to handle image_assets
-- ================================================================

BEGIN;

-- 1) Shared image asset table
CREATE TABLE IF NOT EXISTS public.image_assets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_word  TEXT NOT NULL,
  display_word     TEXT NOT NULL,
  language         VARCHAR(10) NOT NULL DEFAULT 'en',
  model            TEXT NOT NULL DEFAULT 'unknown',
  storage_bucket   TEXT NOT NULL DEFAULT 'word-images',
  storage_path     TEXT NOT NULL,
  public_url       TEXT,
  prompt_hash      TEXT,
  file_size_bytes  BIGINT,
  width            INTEGER,
  height           INTEGER,
  status           TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'ready', 'failed', 'disabled')),
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT image_assets_word_lang_uniq UNIQUE (normalized_word, language)
);

CREATE INDEX IF NOT EXISTS image_assets_status_idx
  ON public.image_assets(status);

CREATE INDEX IF NOT EXISTS image_assets_word_lang_idx
  ON public.image_assets(normalized_word, language);

-- 2) Storage cleanup jobs for image files (same pattern as pronunciation)
CREATE TABLE IF NOT EXISTS public.image_asset_storage_cleanup_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_bucket TEXT NOT NULL DEFAULT 'word-images',
  storage_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT image_asset_storage_cleanup_jobs_bucket_path_uniq
    UNIQUE (storage_bucket, storage_path)
);

CREATE INDEX IF NOT EXISTS image_asset_storage_cleanup_jobs_status_idx
  ON public.image_asset_storage_cleanup_jobs(status, created_at);

-- Auto-update updated_at triggers
DROP TRIGGER IF EXISTS trg_image_assets_updated_at ON public.image_assets;
CREATE TRIGGER trg_image_assets_updated_at
BEFORE UPDATE ON public.image_assets
FOR EACH ROW
EXECUTE FUNCTION public.set_row_updated_at();

DROP TRIGGER IF EXISTS trg_image_asset_storage_cleanup_jobs_updated_at
  ON public.image_asset_storage_cleanup_jobs;
CREATE TRIGGER trg_image_asset_storage_cleanup_jobs_updated_at
BEFORE UPDATE ON public.image_asset_storage_cleanup_jobs
FOR EACH ROW
EXECUTE FUNCTION public.set_row_updated_at();

-- 3) Add mapping column to words (user words -> global image assets)
ALTER TABLE public.words
  ADD COLUMN IF NOT EXISTS image_asset_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'words_image_asset_id_fkey'
      AND conrelid = 'public.words'::regclass
  ) THEN
    ALTER TABLE public.words
      ADD CONSTRAINT words_image_asset_id_fkey
      FOREIGN KEY (image_asset_id)
      REFERENCES public.image_assets(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS words_image_asset_id_idx
  ON public.words(image_asset_id);

-- 4) RLS policies
ALTER TABLE public.image_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.image_asset_storage_cleanup_jobs ENABLE ROW LEVEL SECURITY;

-- Anyone can read ready image assets (public bucket, public images)
DROP POLICY IF EXISTS image_assets_read_ready ON public.image_assets;
CREATE POLICY image_assets_read_ready
  ON public.image_assets
  FOR SELECT
  USING (status = 'ready');

-- Service role has full access to image_assets
DROP POLICY IF EXISTS image_assets_service_all ON public.image_assets;
CREATE POLICY image_assets_service_all
  ON public.image_assets
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Service role has full access to cleanup jobs
DROP POLICY IF EXISTS image_asset_storage_cleanup_jobs_service_all
  ON public.image_asset_storage_cleanup_jobs;
CREATE POLICY image_asset_storage_cleanup_jobs_service_all
  ON public.image_asset_storage_cleanup_jobs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 5) Helper: enqueue image storage cleanup
CREATE OR REPLACE FUNCTION public.enqueue_image_asset_storage_cleanup(
  p_storage_bucket TEXT,
  p_storage_path TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bucket TEXT := coalesce(nullif(trim(coalesce(p_storage_bucket, '')), ''), 'word-images');
  v_path TEXT := nullif(trim(coalesce(p_storage_path, '')), '');
BEGIN
  IF v_path IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.image_asset_storage_cleanup_jobs (
    storage_bucket, storage_path, status, attempt_count, last_error
  )
  VALUES (v_bucket, v_path, 'pending', 0, NULL)
  ON CONFLICT (storage_bucket, storage_path)
  DO UPDATE SET
    status = 'pending',
    last_error = NULL,
    updated_at = now();
END;
$$;

-- 6) Extend orphan cleanup to also handle image_assets
CREATE OR REPLACE FUNCTION public.cleanup_global_word_resources_for_key(
  p_normalized_text TEXT,
  p_language VARCHAR(10)
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_normalized TEXT := nullif(trim(coalesce(p_normalized_text, '')), '');
  v_language VARCHAR(10) := coalesce(nullif(trim(coalesce(p_language, '')), ''), 'en');
  v_has_active BOOLEAN := false;
BEGIN
  IF v_normalized IS NULL THEN
    RETURN;
  END IF;

  -- Check if any active user word still references this normalized word + language
  SELECT EXISTS (
    SELECT 1
    FROM public.words w
    WHERE (w.deleted = false OR w.deleted IS NULL)
      AND public.normalize_word_key(w.text) = v_normalized
      AND coalesce(nullif(trim(coalesce(w.language, '')), ''), 'en') = v_language
  )
  INTO v_has_active;

  IF v_has_active THEN
    RETURN;
  END IF;

  -- --- Pronunciation asset cleanup (existing) ---
  INSERT INTO public.pronunciation_asset_storage_cleanup_jobs (
    storage_bucket, storage_path, status, attempt_count, last_error
  )
  SELECT DISTINCT
    coalesce(nullif(trim(coalesce(pa.storage_bucket, '')), ''), 'word-audio') AS storage_bucket,
    trim(pa.storage_path) AS storage_path,
    'pending' AS status,
    0 AS attempt_count,
    NULL AS last_error
  FROM public.pronunciation_assets pa
  WHERE pa.normalized_word = v_normalized
    AND coalesce(nullif(trim(coalesce(pa.language, '')), ''), 'en') = v_language
    AND coalesce(nullif(trim(coalesce(pa.storage_bucket, '')), ''), 'word-audio') = 'word-audio'
    AND nullif(trim(coalesce(pa.storage_path, '')), '') IS NOT NULL
  ON CONFLICT (storage_bucket, storage_path)
  DO UPDATE SET
    status = 'pending',
    last_error = NULL,
    updated_at = now();

  DELETE FROM public.pronunciation_assets pa
  WHERE pa.normalized_word = v_normalized
    AND coalesce(nullif(trim(coalesce(pa.language, '')), ''), 'en') = v_language;

  -- --- Image asset cleanup (NEW) ---
  INSERT INTO public.image_asset_storage_cleanup_jobs (
    storage_bucket, storage_path, status, attempt_count, last_error
  )
  SELECT DISTINCT
    coalesce(nullif(trim(coalesce(ia.storage_bucket, '')), ''), 'word-images') AS storage_bucket,
    trim(ia.storage_path) AS storage_path,
    'pending' AS status,
    0 AS attempt_count,
    NULL AS last_error
  FROM public.image_assets ia
  WHERE ia.normalized_word = v_normalized
    AND coalesce(nullif(trim(coalesce(ia.language, '')), ''), 'en') = v_language
    AND nullif(trim(coalesce(ia.storage_path, '')), '') IS NOT NULL
  ON CONFLICT (storage_bucket, storage_path)
  DO UPDATE SET
    status = 'pending',
    last_error = NULL,
    updated_at = now();

  DELETE FROM public.image_assets ia
  WHERE ia.normalized_word = v_normalized
    AND coalesce(nullif(trim(coalesce(ia.language, '')), ''), 'en') = v_language;

  -- --- Lexeme cleanup (existing) ---
  DELETE FROM public.lexeme_entries le
  WHERE le.normalized_text = v_normalized
    AND le.language = v_language;
END;
$$;

COMMIT;
