BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.trigger_lexeme_meaning_backfill_if_needed(
  p_batch_size INTEGER DEFAULT 10,
  p_max_batches INTEGER DEFAULT 3,
  p_enqueue_limit INTEGER DEFAULT 1000
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_pending_count INTEGER := 0;
  v_request_id BIGINT;
BEGIN
  PERFORM public.requeue_stale_lexeme_meaning_backfill_jobs(300);

  SELECT count(*) INTO v_pending_count
  FROM public.lexeme_meaning_backfill_jobs j
  WHERE j.status = 'pending'
    AND j.scheduled_at <= now()
    AND j.attempts < j.max_attempts;

  IF v_pending_count <= 0 THEN
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url := 'https://mkdxdlsjisqazermmfoe.supabase.co/functions/v1/lexeme-meaning-backfill',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object(
      'action', 'run_once',
      'batchSize', GREATEST(coalesce(p_batch_size, 10), 1),
      'maxBatches', GREATEST(coalesce(p_max_batches, 3), 1),
      'enqueueLimit', GREATEST(coalesce(p_enqueue_limit, 1000), 1)
    )
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$$;

DO $$
DECLARE
  v_existing_job_id BIGINT;
BEGIN
  SELECT jobid INTO v_existing_job_id
  FROM cron.job
  WHERE jobname = 'minutely-lexeme-meaning-consumer';

  IF v_existing_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_existing_job_id);
  END IF;

  PERFORM cron.schedule(
    'minutely-lexeme-meaning-consumer',
    '* * * * *',
    $cron$select public.trigger_lexeme_meaning_backfill_if_needed(10, 3, 1000);$cron$
  );
END;
$$;

COMMIT;
