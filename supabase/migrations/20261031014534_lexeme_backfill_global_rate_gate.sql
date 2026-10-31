BEGIN;

-- A single persisted slot limits all worker instances together. The lease
-- fails closed if a worker cannot record its rate-limit state.
-- Normal completions release it early, but never bypass the five-minute
-- minimum between claims. An operator can inspect a stuck lease before retry.
CREATE TABLE IF NOT EXISTS public.lexeme_backfill_rate_gate (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  lease_token uuid,
  claim_used boolean NOT NULL DEFAULT false,
  lease_until timestamptz NOT NULL DEFAULT '-infinity',
  next_allowed_at timestamptz NOT NULL DEFAULT '-infinity'
);
ALTER TABLE public.lexeme_backfill_rate_gate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lexeme_backfill_rate_gate FROM PUBLIC, anon, authenticated, service_role;
INSERT INTO public.lexeme_backfill_rate_gate (singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

-- Advisory pre-check for cron only; the atomic UPDATE below remains the
-- authoritative gate if two workers race after seeing true here.
CREATE OR REPLACE FUNCTION public.lexeme_backfill_can_dispatch()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce((SELECT lease_until <= clock_timestamp() AND next_allowed_at <= clock_timestamp()
    FROM public.lexeme_backfill_rate_gate WHERE singleton = true), false);
$$;

CREATE OR REPLACE FUNCTION public.try_acquire_lexeme_backfill_slot()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_token uuid;
BEGIN
  UPDATE public.lexeme_backfill_rate_gate
  SET lease_token = gen_random_uuid(),
      claim_used = false,
      lease_until = 'infinity',
      next_allowed_at = v_now + interval '5 minutes'
  WHERE singleton = true AND lease_until <= v_now AND next_allowed_at <= v_now
  RETURNING lease_token INTO v_token;
  RETURN v_token;
END;
$$;

-- Only English words/phrases within the fixed provider text limit are eligible
-- for automatic backfill. Other entries remain available for manual meanings.
CREATE OR REPLACE FUNCTION public.claim_lexeme_meaning_backfill_jobs(p_limit integer DEFAULT 20)
RETURNS TABLE (job_id uuid, lexeme_id uuid, normalized_text text, display_text text,
  language varchar(10), phonetic text, definition_en text, attempts integer, max_attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.requeue_stale_lexeme_meaning_backfill_jobs(300);
  RETURN QUERY
  WITH picked AS (
    SELECT j.id FROM public.lexeme_meaning_backfill_jobs j
    WHERE j.status = 'pending' AND j.scheduled_at <= now() AND j.attempts < j.max_attempts
      AND lower(coalesce(j.language, 'en')) ~ '^en(-[a-z]+)?$'
      AND char_length(btrim(coalesce(nullif(j.display_text, ''), j.normalized_text, ''))) BETWEEN 1 AND 32
      AND NOT EXISTS (SELECT 1 FROM public.lexeme_meanings lm
        WHERE lm.lexeme_id = j.lexeme_id AND public.is_valid_chinese_meaning(lm.meaning_zh))
    ORDER BY j.priority ASC, j.scheduled_at ASC, j.created_at ASC
    LIMIT 1
    FOR UPDATE OF j SKIP LOCKED
  ), updated AS (
    UPDATE public.lexeme_meaning_backfill_jobs j
    SET status = 'processing', attempts = j.attempts + 1,
        last_processed_at = now(), last_error = NULL, updated_at = now()
    FROM picked WHERE j.id = picked.id RETURNING j.*
  )
  SELECT u.id, u.lexeme_id, u.normalized_text, u.display_text, u.language,
    le.phonetic, le.definition_en, u.attempts, u.max_attempts
  FROM updated u JOIN public.lexeme_entries le ON le.id = u.lexeme_id;
END;
$$;

-- A successful lease authorizes exactly one claim, even if the same token is
-- reused or a caller supplies large batch parameters.
CREATE OR REPLACE FUNCTION public.claim_lexeme_backfill_with_slot(p_token uuid)
RETURNS TABLE (job_id uuid, lexeme_id uuid, normalized_text text, display_text text,
  language varchar(10), phonetic text, definition_en text, attempts integer, max_attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.lexeme_backfill_rate_gate
  SET claim_used = true
  WHERE singleton = true AND lease_token = p_token AND lease_until > clock_timestamp() AND NOT claim_used;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY SELECT * FROM public.claim_lexeme_meaning_backfill_jobs(1);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_lexeme_backfill_slot(
  p_token uuid,
  p_cooldown_seconds integer DEFAULT 0
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_released boolean;
BEGIN
  UPDATE public.lexeme_backfill_rate_gate
  SET lease_token = NULL,
      lease_until = '-infinity',
      next_allowed_at = GREATEST(next_allowed_at,
        clock_timestamp() + make_interval(secs => GREATEST(coalesce(p_cooldown_seconds, 0), 300)))
  WHERE singleton = true AND lease_token = p_token
  RETURNING true INTO v_released;
  RETURN coalesce(v_released, false);
END;
$$;

-- The database cron can persist a gateway/REST 429 even when no worker got a
-- slot. Pausing never clears an in-flight or fail-closed lease.
CREATE OR REPLACE FUNCTION public.pause_lexeme_backfill_until(p_seconds integer)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.lexeme_backfill_rate_gate
  SET next_allowed_at = CASE WHEN p_seconds = 2147483647 THEN 'infinity'::timestamptz
    ELSE GREATEST(next_allowed_at,
      clock_timestamp() + make_interval(secs => GREATEST(coalesce(p_seconds, 3600), 0))) END
  WHERE singleton = true;
$$;

-- Rate-limited attempts are not translation failures. Preserve a concurrent
-- user completion (the UPDATE deliberately matches only processing jobs).
CREATE OR REPLACE FUNCTION public.defer_rate_limited_lexeme_backfill(
  p_job_id uuid,
  p_expected_attempt integer,
  p_retry_delay_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_deferred boolean;
BEGIN
  UPDATE public.lexeme_meaning_backfill_jobs
  SET status = 'pending',
      attempts = GREATEST(attempts - 1, 0),
      scheduled_at = clock_timestamp() + make_interval(secs => GREATEST(coalesce(p_retry_delay_seconds, 3600), 3600)),
      completed_at = NULL,
      last_error = 'Translation or database service rate limited',
      updated_at = clock_timestamp()
  WHERE id = p_job_id AND status = 'processing' AND attempts = p_expected_attempt
  RETURNING true INTO v_deferred;
  RETURN coalesce(v_deferred, false);
END;
$$;

-- A user can add their own meaning during an external request. The existing
-- words trigger marks the job done; a stale worker must never undo that.
CREATE OR REPLACE FUNCTION public.finish_claimed_lexeme_backfill(
  p_job_id uuid,
  p_expected_attempt integer,
  p_success boolean,
  p_error text DEFAULT NULL,
  p_retry_delay_seconds integer DEFAULT 600
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_finished boolean;
BEGIN
  UPDATE public.lexeme_meaning_backfill_jobs
  SET status = CASE WHEN p_success THEN 'done' WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
      completed_at = CASE WHEN p_success THEN clock_timestamp() ELSE NULL END,
      scheduled_at = CASE WHEN NOT p_success AND attempts < max_attempts
        THEN clock_timestamp() + make_interval(secs => GREATEST(coalesce(p_retry_delay_seconds, 600), 30))
        ELSE scheduled_at END,
      last_error = CASE WHEN p_success THEN NULL ELSE left(coalesce(p_error, 'Unknown backfill error'), 2000) END,
      updated_at = clock_timestamp()
  WHERE id = p_job_id AND status = 'processing' AND attempts = p_expected_attempt
  RETURNING true INTO v_finished;
  RETURN coalesce(v_finished, false);
END;
$$;

-- A historical English echo is not a completed Chinese meaning. Requeueing
-- only changes job state; it never resets or bypasses the global rate gate.
CREATE OR REPLACE FUNCTION public.requeue_failed_lexeme_meaning_backfill_jobs(
  p_limit integer DEFAULT 200,
  p_cooldown_minutes integer DEFAULT 1440
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH candidate AS (
    SELECT j.id FROM public.lexeme_meaning_backfill_jobs j
    WHERE j.status = 'failed'
      AND NOT EXISTS (SELECT 1 FROM public.lexeme_meanings lm
        WHERE lm.lexeme_id = j.lexeme_id AND public.is_valid_chinese_meaning(lm.meaning_zh))
      AND coalesce(j.last_processed_at, j.updated_at, j.created_at)
        <= now() - make_interval(mins => GREATEST(coalesce(p_cooldown_minutes, 1440), 30))
    ORDER BY j.priority ASC, j.updated_at ASC
    LIMIT GREATEST(coalesce(p_limit, 200), 1)
    FOR UPDATE OF j SKIP LOCKED
  ), updated AS (
    UPDATE public.lexeme_meaning_backfill_jobs j
    SET status = 'pending', attempts = 0, scheduled_at = now(), completed_at = NULL,
        last_error = coalesce(j.last_error, 'Requeued from daily failed-only scan'), updated_at = now()
    FROM candidate WHERE j.id = candidate.id RETURNING 1
  ) SELECT count(*) INTO v_count FROM updated;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.try_acquire_lexeme_backfill_slot() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lexeme_backfill_can_dispatch() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_lexeme_meaning_backfill_jobs(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_lexeme_backfill_with_slot(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_lexeme_backfill_slot(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pause_lexeme_backfill_until(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.defer_rate_limited_lexeme_backfill(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_claimed_lexeme_backfill(uuid, integer, boolean, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.requeue_failed_lexeme_meaning_backfill_jobs(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_acquire_lexeme_backfill_slot() TO service_role;
GRANT EXECUTE ON FUNCTION public.lexeme_backfill_can_dispatch() TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_lexeme_backfill_with_slot(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_lexeme_backfill_slot(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.pause_lexeme_backfill_until(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.defer_rate_limited_lexeme_backfill(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_claimed_lexeme_backfill(uuid, integer, boolean, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.requeue_failed_lexeme_meaning_backfill_jobs(integer, integer) TO service_role;
COMMIT;
