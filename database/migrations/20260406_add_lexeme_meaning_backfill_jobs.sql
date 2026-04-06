-- ================================================================
-- Lexeme Meaning Backfill Jobs
-- Date: 2026-04-06
-- Purpose:
--   1) Maintain a backend queue for missing Chinese meanings
--   2) Enqueue missing lexemes incrementally via DB triggers
--   3) Support background processors and one-off repair runs
-- ================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.lexeme_meaning_backfill_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lexeme_id UUID NOT NULL REFERENCES public.lexeme_entries(id) ON DELETE CASCADE,
  normalized_text TEXT NOT NULL,
  display_text TEXT NOT NULL,
  language VARCHAR(10) NOT NULL DEFAULT 'en',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed', 'cancelled')),
  priority SMALLINT NOT NULL DEFAULT 5,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_processed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lexeme_meaning_backfill_jobs_lexeme_uniq UNIQUE (lexeme_id)
);

CREATE INDEX IF NOT EXISTS lexeme_meaning_backfill_jobs_pick_idx
  ON public.lexeme_meaning_backfill_jobs(status, priority, scheduled_at, created_at)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS lexeme_meaning_backfill_jobs_lexeme_idx
  ON public.lexeme_meaning_backfill_jobs(lexeme_id);

DROP TRIGGER IF EXISTS trg_lexeme_meaning_backfill_jobs_updated_at ON public.lexeme_meaning_backfill_jobs;
CREATE TRIGGER trg_lexeme_meaning_backfill_jobs_updated_at
BEFORE UPDATE ON public.lexeme_meaning_backfill_jobs
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE OR REPLACE FUNCTION public.enqueue_lexeme_meaning_backfill(
  p_lexeme_id UUID,
  p_priority SMALLINT DEFAULT 5,
  p_force BOOLEAN DEFAULT false
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry RECORD;
  v_job_id UUID;
BEGIN
  IF p_lexeme_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT id, normalized_text, display_text, language
  INTO v_entry
  FROM public.lexeme_entries
  WHERE id = p_lexeme_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT p_force AND EXISTS (
    SELECT 1 FROM public.lexeme_meanings lm WHERE lm.lexeme_id = p_lexeme_id
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.lexeme_meaning_backfill_jobs (
    lexeme_id,
    normalized_text,
    display_text,
    language,
    status,
    priority,
    scheduled_at,
    completed_at,
    last_error
  )
  VALUES (
    v_entry.id,
    v_entry.normalized_text,
    v_entry.display_text,
    v_entry.language,
    'pending',
    coalesce(p_priority, 5),
    now(),
    NULL,
    NULL
  )
  ON CONFLICT (lexeme_id)
  DO UPDATE SET
    normalized_text = EXCLUDED.normalized_text,
    display_text = EXCLUDED.display_text,
    language = EXCLUDED.language,
    priority = LEAST(public.lexeme_meaning_backfill_jobs.priority, EXCLUDED.priority),
    status = CASE
      WHEN p_force THEN 'pending'
      WHEN public.lexeme_meaning_backfill_jobs.status = 'processing' THEN public.lexeme_meaning_backfill_jobs.status
      WHEN EXISTS (SELECT 1 FROM public.lexeme_meanings lm WHERE lm.lexeme_id = EXCLUDED.lexeme_id)
        THEN 'done'
      ELSE 'pending'
    END,
    scheduled_at = CASE
      WHEN p_force THEN now()
      WHEN EXISTS (SELECT 1 FROM public.lexeme_meanings lm WHERE lm.lexeme_id = EXCLUDED.lexeme_id)
        THEN public.lexeme_meaning_backfill_jobs.scheduled_at
      ELSE now()
    END,
    completed_at = CASE
      WHEN p_force THEN NULL
      WHEN EXISTS (SELECT 1 FROM public.lexeme_meanings lm WHERE lm.lexeme_id = EXCLUDED.lexeme_id)
        THEN public.lexeme_meaning_backfill_jobs.completed_at
      ELSE NULL
    END,
    last_error = CASE
      WHEN p_force THEN NULL
      WHEN EXISTS (SELECT 1 FROM public.lexeme_meanings lm WHERE lm.lexeme_id = EXCLUDED.lexeme_id)
        THEN public.lexeme_meaning_backfill_jobs.last_error
      ELSE NULL
    END,
    updated_at = now()
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_missing_lexeme_backfills(
  p_limit INTEGER DEFAULT 1000,
  p_force BOOLEAN DEFAULT false
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER := 0;
  v_row RECORD;
BEGIN
  FOR v_row IN
    SELECT le.id
    FROM public.lexeme_entries le
    LEFT JOIN public.lexeme_meanings lm
      ON lm.lexeme_id = le.id
    WHERE lm.id IS NULL
    ORDER BY le.created_at ASC, le.display_text ASC
    LIMIT GREATEST(coalesce(p_limit, 1000), 1)
  LOOP
    PERFORM public.enqueue_lexeme_meaning_backfill(v_row.id, 5::smallint, p_force);
    v_count := v_count + 1;
  END LOOP;

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
  RETURN QUERY
  WITH picked AS (
    SELECT j.id
    FROM public.lexeme_meaning_backfill_jobs j
    LEFT JOIN public.lexeme_meanings lm
      ON lm.lexeme_id = j.lexeme_id
    WHERE j.status = 'pending'
      AND j.scheduled_at <= now()
      AND j.attempts < j.max_attempts
      AND lm.id IS NULL
    ORDER BY j.priority ASC, j.scheduled_at ASC, j.created_at ASC
    LIMIT GREATEST(coalesce(p_limit, 20), 1)
    FOR UPDATE SKIP LOCKED
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

CREATE OR REPLACE FUNCTION public.complete_lexeme_meaning_backfill_job(
  p_job_id UUID,
  p_success BOOLEAN,
  p_error TEXT DEFAULT NULL,
  p_retry_delay_seconds INTEGER DEFAULT 300
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.lexeme_meaning_backfill_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job
  FROM public.lexeme_meaning_backfill_jobs
  WHERE id = p_job_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_success THEN
    UPDATE public.lexeme_meaning_backfill_jobs
    SET status = 'done',
        completed_at = now(),
        last_error = NULL,
        updated_at = now()
    WHERE id = p_job_id;
    RETURN;
  END IF;

  IF v_job.attempts >= v_job.max_attempts THEN
    UPDATE public.lexeme_meaning_backfill_jobs
    SET status = 'failed',
        completed_at = NULL,
        last_error = left(coalesce(p_error, 'Unknown backfill error'), 2000),
        updated_at = now()
    WHERE id = p_job_id;
  ELSE
    UPDATE public.lexeme_meaning_backfill_jobs
    SET status = 'pending',
        scheduled_at = now() + make_interval(secs => GREATEST(coalesce(p_retry_delay_seconds, 300), 30)),
        completed_at = NULL,
        last_error = left(coalesce(p_error, 'Unknown backfill error'), 2000),
        updated_at = now()
    WHERE id = p_job_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_missing_lexeme_backfill_job()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.lexeme_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF nullif(btrim(coalesce(NEW.definition_cn, '')), '') IS NOT NULL THEN
    UPDATE public.lexeme_meaning_backfill_jobs
    SET status = 'done',
        completed_at = now(),
        last_error = NULL,
        updated_at = now()
    WHERE lexeme_id = NEW.lexeme_id;

    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.lexeme_meanings lm WHERE lm.lexeme_id = NEW.lexeme_id
  ) THEN
    PERFORM public.enqueue_lexeme_meaning_backfill(NEW.lexeme_id, 5::smallint, false);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_words_sync_missing_lexeme_backfill_job ON public.words;
CREATE TRIGGER trg_words_sync_missing_lexeme_backfill_job
AFTER INSERT OR UPDATE OF lexeme_id, definition_cn
ON public.words
FOR EACH ROW
EXECUTE FUNCTION public.sync_missing_lexeme_backfill_job();

ALTER TABLE public.lexeme_meaning_backfill_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lexeme_meaning_backfill_jobs_service_all ON public.lexeme_meaning_backfill_jobs;
CREATE POLICY lexeme_meaning_backfill_jobs_service_all
  ON public.lexeme_meaning_backfill_jobs
  FOR ALL
  TO service_role
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

SELECT public.enqueue_missing_lexeme_backfills(100000, false);

COMMIT;
