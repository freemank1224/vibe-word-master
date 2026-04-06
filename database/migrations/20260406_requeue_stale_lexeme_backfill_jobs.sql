BEGIN;

CREATE OR REPLACE FUNCTION public.requeue_stale_lexeme_meaning_backfill_jobs(
  p_stale_after_seconds INTEGER DEFAULT 300
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  WITH updated AS (
    UPDATE public.lexeme_meaning_backfill_jobs j
    SET status = 'pending',
        scheduled_at = now(),
        last_error = coalesce(j.last_error, 'Requeued after stale processing lease expired'),
        updated_at = now()
    WHERE j.status = 'processing'
      AND coalesce(j.last_processed_at, j.updated_at, j.created_at)
          <= now() - make_interval(secs => GREATEST(coalesce(p_stale_after_seconds, 300), 30))
      AND j.attempts < j.max_attempts
      AND NOT EXISTS (
        SELECT 1
        FROM public.lexeme_meanings lm
        WHERE lm.lexeme_id = j.lexeme_id
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM updated;

  UPDATE public.lexeme_meaning_backfill_jobs j
  SET status = 'done',
      completed_at = now(),
      last_error = NULL,
      updated_at = now()
  WHERE j.status = 'processing'
    AND EXISTS (
      SELECT 1
      FROM public.lexeme_meanings lm
      WHERE lm.lexeme_id = j.lexeme_id
    );

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_lexeme_meaning_backfill_jobs(
  p_limit INTEGER DEFAULT 20
)
RETURNS TABLE (
  job_id UUID,
  lexeme_id UUID,
  normalized_text TEXT,
  display_text TEXT,
  language VARCHAR(10),
  phonetic TEXT,
  definition_en TEXT,
  attempts INTEGER,
  max_attempts INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.requeue_stale_lexeme_meaning_backfill_jobs(300);

  RETURN QUERY
  WITH picked AS (
    SELECT j.id
    FROM public.lexeme_meaning_backfill_jobs j
    WHERE j.status = 'pending'
      AND j.scheduled_at <= now()
      AND j.attempts < j.max_attempts
      AND NOT EXISTS (
        SELECT 1
        FROM public.lexeme_meanings lm
        WHERE lm.lexeme_id = j.lexeme_id
      )
    ORDER BY j.priority ASC, j.scheduled_at ASC, j.created_at ASC
    LIMIT GREATEST(coalesce(p_limit, 20), 1)
    FOR UPDATE OF j SKIP LOCKED
  ), updated AS (
    UPDATE public.lexeme_meaning_backfill_jobs j
    SET status = 'processing',
        attempts = j.attempts + 1,
        last_processed_at = now(),
        last_error = NULL,
        updated_at = now()
    FROM picked
    WHERE j.id = picked.id
    RETURNING j.*
  )
  SELECT
    u.id,
    u.lexeme_id,
    u.normalized_text,
    u.display_text,
    u.language,
    le.phonetic,
    le.definition_en,
    u.attempts,
    u.max_attempts
  FROM updated u
  JOIN public.lexeme_entries le ON le.id = u.lexeme_id;
END;
$$;

COMMIT;
