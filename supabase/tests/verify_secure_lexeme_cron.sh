#!/usr/bin/env bash
# Runs only against an isolated throwaway PostgreSQL container with fake secrets.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
container="vibe-secure-lexeme-cron-$$"
cleanup() { docker stop "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=localtest \
  public.ecr.aws/supabase/postgres:17.6.1.167 >/dev/null
for _ in {1..60}; do
  [[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" == 'healthy' ]] && break
  sleep 1
done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" == 'healthy' ]]
cat "$repo_dir/supabase/tests/lexeme_meaning_queue_fixture.sql" \
    "$repo_dir/supabase/migrations/20261029160848_lexeme_valid_chinese_meanings.sql" \
    "$repo_dir/supabase/migrations/20261031013028_lexeme_backfill_global_rate_gate.sql" \
    "$repo_dir/supabase/tests/secure_lexeme_cron_fixture.sql" \
  | docker exec -i "$container" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres
# This test-only stub is installed as the extension object owner; no HTTP leaves
# the container, and it uses exclusively fake test values.
docker exec -i "$container" psql -q -v ON_ERROR_STOP=1 -U supabase_admin -d postgres <<'SQL'
CREATE EXTENSION dblink WITH SCHEMA private_lexeme_http;
SQL
docker exec -i "$container" psql -q -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
  < "$repo_dir/supabase/tests/secure_lexeme_http_stub.sql"
cat "$repo_dir/supabase/migrations/20261031013350_secure_lexeme_cron.sql" \
    "$repo_dir/supabase/tests/secure_lexeme_cron_assertions.sql" \
  | docker exec -i "$container" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres
docker exec -i "$container" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
UPDATE public.lexeme_backfill_rate_gate SET lease_token=NULL, lease_until='-infinity',next_allowed_at='-infinity';
UPDATE public.lexeme_meaning_backfill_jobs SET status='processing',last_processed_at=now()-interval '10 minutes',attempts=1 WHERE normalized_text='sabertooth';
SELECT set_config('test.simulate_edge_gate','1',false);
UPDATE public.lexeme_backfill_rate_gate SET next_allowed_at=now()+interval '1 hour';
DO $$ DECLARE result bigint; job_status text; BEGIN
  result := public.trigger_lexeme_meaning_backfill_if_needed();
  SELECT status INTO job_status FROM public.lexeme_meaning_backfill_jobs WHERE normalized_text='sabertooth';
  IF result IS NOT NULL OR job_status <> 'processing' THEN
    RAISE EXCEPTION 'Cooldown was bypassed while recovering a stale job';
  END IF;
END $$;
UPDATE public.lexeme_backfill_rate_gate SET next_allowed_at='-infinity';
DO $$ DECLARE result bigint; job_status text; BEGIN
  result := public.trigger_lexeme_meaning_backfill_if_needed();
  SELECT status INTO job_status FROM public.lexeme_meaning_backfill_jobs WHERE normalized_text='sabertooth';
  IF result IS NOT NULL OR job_status <> 'pending' THEN
    RAISE EXCEPTION 'Stale job was not safely requeued without HTTP dispatch';
  END IF;
END $$;
DO $$ BEGIN
  IF public.trigger_lexeme_meaning_backfill_if_needed() IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION 'Cross-connection Edge gate test failed';
  END IF;
END $$;
SQL
echo 'Secure lexeme cron, auth, cooldown and manual-entry checks passed.'
