BEGIN;

ALTER TABLE public.pronunciation_rebuild_runs
  ADD COLUMN IF NOT EXISTS max_requests_per_minute INTEGER NOT NULL DEFAULT 20;

COMMIT;
