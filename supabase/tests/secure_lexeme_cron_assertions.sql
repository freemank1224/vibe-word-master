-- Isolated fixture only; all values below are synthetic.
DO $$
DECLARE j cron.job; request_count integer; response bigint; hdr private_lexeme_http.http_header; saw_jwt boolean := false; saw_secret boolean := false;
BEGIN
  IF has_schema_privilege('anon','private_lexeme_http','USAGE') OR has_schema_privilege('authenticated','private_lexeme_http','USAGE') THEN
    RAISE EXCEPTION 'Private HTTP client is accessible to an untrusted role';
  END IF;
  IF has_function_privilege('anon','public.trigger_lexeme_meaning_backfill_if_needed(integer,integer,integer)','EXECUTE')
    OR has_function_privilege('authenticated','public.claim_lexeme_meaning_backfill_jobs(integer)','EXECUTE')
    OR has_function_privilege('anon','public.requeue_failed_lexeme_meaning_backfill_jobs(integer,integer)','EXECUTE')
    OR has_function_privilege('service_role','public.claim_lexeme_meaning_backfill_jobs(integer)','EXECUTE') THEN
    RAISE EXCEPTION 'Queue RPC privileges are wrong';
  END IF;
  SELECT * INTO j FROM cron.job WHERE jobname='minutely-lexeme-meaning-consumer';
  IF j.schedule <> '*/5 * * * *' OR j.command <> 'select public.trigger_lexeme_meaning_backfill_if_needed(1, 1, 0);' THEN
    RAISE EXCEPTION 'Cron cadence or parameters are wrong';
  END IF;

  -- A normal user inserting a manual Chinese meaning must not invoke the
  -- dictionary, and the existing trigger must finish that word's pending job.
  INSERT INTO public.lexeme_meaning_backfill_jobs (lexeme_id,normalized_text,display_text,language,status)
    VALUES ('00000000-0000-0000-0000-000000000003','newword','newword','en','pending');
  SET LOCAL ROLE authenticated;
  INSERT INTO public.words VALUES ('10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003', '新词');
  RESET ROLE;
  IF (SELECT definition_cn FROM public.words WHERE id='10000000-0000-0000-0000-000000000001') <> '新词'
    OR (SELECT status FROM public.lexeme_meaning_backfill_jobs WHERE normalized_text='newword') <> 'done'
    OR EXISTS (SELECT 1 FROM public.test_http_requests) THEN
    RAISE EXCEPTION 'Manual meaning was changed or generated an HTTP request';
  END IF;
  IF EXISTS (SELECT 1 FROM public.claim_lexeme_meaning_backfill_jobs(100) WHERE normalized_text='newword') THEN
    RAISE EXCEPTION 'Already completed manual meaning was claimed';
  END IF;
  -- Put just one old invalid-meaning job back in the eligible state.
  UPDATE public.lexeme_meaning_backfill_jobs SET status='pending', scheduled_at=now(), attempts=0 WHERE normalized_text='sabertooth';

  PERFORM set_config('test.http_status','200',true);
  response := public.trigger_lexeme_meaning_backfill_if_needed(100,50,5000);
  IF response <> 200 THEN RAISE EXCEPTION 'Successful worker did not return 200'; END IF;
  IF (SELECT count(*) FROM public.test_http_requests) <> 1 THEN RAISE EXCEPTION 'Expected one HTTP request'; END IF;
  IF (SELECT (request).content FROM public.test_http_requests LIMIT 1) <> '{"action":"run_once"}' THEN
    RAISE EXCEPTION 'Untrusted batch parameters affected the fixed worker request';
  END IF;
  FOR hdr IN SELECT h.* FROM public.test_http_requests CROSS JOIN LATERAL unnest((request).headers) AS h LOOP
    IF hdr.field='Authorization' AND hdr.value = 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='lexeme_backfill_gateway_jwt') THEN saw_jwt := true; END IF;
    IF hdr.field='x-admin-secret' AND hdr.value = (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='lexeme_backfill_worker_secret') THEN saw_secret := true; END IF;
  END LOOP;
  IF NOT saw_jwt OR NOT saw_secret THEN RAISE EXCEPTION 'Worker authorization was not provided'; END IF;

  PERFORM set_config('test.http_status','429',true);
  PERFORM set_config('test.retry_after','7200',true);
  response := public.trigger_lexeme_meaning_backfill_if_needed();
  IF response <> 429 OR (SELECT next_allowed_at FROM public.lexeme_backfill_rate_gate WHERE singleton) < clock_timestamp() + interval '7190 seconds' THEN
    RAISE EXCEPTION '429 retry interval was not persisted';
  END IF;
  SELECT count(*) INTO request_count FROM public.test_http_requests;
  IF public.trigger_lexeme_meaning_backfill_if_needed() IS NOT NULL OR (SELECT count(*) FROM public.test_http_requests) <> request_count THEN
    RAISE EXCEPTION 'Cooldown did not prevent another HTTP request';
  END IF;
  UPDATE public.lexeme_backfill_rate_gate SET next_allowed_at='-infinity';
  PERFORM set_config('test.retry_after','2147483647',true);
  PERFORM public.trigger_lexeme_meaning_backfill_if_needed();
  IF (SELECT next_allowed_at FROM public.lexeme_backfill_rate_gate WHERE singleton) <> 'infinity'::timestamptz THEN
    RAISE EXCEPTION 'Unbounded 429 delay did not fail closed';
  END IF;
  UPDATE public.lexeme_backfill_rate_gate SET next_allowed_at='-infinity';
  PERFORM set_config('test.retry_after','not-a-retry-date',true);
  PERFORM public.trigger_lexeme_meaning_backfill_if_needed();
  IF (SELECT next_allowed_at FROM public.lexeme_backfill_rate_gate WHERE singleton) <> 'infinity'::timestamptz THEN
    RAISE EXCEPTION 'Unparseable retry interval did not fail closed';
  END IF;
  UPDATE public.lexeme_backfill_rate_gate SET next_allowed_at='-infinity';
  PERFORM set_config('test.retry_after',to_char((clock_timestamp() + interval '3 hours') AT TIME ZONE 'UTC', 'Dy, DD Mon YYYY HH24:MI:SS') || ' GMT',true);
  PERFORM public.trigger_lexeme_meaning_backfill_if_needed();
  IF (SELECT next_allowed_at FROM public.lexeme_backfill_rate_gate WHERE singleton) < clock_timestamp() + interval '10790 seconds' THEN
    RAISE EXCEPTION 'HTTP-date Retry-After was not respected';
  END IF;
  UPDATE public.lexeme_backfill_rate_gate SET next_allowed_at='-infinity';
  PERFORM set_config('test.http_status','503',true);
  PERFORM public.trigger_lexeme_meaning_backfill_if_needed();
  IF (SELECT next_allowed_at FROM public.lexeme_backfill_rate_gate WHERE singleton) < clock_timestamp() + interval '890 seconds' THEN
    RAISE EXCEPTION '5xx backoff was not persisted';
  END IF;
  UPDATE public.lexeme_backfill_rate_gate SET next_allowed_at='-infinity';
  PERFORM set_config('test.http_status','599',true);
  PERFORM public.trigger_lexeme_meaning_backfill_if_needed();
  IF (SELECT next_allowed_at FROM public.lexeme_backfill_rate_gate WHERE singleton) < clock_timestamp() + interval '890 seconds' THEN
    RAISE EXCEPTION 'Transport error backoff was not persisted';
  END IF;
  -- Unsupported or unprocessable inputs must not trigger an empty worker run.
  UPDATE public.lexeme_backfill_rate_gate SET next_allowed_at='-infinity';
  UPDATE public.lexeme_meaning_backfill_jobs SET status='done';
  INSERT INTO public.lexeme_entries(id,normalized_text,display_text,language)
    VALUES ('00000000-0000-0000-0000-000000000099','longword','a very long input which exceeds the size limit','en');
  INSERT INTO public.lexeme_meaning_backfill_jobs(lexeme_id,normalized_text,display_text,language,status)
    VALUES ('00000000-0000-0000-0000-000000000099','longword','a very long input which exceeds the size limit','en','pending');
  SELECT count(*) INTO request_count FROM public.test_http_requests;
  IF public.trigger_lexeme_meaning_backfill_if_needed() IS NOT NULL OR (SELECT count(*) FROM public.test_http_requests) <> request_count THEN
    RAISE EXCEPTION 'Unprocessable job should not cause an HTTP request';
  END IF;
END;
$$;
