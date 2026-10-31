DO $$
DECLARE
  first_token uuid;
  second_token uuid;
  next_allowed timestamptz;
BEGIN
  IF has_function_privilege('anon', 'public.try_acquire_lexeme_backfill_slot()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.release_lexeme_backfill_slot(uuid,integer)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.claim_lexeme_meaning_backfill_jobs(integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.claim_lexeme_backfill_with_slot(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.defer_rate_limited_lexeme_backfill(uuid,integer,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.finish_claimed_lexeme_backfill(uuid,integer,boolean,text,integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.try_acquire_lexeme_backfill_slot()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Rate gate RPC permissions are incorrect';
  END IF;

  first_token := public.try_acquire_lexeme_backfill_slot();
  IF first_token IS NULL THEN RAISE EXCEPTION 'First worker failed to acquire'; END IF;
  IF public.lexeme_backfill_can_dispatch() THEN RAISE EXCEPTION 'Cron dispatched during lease'; END IF;
  INSERT INTO public.lexeme_entries(id) VALUES
    ('00000000-0000-0000-0000-000000000021'),('00000000-0000-0000-0000-000000000022'),
    ('00000000-0000-0000-0000-000000000023'),('00000000-0000-0000-0000-000000000024');
  INSERT INTO public.lexeme_meaning_backfill_jobs(id,lexeme_id,normalized_text,display_text,language,status,attempts,priority) VALUES
    ('10000000-0000-0000-0000-000000000021','00000000-0000-0000-0000-000000000021',repeat('a',33),repeat('a',33),'en','pending',0,0),
    ('10000000-0000-0000-0000-000000000022','00000000-0000-0000-0000-000000000022','chien','chien','fr','pending',0,0),
    ('10000000-0000-0000-0000-000000000023','00000000-0000-0000-0000-000000000023','bank','bank','en','pending',0,0),
    ('10000000-0000-0000-0000-000000000024','00000000-0000-0000-0000-000000000024','ice cream','ice cream','en-US','pending',0,5);
  INSERT INTO public.lexeme_meanings VALUES ('00000000-0000-0000-0000-000000000023','银行');
  IF EXISTS (SELECT 1 FROM public.claim_lexeme_backfill_with_slot(gen_random_uuid())) THEN
    RAISE EXCEPTION 'Wrong token claimed a job';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.claim_lexeme_backfill_with_slot(first_token) WHERE normalized_text = 'ice cream') THEN
    RAISE EXCEPTION 'Eligible phrase was not claimed or an ineligible word was claimed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.claim_lexeme_backfill_with_slot(first_token)) THEN
    RAISE EXCEPTION 'One lease claimed more than one job';
  END IF;
  UPDATE public.lexeme_meaning_backfill_jobs SET status='done' WHERE id BETWEEN
    '10000000-0000-0000-0000-000000000021'::uuid AND '10000000-0000-0000-0000-000000000024'::uuid;
  IF public.try_acquire_lexeme_backfill_slot() IS NOT NULL THEN RAISE EXCEPTION 'Concurrent acquisition succeeded'; END IF;
  IF public.release_lexeme_backfill_slot(gen_random_uuid(), 0) THEN RAISE EXCEPTION 'Wrong owner released lease'; END IF;
  IF NOT public.release_lexeme_backfill_slot(first_token, 0) THEN RAISE EXCEPTION 'Owner did not release'; END IF;
  IF (SELECT next_allowed_at FROM public.lexeme_backfill_rate_gate WHERE singleton) < clock_timestamp() + interval '299 seconds' THEN
    RAISE EXCEPTION 'Release did not preserve five minutes after work completes';
  END IF;
  IF public.try_acquire_lexeme_backfill_slot() IS NOT NULL THEN RAISE EXCEPTION 'Five-minute pacing was bypassed'; END IF;

  UPDATE public.lexeme_backfill_rate_gate SET next_allowed_at = '-infinity' WHERE singleton;
  second_token := public.try_acquire_lexeme_backfill_slot();
  IF second_token IS NULL THEN RAISE EXCEPTION 'Second worker failed to acquire'; END IF;
  IF NOT public.release_lexeme_backfill_slot(second_token, 7200) THEN RAISE EXCEPTION 'Cooldown release failed'; END IF;
  SELECT next_allowed_at INTO next_allowed FROM public.lexeme_backfill_rate_gate WHERE singleton;
  IF next_allowed < clock_timestamp() + interval '119 minutes' THEN RAISE EXCEPTION 'Retry-After cooldown was lost'; END IF;
  IF public.try_acquire_lexeme_backfill_slot() IS NOT NULL THEN RAISE EXCEPTION 'Cooldown was bypassed'; END IF;

  PERFORM public.pause_lexeme_backfill_until(10800);
  SELECT next_allowed_at INTO next_allowed FROM public.lexeme_backfill_rate_gate WHERE singleton;
  IF next_allowed < clock_timestamp() + interval '179 minutes' THEN RAISE EXCEPTION 'Cron cooldown was lost'; END IF;
  PERFORM public.pause_lexeme_backfill_until(2147483647);
  IF (SELECT next_allowed_at FROM public.lexeme_backfill_rate_gate WHERE singleton) <> 'infinity'::timestamptz THEN
    RAISE EXCEPTION 'Unrepresentable cooldown did not fail closed';
  END IF;

  -- A rate-limited final allowed attempt must not become permanently failed.
  INSERT INTO public.lexeme_meaning_backfill_jobs(id, status, attempts) VALUES
    ('00000000-0000-0000-0000-000000000010', 'processing', 5);
  IF NOT public.defer_rate_limited_lexeme_backfill('00000000-0000-0000-0000-000000000010', 5, 7200) THEN
    RAISE EXCEPTION '429 retry deferral failed';
  END IF;
  IF (SELECT status FROM public.lexeme_meaning_backfill_jobs WHERE id='00000000-0000-0000-0000-000000000010') <> 'pending'
    OR (SELECT attempts FROM public.lexeme_meaning_backfill_jobs WHERE id='00000000-0000-0000-0000-000000000010') <> 4 THEN
    RAISE EXCEPTION '429 consumed a normal attempt';
  END IF;
  IF public.defer_rate_limited_lexeme_backfill('00000000-0000-0000-0000-000000000010', 5, 7200) THEN
    RAISE EXCEPTION 'Stale worker deferred the job twice';
  END IF;

  -- Simulate the words trigger marking a user-supplied meaning done while the
  -- worker is waiting on translation. Its stale completion must be a no-op.
  UPDATE public.lexeme_meaning_backfill_jobs SET status='done' WHERE id='00000000-0000-0000-0000-000000000010';
  IF public.finish_claimed_lexeme_backfill('00000000-0000-0000-0000-000000000010', 4, false, 'provider error', 600)
    OR public.defer_rate_limited_lexeme_backfill('00000000-0000-0000-0000-000000000010', 4, 3600)
    OR (SELECT status FROM public.lexeme_meaning_backfill_jobs WHERE id='00000000-0000-0000-0000-000000000010') <> 'done' THEN
    RAISE EXCEPTION 'Stale worker overwrote a user-completed job';
  END IF;

  INSERT INTO public.lexeme_meaning_backfill_jobs(id, lexeme_id, status, attempts, updated_at) VALUES
    ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000011','failed',5,now()-interval '2 days'),
    ('00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000012','failed',5,now()-interval '2 days');
  INSERT INTO public.lexeme_meanings VALUES
    ('00000000-0000-0000-0000-000000000011','sabertooth'),
    ('00000000-0000-0000-0000-000000000012','剑齿虎');
  PERFORM public.requeue_failed_lexeme_meaning_backfill_jobs(200, 1440);
  IF (SELECT status FROM public.lexeme_meaning_backfill_jobs WHERE id='00000000-0000-0000-0000-000000000011') <> 'pending'
    OR (SELECT status FROM public.lexeme_meaning_backfill_jobs WHERE id='00000000-0000-0000-0000-000000000012') <> 'failed'
    OR public.lexeme_backfill_can_dispatch() THEN
    RAISE EXCEPTION 'Daily requeue mishandled invalid/valid meanings or bypassed cooldown';
  END IF;
END;
$$;
