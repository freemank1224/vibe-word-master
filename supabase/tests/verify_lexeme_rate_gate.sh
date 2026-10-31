#!/usr/bin/env bash
# Exercise only a throwaway database; never target a real project.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
container="vibe-rate-gate-$$"
output_file="$(mktemp)"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; rm -f "$output_file"; }
trap cleanup EXIT
docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=localtest \
  public.ecr.aws/supabase/postgres:17.6.1.167 >/dev/null
for _ in {1..60}; do
  if [[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" == 'healthy' ]]; then break; fi
  sleep 1
done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" == 'healthy' ]]
cat "$repo_dir/supabase/tests/lexeme_rate_gate_fixture.sql" \
    "$repo_dir/supabase/migrations/20261031014534_lexeme_backfill_global_rate_gate.sql" \
    "$repo_dir/supabase/tests/lexeme_rate_gate_assertions.sql" \
  | docker exec -i "$container" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres
docker exec "$container" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "UPDATE public.lexeme_backfill_rate_gate SET lease_until='-infinity', next_allowed_at='-infinity', lease_token=NULL WHERE singleton"
printf 'BEGIN;\nSELECT public.try_acquire_lexeme_backfill_slot() IS NOT NULL;\nSELECT pg_sleep(3);\nCOMMIT;\n' \
  | docker exec -i "$container" psql -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres >"$output_file" &
worker_pid=$!
ready=false
for _ in {1..30}; do
  if [[ "$(docker exec "$container" psql -qAt -U postgres -d postgres -c "SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND query = 'SELECT pg_sleep(3);'")" == '1' ]]; then ready=true; break; fi
  sleep 0.1
done
if [[ "$ready" != true ]]; then echo 'First worker did not hold its lock' >&2; exit 1; fi
second="$(docker exec "$container" psql -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres -c 'SELECT public.try_acquire_lexeme_backfill_slot() IS NULL')"
wait "$worker_pid"
if ! rg -qx 't' "$output_file" || [[ "$second" != 't' ]]; then
  echo 'Concurrent workers bypassed the shared rate gate' >&2
  exit 1
fi
echo 'Lexeme backfill rate gate and concurrent lease tests passed.'
