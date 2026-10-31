-- Installed by the isolated container's extension owner only; replaces the
-- HTTP implementation so tests never send requests or secrets over the network.
CREATE OR REPLACE FUNCTION private_lexeme_http.http(request private_lexeme_http.http_request)
RETURNS private_lexeme_http.http_response LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  result_status integer := coalesce(nullif(current_setting('test.http_status',true), ''), '200')::integer;
  retry_after text := coalesce(current_setting('test.retry_after',true), '');
  gate_token text;
  claimed_count integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity a, vault.decrypted_secrets s
    WHERE a.pid=pg_backend_pid()
      AND s.name IN ('lexeme_backfill_gateway_jwt','lexeme_backfill_worker_secret')
      AND position(s.decrypted_secret IN a.query) > 0
  ) THEN RAISE EXCEPTION 'Credentials appeared in the SQL activity text'; END IF;
  IF current_setting('test.simulate_edge_gate',true) = '1' THEN
    -- The mock Edge executes the real gate RPC through a separate database
    -- session. A cron-held row lock causes a statement timeout and fails test.
    SELECT token INTO gate_token FROM private_lexeme_http.dblink(
      'host=127.0.0.1 dbname=postgres user=postgres password=localtest options=-cstatement_timeout=3000',
      'select public.try_acquire_lexeme_backfill_slot()::text'
    ) AS result(token text);
    IF gate_token IS NULL THEN RAISE EXCEPTION 'Edge could not acquire gate'; END IF;
    SELECT claimed INTO claimed_count FROM private_lexeme_http.dblink(
      'host=127.0.0.1 dbname=postgres user=postgres password=localtest options=-cstatement_timeout=3000',
      format('select count(*)::integer from public.claim_lexeme_backfill_with_slot(%L::uuid)',gate_token)
    ) AS result(claimed integer);
    IF claimed_count IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Edge could not claim the expected job'; END IF;
    PERFORM * FROM private_lexeme_http.dblink(
      'host=127.0.0.1 dbname=postgres user=postgres password=localtest options=-cstatement_timeout=3000',
      format('select public.release_lexeme_backfill_slot(%L::uuid,0)',gate_token)
    ) AS result(released boolean);
  END IF;
  INSERT INTO public.test_http_requests VALUES (request);
  IF result_status = 599 THEN RAISE EXCEPTION 'Fake network error'; END IF;
  RETURN (result_status, 'application/json',
    ARRAY[private_lexeme_http.http_header('Retry-After', retry_after)], '{}')::private_lexeme_http.http_response;
END;
$$;
