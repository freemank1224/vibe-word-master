-- ================================================================
-- Reset legacy pronunciation resources and prepare full Minimax regeneration
-- Date: 2026-02-28
-- ================================================================

BEGIN;

-- 1) Ensure storage bucket exists for shared word audio
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'word-audio',
  'word-audio',
  true,
  5242880,
  ARRAY['audio/mpeg', 'audio/wav', 'audio/flac', 'application/octet-stream']
)
ON CONFLICT (id) DO NOTHING;

-- 2) Mark all non-minimax assets as disabled (keep history, no hard delete)
UPDATE public.pronunciation_assets
SET status = 'disabled',
    error_message = 'Deprecated legacy source; replaced by Minimax regeneration',
    updated_at = now()
WHERE model_provider <> 'minimax'
  AND status <> 'disabled';

-- 3) Clear word mappings that point to disabled/non-minimax assets
UPDATE public.words w
SET pronunciation_asset_id = NULL,
    audio_url = NULL,
    updated_at = now()
FROM public.pronunciation_assets pa
WHERE w.pronunciation_asset_id = pa.id
  AND pa.model_provider <> 'minimax';

-- 4) Also clear remaining direct audio_url to force unified new generation path
UPDATE public.words
SET audio_url = NULL,
    updated_at = now()
WHERE audio_url IS NOT NULL
  AND trim(audio_url) <> '';

COMMIT;
