BEGIN;

CREATE TABLE IF NOT EXISTS public.pronunciation_rebuild_runs (
  run_id UUID PRIMARY KEY,
  requested_by UUID,
  requested_email TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  generated INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  uniqueness_mode TEXT NOT NULL DEFAULT 'strict',
  concurrency INTEGER NOT NULL DEFAULT 3,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pronunciation_rebuild_runs_created_idx
  ON public.pronunciation_rebuild_runs(created_at DESC);

ALTER TABLE public.pronunciation_rebuild_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pronunciation_rebuild_runs_admin_select ON public.pronunciation_rebuild_runs;
CREATE POLICY pronunciation_rebuild_runs_admin_select
  ON public.pronunciation_rebuild_runs
  FOR SELECT
  USING (lower(coalesce(auth.jwt()->>'email','')) = 'dysonfreeman@outlook.com');

DROP POLICY IF EXISTS pronunciation_rebuild_runs_service_all ON public.pronunciation_rebuild_runs;
CREATE POLICY pronunciation_rebuild_runs_service_all
  ON public.pronunciation_rebuild_runs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMIT;
