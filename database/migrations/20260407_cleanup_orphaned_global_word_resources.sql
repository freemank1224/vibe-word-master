-- ================================================================
-- Cleanup orphaned global word resources
-- Date: 2026-04-07
-- Purpose:
--   1) When the last active user word for a lexeme disappears, remove the
--      shared Chinese meaning library entry.
--   2) When the last active user word for a pronunciation disappears, remove
--      the shared pronunciation asset row.
--   3) Queue physical storage cleanup for deleted audio files.
--   4) Backfill cleanup for already orphaned global resources.
-- ================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.pronunciation_asset_storage_cleanup_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_bucket TEXT NOT NULL DEFAULT 'word-audio',
  storage_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pronunciation_asset_storage_cleanup_jobs_bucket_path_uniq
    UNIQUE (storage_bucket, storage_path)
);

CREATE INDEX IF NOT EXISTS pronunciation_asset_storage_cleanup_jobs_status_idx
  ON public.pronunciation_asset_storage_cleanup_jobs(status, created_at);

DROP TRIGGER IF EXISTS trg_pronunciation_asset_storage_cleanup_jobs_updated_at
  ON public.pronunciation_asset_storage_cleanup_jobs;
CREATE TRIGGER trg_pronunciation_asset_storage_cleanup_jobs_updated_at
BEFORE UPDATE ON public.pronunciation_asset_storage_cleanup_jobs
FOR EACH ROW
EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.pronunciation_asset_storage_cleanup_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pronunciation_asset_storage_cleanup_jobs_service_all
  ON public.pronunciation_asset_storage_cleanup_jobs;
CREATE POLICY pronunciation_asset_storage_cleanup_jobs_service_all
  ON public.pronunciation_asset_storage_cleanup_jobs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION public.enqueue_pronunciation_asset_storage_cleanup(
  p_storage_bucket TEXT,
  p_storage_path TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bucket TEXT := coalesce(nullif(trim(coalesce(p_storage_bucket, '')), ''), 'word-audio');
  v_path TEXT := nullif(trim(coalesce(p_storage_path, '')), '');
BEGIN
  IF v_path IS NULL THEN
    RETURN;
  END IF;

  IF v_bucket <> 'word-audio' THEN
    RETURN;
  END IF;

  INSERT INTO public.pronunciation_asset_storage_cleanup_jobs (
    storage_bucket,
    storage_path,
    status,
    attempt_count,
    last_error
  )
  VALUES (
    v_bucket,
    v_path,
    'pending',
    0,
    NULL
  )
  ON CONFLICT (storage_bucket, storage_path)
  DO UPDATE SET
    status = 'pending',
    last_error = NULL,
    updated_at = now();
END;
$$;

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

  INSERT INTO public.pronunciation_asset_storage_cleanup_jobs (
    storage_bucket,
    storage_path,
    status,
    attempt_count,
    last_error
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

  DELETE FROM public.lexeme_entries le
  WHERE le.normalized_text = v_normalized
    AND le.language = v_language;
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_global_word_resources_after_words_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_normalized TEXT;
  v_old_language VARCHAR(10);
  v_new_normalized TEXT;
  v_new_language VARCHAR(10);
  v_old_active BOOLEAN := false;
  v_new_active BOOLEAN := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old_normalized := nullif(public.normalize_word_key(OLD.text), '');
    v_old_language := coalesce(nullif(trim(coalesce(OLD.language, '')), ''), 'en');

    PERFORM public.cleanup_global_word_resources_for_key(v_old_normalized, v_old_language);
    RETURN OLD;
  END IF;

  v_old_normalized := nullif(public.normalize_word_key(OLD.text), '');
  v_old_language := coalesce(nullif(trim(coalesce(OLD.language, '')), ''), 'en');
  v_new_normalized := nullif(public.normalize_word_key(NEW.text), '');
  v_new_language := coalesce(nullif(trim(coalesce(NEW.language, '')), ''), 'en');
  v_old_active := (OLD.deleted = false OR OLD.deleted IS NULL);
  v_new_active := (NEW.deleted = false OR NEW.deleted IS NULL);

  IF v_old_active AND (NOT v_new_active) THEN
    PERFORM public.cleanup_global_word_resources_for_key(v_old_normalized, v_old_language);
    RETURN NEW;
  END IF;

  IF v_old_active
     AND v_new_active
     AND (
       v_old_normalized IS DISTINCT FROM v_new_normalized
       OR v_old_language IS DISTINCT FROM v_new_language
     ) THEN
    PERFORM public.cleanup_global_word_resources_for_key(v_old_normalized, v_old_language);
    RETURN NEW;
  END IF;

  PERFORM public.cleanup_global_word_resources_for_key(v_old_normalized, v_old_language);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_words_cleanup_global_resources_after_update ON public.words;
CREATE TRIGGER trg_words_cleanup_global_resources_after_update
AFTER UPDATE OF deleted, text, language ON public.words
FOR EACH ROW
EXECUTE FUNCTION public.cleanup_global_word_resources_after_words_write();

DROP TRIGGER IF EXISTS trg_words_cleanup_global_resources_after_delete ON public.words;
CREATE TRIGGER trg_words_cleanup_global_resources_after_delete
AFTER DELETE ON public.words
FOR EACH ROW
EXECUTE FUNCTION public.cleanup_global_word_resources_after_words_write();

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT k.normalized_text, k.language
    FROM (
      SELECT le.normalized_text, le.language
      FROM public.lexeme_entries le
      UNION
      SELECT pa.normalized_word AS normalized_text,
             coalesce(nullif(trim(coalesce(pa.language, '')), ''), 'en') AS language
      FROM public.pronunciation_assets pa
    ) k
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.words w
      WHERE (w.deleted = false OR w.deleted IS NULL)
        AND public.normalize_word_key(w.text) = k.normalized_text
        AND coalesce(nullif(trim(coalesce(w.language, '')), ''), 'en') = k.language
    )
  LOOP
    PERFORM public.cleanup_global_word_resources_for_key(r.normalized_text, r.language);
  END LOOP;
END;
$$;

COMMIT;
