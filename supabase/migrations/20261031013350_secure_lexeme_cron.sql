BEGIN;

-- A synchronous HTTP client avoids pg_net's publicly readable request queue.
-- No credential is placed in SQL text, a URL, a cron command or an HTTP table.
CREATE SCHEMA IF NOT EXISTS private_lexeme_http;
REVOKE ALL ON SCHEMA private_lexeme_http FROM PUBLIC, anon, authenticated, service_role;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='private_lexeme_http' AND pg_get_userbyid(nspowner)='postgres')
    OR has_schema_privilege('anon','private_lexeme_http','USAGE')
    OR has_schema_privilege('anon','private_lexeme_http','CREATE')
    OR has_schema_privilege('authenticated','private_lexeme_http','USAGE')
    OR has_schema_privilege('authenticated','private_lexeme_http','CREATE')
    OR has_schema_privilege('service_role','private_lexeme_http','USAGE')
    OR has_schema_privilege('service_role','private_lexeme_http','CREATE') THEN
    RAISE EXCEPTION 'The private HTTP schema is not protected';
  END IF;
END;
$$;
CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA private_lexeme_http;

-- Refuse to proceed if http was already installed somewhere public. Its
-- objects cannot be relocated, and guessing would weaken the security boundary.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
    WHERE e.extname='http' AND n.nspname='private_lexeme_http'
  ) THEN RAISE EXCEPTION 'The http extension must be installed in private_lexeme_http'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_lexeme_meaning_backfill_if_needed(
  p_batch_size integer DEFAULT 1,
  p_max_batches integer DEFAULT 1,
  p_enqueue_limit integer DEFAULT 0
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_gateway_jwt text;
  v_worker_secret text;
  v_response private_lexeme_http.http_response;
  v_header private_lexeme_http.http_header;
  v_requeued integer;
  -- Unknown Retry-After must stop the worker rather than guessing early.
  v_retry_seconds integer := 2147483647;
  v_retry_date timestamptz;
BEGIN
  -- The worker has the authoritative atomic gate; this avoids a gateway
  -- request entirely while a lease or a rate-limit cooldown is in effect.
  IF NOT public.lexeme_backfill_can_dispatch() THEN RETURN NULL; END IF;
  -- Stale jobs are updated in this transaction. Do not synchronously call the
  -- Edge worker while holding their row locks: it claims in another connection
  -- with SKIP LOCKED. A later tick runs after these updates have committed.
  v_requeued := public.requeue_stale_lexeme_meaning_backfill_jobs(300);
  IF v_requeued > 0 THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.lexeme_meaning_backfill_jobs j
    WHERE j.status='pending' AND j.scheduled_at <= clock_timestamp() AND j.attempts < j.max_attempts
      AND lower(coalesce(j.language, 'en')) ~ '^en(-[a-z]+)?$'
      AND char_length(btrim(coalesce(nullif(j.display_text,''),j.normalized_text,''))) BETWEEN 1 AND 32
      AND NOT EXISTS (SELECT 1 FROM public.lexeme_meanings lm
        WHERE lm.lexeme_id=j.lexeme_id AND public.is_valid_chinese_meaning(lm.meaning_zh))
  ) THEN RETURN NULL; END IF;

  SELECT decrypted_secret INTO v_gateway_jwt FROM vault.decrypted_secrets WHERE name='lexeme_backfill_gateway_jwt';
  SELECT decrypted_secret INTO v_worker_secret FROM vault.decrypted_secrets WHERE name='lexeme_backfill_worker_secret';
  IF coalesce(v_gateway_jwt, '') = '' OR length(coalesce(v_worker_secret, '')) < 32 THEN
    PERFORM public.pause_lexeme_backfill_until(3600);
    RAISE WARNING 'Lexeme backfill credentials are not configured';
    RETURN NULL;
  END IF;

  BEGIN
    -- Reset session options first: in particular, libcurl's default is not to
    -- follow redirects. Never allow credentials to follow a redirected request.
    PERFORM private_lexeme_http.http_reset_curlopt();
    IF NOT private_lexeme_http.http_set_curlopt('CURLOPT_TIMEOUT_MS', '15000')
      OR NOT private_lexeme_http.http_set_curlopt('CURLOPT_CONNECTTIMEOUT_MS', '3000') THEN
      RAISE EXCEPTION 'Unable to set safe request deadlines';
    END IF;
    SELECT * INTO v_response FROM private_lexeme_http.http((
      'POST',
      'https://mkdxdlsjisqazermmfoe.supabase.co/functions/v1/lexeme-meaning-backfill',
      ARRAY[
        private_lexeme_http.http_header('Authorization', 'Bearer ' || v_gateway_jwt),
        private_lexeme_http.http_header('x-admin-secret', v_worker_secret)
      ],
      'application/json',
      '{"action":"run_once"}'
    )::private_lexeme_http.http_request);
    PERFORM private_lexeme_http.http_reset_curlopt();
  EXCEPTION WHEN OTHERS THEN
    PERFORM private_lexeme_http.http_reset_curlopt();
    PERFORM public.pause_lexeme_backfill_until(900);
    -- Never log SQLERRM: an extension/network error might contain credentials.
    RAISE WARNING 'Lexeme backfill request failed; retry delayed';
    RETURN NULL;
  END;

  IF v_response.status = 429 THEN
    FOREACH v_header IN ARRAY coalesce(v_response.headers, ARRAY[]::private_lexeme_http.http_header[]) LOOP
      IF lower(v_header.field) = 'retry-after' THEN
        IF v_header.value ~ '^[0-9]{1,10}$' THEN
          v_retry_seconds := greatest(3600, least(v_header.value::numeric, 2147483647)::integer);
        ELSE
          BEGIN
            v_retry_date := v_header.value::timestamptz;
            v_retry_seconds := greatest(3600, least(ceil(extract(epoch FROM (v_retry_date - clock_timestamp()))), 2147483647)::integer);
          EXCEPTION WHEN OTHERS THEN
            v_retry_seconds := 2147483647;
          END;
        END IF;
      END IF;
    END LOOP;
    PERFORM public.pause_lexeme_backfill_until(v_retry_seconds);
  ELSIF v_response.status >= 500 OR v_response.status IS NULL THEN
    PERFORM public.pause_lexeme_backfill_until(900);
  ELSIF v_response.status < 200 OR v_response.status >= 300 THEN
    PERFORM public.pause_lexeme_backfill_until(3600);
  END IF;
  RETURN v_response.status;
END;
$$;

-- No untrusted caller can invoke the worker, obtain its credentials, alter
-- queue state, bypass its global gate, or induce concurrent provider calls.
REVOKE ALL ON FUNCTION public.trigger_lexeme_meaning_backfill_if_needed(integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_daily_lexeme_meaning_scan(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_lexeme_meaning_backfill(uuid, smallint, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_missing_lexeme_backfills(integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_lexeme_meaning_backfill_jobs(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.requeue_stale_lexeme_meaning_backfill_jobs(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_lexeme_meaning_backfill_job(uuid, boolean, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.requeue_failed_lexeme_meaning_backfill_jobs(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_lexeme_meaning_backfill(uuid, smallint, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_missing_lexeme_backfills(integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.requeue_stale_lexeme_meaning_backfill_jobs(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_lexeme_meaning_backfill_job(uuid, boolean, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.requeue_failed_lexeme_meaning_backfill_jobs(integer, integer) TO service_role;

DO $$
DECLARE v_job bigint;
BEGIN
  SELECT jobid INTO v_job FROM cron.job WHERE jobname='minutely-lexeme-meaning-consumer';
  IF v_job IS NOT NULL THEN PERFORM cron.unschedule(v_job); END IF;
  PERFORM cron.schedule('minutely-lexeme-meaning-consumer', '*/5 * * * *',
    $cron$select public.trigger_lexeme_meaning_backfill_if_needed(1, 1, 0);$cron$);
END;
$$;
COMMIT;
