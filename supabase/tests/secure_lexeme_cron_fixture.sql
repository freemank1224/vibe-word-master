-- Isolated PostgreSQL fixture only. Never apply to a real project.
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigint GENERATED ALWAYS AS IDENTITY, jobname text UNIQUE, schedule text, command text);
CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3) RETURNING jobid
$$;
CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN DELETE FROM cron.job WHERE jobid=$1; RETURN FOUND; END; $$;
CREATE FUNCTION public.run_daily_lexeme_meaning_scan(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
CREATE FUNCTION public.complete_lexeme_meaning_backfill_job(uuid, boolean, text, integer) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
GRANT SELECT, INSERT, UPDATE ON public.words TO authenticated;
CREATE TRIGGER test_sync_word_meaning AFTER INSERT OR UPDATE OF definition_cn, lexeme_id ON public.words
FOR EACH ROW EXECUTE FUNCTION public.sync_word_meaning_after_write();
CREATE TRIGGER test_sync_missing AFTER INSERT OR UPDATE OF definition_cn, lexeme_id ON public.words
FOR EACH ROW EXECUTE FUNCTION public.sync_missing_lexeme_backfill_job();

-- Supabase image installs this extension as supabase_admin even though the
-- invoking postgres role is non-superuser; production uses the same model.
CREATE SCHEMA private_lexeme_http;
REVOKE ALL ON SCHEMA private_lexeme_http FROM PUBLIC, anon, authenticated, service_role;
CREATE EXTENSION http WITH SCHEMA private_lexeme_http;
CREATE TABLE public.test_http_requests (request private_lexeme_http.http_request);
SELECT vault.create_secret('test-only-public-gateway-jwt', 'lexeme_backfill_gateway_jwt');
SELECT vault.create_secret('test-only-worker-secret-abcdefghijklmnopqrstuvwxyz-0123456789', 'lexeme_backfill_worker_secret');
