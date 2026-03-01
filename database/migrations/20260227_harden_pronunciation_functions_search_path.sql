-- ================================================================
-- Harden function search_path for pronunciation migration helpers
-- Date: 2026-02-27
-- ================================================================

BEGIN;

ALTER FUNCTION public.normalize_word_key(TEXT)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.set_row_updated_at()
  SET search_path = public, pg_temp;

COMMIT;
