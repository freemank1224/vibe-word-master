BEGIN;

CREATE OR REPLACE FUNCTION public.run_daily_lexeme_meaning_scan(
  p_limit INTEGER DEFAULT 5000
)
RETURNS TABLE (
  requeued_count INTEGER,
  enqueued_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_requeued INTEGER := 0;
  v_enqueued INTEGER := 0;
BEGIN
  v_requeued := public.requeue_stale_lexeme_meaning_backfill_jobs(300);
  v_enqueued := public.enqueue_missing_lexeme_backfills(GREATEST(coalesce(p_limit, 5000), 1), false);

  RETURN QUERY SELECT v_requeued, v_enqueued;
END;
$$;

DO $$
DECLARE
  v_existing_job_id BIGINT;
BEGIN
  SELECT jobid INTO v_existing_job_id
  FROM cron.job
  WHERE jobname = 'daily-lexeme-meaning-scan';

  IF v_existing_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_existing_job_id);
  END IF;

  PERFORM cron.schedule(
    'daily-lexeme-meaning-scan',
    '10 17 * * *',
    $cron$select public.run_daily_lexeme_meaning_scan(5000);$cron$
  );
END;
$$;

COMMIT;
