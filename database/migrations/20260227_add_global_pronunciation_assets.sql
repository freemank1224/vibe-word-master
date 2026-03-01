-- ================================================================
-- Global Pronunciation Assets (Zero-downtime migration)
-- Date: 2026-02-27
-- Purpose:
--   1) Build a shared audio asset library across all users
--   2) Map per-user words to shared assets
--   3) Add async generation queue for TTS pipeline
--   4) Backfill legacy words.audio_url into shared assets
-- ================================================================

BEGIN;

-- 0) Normalization helper
CREATE OR REPLACE FUNCTION public.normalize_word_key(input_text TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT lower(regexp_replace(trim(coalesce(input_text, '')), '\s+', ' ', 'g'))
$$;

-- 1) Shared audio asset table
CREATE TABLE IF NOT EXISTS public.pronunciation_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_word TEXT NOT NULL,
  display_word TEXT NOT NULL,
  language VARCHAR(10) NOT NULL DEFAULT 'en',
  accent VARCHAR(16) NOT NULL DEFAULT 'en-US',
  voice TEXT NOT NULL DEFAULT 'default',
  model_provider TEXT NOT NULL DEFAULT 'unknown',
  model_name TEXT NOT NULL DEFAULT 'unknown',
  model_version TEXT NOT NULL DEFAULT 'v1',
  codec VARCHAR(16) NOT NULL DEFAULT 'opus',
  sample_rate_hz INTEGER NOT NULL DEFAULT 16000,
  bitrate_kbps INTEGER,
  duration_ms INTEGER,
  file_size_bytes BIGINT,
  storage_bucket TEXT NOT NULL DEFAULT 'word-audio',
  storage_path TEXT NOT NULL,
  public_url TEXT,
  sha256 TEXT,
  source_type TEXT NOT NULL DEFAULT 'tts',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed', 'disabled')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pronunciation_assets_variant_uniq UNIQUE (
    normalized_word, language, accent, voice, codec, sample_rate_hz, model_provider, model_name, model_version
  )
);

CREATE INDEX IF NOT EXISTS pronunciation_assets_status_idx
  ON public.pronunciation_assets(status);

CREATE INDEX IF NOT EXISTS pronunciation_assets_word_lang_idx
  ON public.pronunciation_assets(normalized_word, language);

CREATE INDEX IF NOT EXISTS pronunciation_assets_sha256_idx
  ON public.pronunciation_assets(sha256)
  WHERE sha256 IS NOT NULL;

-- 2) Async generation queue
CREATE TABLE IF NOT EXISTS public.pronunciation_generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES public.pronunciation_assets(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed', 'cancelled')),
  priority SMALLINT NOT NULL DEFAULT 5,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pronunciation_generation_jobs_asset_uniq UNIQUE (asset_id)
);

CREATE INDEX IF NOT EXISTS pronunciation_generation_jobs_pick_idx
  ON public.pronunciation_generation_jobs(status, priority, scheduled_at)
  WHERE status IN ('pending', 'processing');

-- 3) Add mapping column to words (user words -> global assets)
ALTER TABLE public.words
  ADD COLUMN IF NOT EXISTS pronunciation_asset_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'words_pronunciation_asset_id_fkey'
      AND conrelid = 'public.words'::regclass
  ) THEN
    ALTER TABLE public.words
      ADD CONSTRAINT words_pronunciation_asset_id_fkey
      FOREIGN KEY (pronunciation_asset_id)
      REFERENCES public.pronunciation_assets(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS words_pronunciation_asset_id_idx
  ON public.words(pronunciation_asset_id);

CREATE INDEX IF NOT EXISTS words_normalized_lookup_idx
  ON public.words (public.normalize_word_key(text), language)
  WHERE deleted = false OR deleted IS NULL;

-- 4) Backfill legacy audio_url into shared asset table
INSERT INTO public.pronunciation_assets (
  normalized_word,
  display_word,
  language,
  accent,
  voice,
  model_provider,
  model_name,
  model_version,
  codec,
  sample_rate_hz,
  storage_bucket,
  storage_path,
  public_url,
  source_type,
  status
)
SELECT DISTINCT
  public.normalize_word_key(w.text) AS normalized_word,
  trim(w.text) AS display_word,
  coalesce(nullif(trim(w.language), ''), 'en') AS language,
  'en-US' AS accent,
  'default' AS voice,
  'legacy' AS model_provider,
  'legacy' AS model_name,
  'v0' AS model_version,
  CASE
    WHEN lower(w.audio_url) LIKE '%.mp3%' THEN 'mp3'
    WHEN lower(w.audio_url) LIKE '%.ogg%' THEN 'ogg'
    WHEN lower(w.audio_url) LIKE '%.wav%' THEN 'wav'
    ELSE 'unknown'
  END AS codec,
  16000 AS sample_rate_hz,
  'legacy-external' AS storage_bucket,
  w.audio_url AS storage_path,
  w.audio_url AS public_url,
  'legacy' AS source_type,
  'ready' AS status
FROM public.words w
WHERE w.audio_url IS NOT NULL
  AND trim(w.audio_url) <> ''
  AND trim(w.text) <> ''
  AND (w.deleted = false OR w.deleted IS NULL)
ON CONFLICT (normalized_word, language, accent, voice, codec, sample_rate_hz, model_provider, model_name, model_version)
DO NOTHING;

-- 5) Backfill words -> pronunciation_assets mapping
UPDATE public.words w
SET pronunciation_asset_id = pa.id,
    updated_at = now()
FROM public.pronunciation_assets pa
WHERE w.pronunciation_asset_id IS NULL
  AND w.audio_url IS NOT NULL
  AND trim(w.audio_url) <> ''
  AND pa.public_url = w.audio_url
  AND pa.status = 'ready';

-- 6) Minimal auto-updated timestamp triggers for new tables
CREATE OR REPLACE FUNCTION public.set_row_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pronunciation_assets_updated_at ON public.pronunciation_assets;
CREATE TRIGGER trg_pronunciation_assets_updated_at
BEFORE UPDATE ON public.pronunciation_assets
FOR EACH ROW
EXECUTE FUNCTION public.set_row_updated_at();

DROP TRIGGER IF EXISTS trg_pronunciation_jobs_updated_at ON public.pronunciation_generation_jobs;
CREATE TRIGGER trg_pronunciation_jobs_updated_at
BEFORE UPDATE ON public.pronunciation_generation_jobs
FOR EACH ROW
EXECUTE FUNCTION public.set_row_updated_at();

-- 7) RLS policies
ALTER TABLE public.pronunciation_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pronunciation_generation_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pronunciation_assets_read_ready ON public.pronunciation_assets;
CREATE POLICY pronunciation_assets_read_ready
  ON public.pronunciation_assets
  FOR SELECT
  USING (status = 'ready');

DROP POLICY IF EXISTS pronunciation_assets_service_all ON public.pronunciation_assets;
CREATE POLICY pronunciation_assets_service_all
  ON public.pronunciation_assets
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS pronunciation_jobs_service_all ON public.pronunciation_generation_jobs;
CREATE POLICY pronunciation_jobs_service_all
  ON public.pronunciation_generation_jobs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMIT;
