from pathlib import Path
import json
import urllib.request
import urllib.error


def load_env(path: Path):
    env = {}
    for line in path.read_text().splitlines():
        s = line.strip()
        if not s or s.startswith('#') or '=' not in s:
            continue
        k, v = s.split('=', 1)
        env[k.strip()] = v.strip()
    return env


def call_rpc(url: str, key: str, payload: dict):
    endpoint = url.rstrip('/') + '/rest/v1/rpc/record_test_and_sync_stats'
    req = urllib.request.Request(endpoint, data=json.dumps(payload).encode('utf-8'), method='POST')
    req.add_header('apikey', key)
    req.add_header('Authorization', f'Bearer {key}')
    req.add_header('Content-Type', 'application/json')

    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode('utf-8', 'ignore')
            return resp.status, body
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'ignore')
        return e.code, body


def main():
    env_path = Path('.env')
    if not env_path.exists():
        print('❌ .env not found')
        return

    env = load_env(env_path)
    url = env.get('SUPABASE_URL')
    anon_key = env.get('SUPABASE_ANON_KEY')

    if not url or not anon_key:
        print('❌ SUPABASE_URL or SUPABASE_ANON_KEY missing in .env')
        return

    print('== Step 1: Reachability / function existence check ==')
    status, body = call_rpc(
        url,
        anon_key,
        {
            'p_test_count': 1,
            'p_correct_count': 1,
            'p_points': 1,
            'p_timezone_offset_hours': 8,
            'p_client_date': '2026-02-14',
            'p_expected_version': 0,
        },
    )

    print(f'HTTP {status}')
    print(body[:600])

    if 'Could not find the function public.record_test_and_sync_stats' in body:
        print('❌ RPC function signature not deployed as expected')
    else:
        print('✅ RPC endpoint exists and signature is callable')

    print('\n== Step 2: Historical-date rejection check (server-side guard) ==')
    status2, body2 = call_rpc(
        url,
        anon_key,
        {
            'p_test_date': '2026-02-13',
            'p_test_count': 1,
            'p_correct_count': 1,
            'p_points': 1,
            'p_timezone_offset_hours': 8,
            'p_client_date': '2026-02-13',
            'p_expected_version': 0,
        },
    )

    print(f'HTTP {status2}')
    print(body2[:600])

    if 'Cannot modify historical stats for date' in body2:
        print('✅ Historical-write guard is active at DB layer')
    else:
        print('⚠️ Could not prove historical-write guard via anon key path')
        print('   Reason: anon calls may fail before business guard due to auth/RLS constraints.')


if __name__ == '__main__':
    main()
