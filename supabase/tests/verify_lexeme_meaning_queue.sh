#!/usr/bin/env bash
# Run against a throwaway Docker PostgreSQL, never against a user's database.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
container="vibe-lexeme-sql-$$"
output_file="$(mktemp)"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; rm -f "$output_file"; }
trap cleanup EXIT
docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=localtest \
  public.ecr.aws/supabase/postgres:17.6.1.167 >/dev/null
for _ in {1..60}; do
  # pg_isready can briefly succeed against the image's initialization server.
  if [[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" == 'healthy' ]]; then break; fi
  sleep 1
done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" == 'healthy' ]]
cat "$repo_dir/supabase/tests/lexeme_meaning_queue_fixture.sql" \
    "$repo_dir/supabase/migrations/20261029151241_lexeme_valid_chinese_meanings.sql" \
    "$repo_dir/supabase/tests/lexeme_meaning_queue_assertions.sql" \
  | docker exec -i "$container" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres

# Two workers claim separate rows while the first transaction holds its lock.
docker exec -i "$container" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
INSERT INTO public.lexeme_entries (id, normalized_text, display_text) VALUES
 ('00000000-0000-0000-0000-000000000004', 'worker-a', 'worker-a'),
 ('00000000-0000-0000-0000-000000000005', 'worker-b', 'worker-b');
INSERT INTO public.lexeme_meaning_backfill_jobs (lexeme_id, normalized_text, display_text, language, status, priority) VALUES
 ('00000000-0000-0000-0000-000000000004', 'worker-a', 'worker-a', 'en', 'pending', 1),
 ('00000000-0000-0000-0000-000000000005', 'worker-b', 'worker-b', 'en', 'pending', 2);
SQL
printf 'BEGIN;\nSELECT normalized_text FROM public.claim_lexeme_meaning_backfill_jobs(1);\nSELECT pg_sleep(3);\nCOMMIT;\n' \
  | docker exec -i "$container" psql -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres >"$output_file" &
worker_pid=$!
ready=false
for _ in {1..30}; do
  if [[ "$(docker exec "$container" psql -qAt -U postgres -d postgres -c "SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND query = 'SELECT pg_sleep(3);'")" == '1' ]]; then ready=true; break; fi
  sleep 0.1
done
if [[ "$ready" != true ]]; then echo 'First worker did not hold its lock' >&2; exit 1; fi
second="$(docker exec "$container" psql -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres -c 'SELECT normalized_text FROM public.claim_lexeme_meaning_backfill_jobs(1)')"
wait "$worker_pid"
if ! rg -qx 'worker-a' "$output_file" || [[ "$second" != 'worker-b' ]]; then
  echo 'Concurrent claims did not select separate jobs' >&2
  exit 1
fi
docker exec "$container" psql -qAt -U postgres -d postgres -c 'SHOW server_version'
echo 'Lexeme queue migration and concurrent claims passed.'
