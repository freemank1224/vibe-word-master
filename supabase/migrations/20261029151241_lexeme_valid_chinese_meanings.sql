BEGIN;

-- Keep placeholder and untranslated source words out of Chinese meaning paths.
CREATE OR REPLACE FUNCTION public.is_valid_chinese_meaning(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT COALESCE(
    btrim(value) <> ''
    AND lower(btrim(value)) NOT IN ('暂无中文释义', '无中文释义', '暂无释义', 'n/a', 'na', '-')
    AND value COLLATE "C" ~ '[⺀-⺙⺛-⻳⼀-⿕々〇〡-〩〸-〻㐀-䶿一-鿿豈-舘並-龎𖿢-𖿣𖿰-𖿱𠀀-𪛟𪜀-𫜹𫝀-𫠝𫠠-𬺡𬺰-𮯠𮯰-𮹝丽-𪘀𰀀-𱍊𱍐-𲎯]',
    false
  );
$$;

CREATE OR REPLACE FUNCTION public.sync_word_meaning_after_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
	v_meaning TEXT;
	v_meaning_id UUID;
BEGIN
	v_meaning := nullif(btrim(coalesce(NEW.definition_cn, '')), '');

	IF NEW.lexeme_id IS NULL OR NOT public.is_valid_chinese_meaning(v_meaning) THEN
		RETURN NEW;
	END IF;

	INSERT INTO public.lexeme_meanings (
		lexeme_id,
		meaning_zh,
		source_type,
		source_provider,
		confidence,
		created_by_user_id
	)
	VALUES (
		NEW.lexeme_id,
		v_meaning,
		'user_word',
		'words_trigger',
		0.7000,
		NEW.user_id
	)
	ON CONFLICT (lexeme_id, meaning_zh)
	DO UPDATE SET
		updated_at = now()
	RETURNING id INTO v_meaning_id;

	UPDATE public.user_word_meaning_preferences
	SET is_primary = false,
			updated_at = now()
	WHERE word_id = NEW.id
		AND is_primary = true
		AND lexeme_meaning_id <> v_meaning_id;

	INSERT INTO public.user_word_meaning_preferences (
		user_id,
		word_id,
		lexeme_meaning_id,
		is_primary
	)
	VALUES (
		NEW.user_id,
		NEW.id,
		v_meaning_id,
		true
	)
	ON CONFLICT (word_id, lexeme_meaning_id)
	DO UPDATE SET
		is_primary = true,
		user_id = EXCLUDED.user_id,
		updated_at = now();

	RETURN NEW;
END;
$$;

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
    SELECT 1 FROM public.lexeme_meanings lm WHERE lm.lexeme_id = p_lexeme_id AND public.is_valid_chinese_meaning(lm.meaning_zh)
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
      WHEN EXISTS (SELECT 1 FROM public.lexeme_meanings lm WHERE lm.lexeme_id = EXCLUDED.lexeme_id AND public.is_valid_chinese_meaning(lm.meaning_zh))
        THEN 'done'
      ELSE 'pending'
    END,
    scheduled_at = CASE
      WHEN p_force THEN now()
      WHEN EXISTS (SELECT 1 FROM public.lexeme_meanings lm WHERE lm.lexeme_id = EXCLUDED.lexeme_id AND public.is_valid_chinese_meaning(lm.meaning_zh))
        THEN public.lexeme_meaning_backfill_jobs.scheduled_at
      ELSE now()
    END,
    completed_at = CASE
      WHEN p_force THEN NULL
      WHEN EXISTS (SELECT 1 FROM public.lexeme_meanings lm WHERE lm.lexeme_id = EXCLUDED.lexeme_id AND public.is_valid_chinese_meaning(lm.meaning_zh))
        THEN public.lexeme_meaning_backfill_jobs.completed_at
      ELSE NULL
    END,
    last_error = CASE
      WHEN p_force THEN NULL
      WHEN EXISTS (SELECT 1 FROM public.lexeme_meanings lm WHERE lm.lexeme_id = EXCLUDED.lexeme_id AND public.is_valid_chinese_meaning(lm.meaning_zh))
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
      ON lm.lexeme_id = le.id AND public.is_valid_chinese_meaning(lm.meaning_zh)
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
        WHERE lm.lexeme_id = j.lexeme_id AND public.is_valid_chinese_meaning(lm.meaning_zh)
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
      WHERE lm.lexeme_id = j.lexeme_id AND public.is_valid_chinese_meaning(lm.meaning_zh)
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
        WHERE lm.lexeme_id = j.lexeme_id AND public.is_valid_chinese_meaning(lm.meaning_zh)
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

  IF public.is_valid_chinese_meaning(NEW.definition_cn) THEN
    UPDATE public.lexeme_meaning_backfill_jobs
    SET status = 'done',
        completed_at = now(),
        last_error = NULL,
        updated_at = now()
    WHERE lexeme_id = NEW.lexeme_id;

    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.lexeme_meanings lm WHERE lm.lexeme_id = NEW.lexeme_id AND public.is_valid_chinese_meaning(lm.meaning_zh)
  ) THEN
    PERFORM public.enqueue_lexeme_meaning_backfill(NEW.lexeme_id, 5::smallint, false);
  END IF;

  RETURN NEW;
END;
$$;

-- Re-open completed jobs which have only bad historical options; do not
-- remove or rewrite old meanings, user selections, or other records.
UPDATE public.lexeme_meaning_backfill_jobs j
SET status = 'pending', attempts = 0, scheduled_at = now(), completed_at = NULL,
    last_error = NULL, updated_at = now()
WHERE j.status = 'done'
  AND EXISTS (SELECT 1 FROM public.lexeme_meanings lm WHERE lm.lexeme_id = j.lexeme_id)
  AND NOT EXISTS (SELECT 1 FROM public.lexeme_meanings lm WHERE lm.lexeme_id = j.lexeme_id
                  AND public.is_valid_chinese_meaning(lm.meaning_zh));

COMMIT;
