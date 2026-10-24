"""Real paid ride + cross-tab wallet regression. Requires a disposable official QA session.
SURF_QA_SESSION=/tmp/...json python3 scripts/monster-surf/wallet-regression.py
Set SURF_QA_EXPECT_STALE=1 only when reproducing the original bug.
"""
import json
import os
import subprocess
import time
from pathlib import Path

B = str(Path.home() / '.claude/skills/gstack/browse/dist/browse')
BASE = os.environ.get('SURF_QA_ORIGIN', 'http://127.0.0.1:5332')
SESSION = json.loads(Path(os.environ['SURF_QA_SESSION']).read_text())
assert SESSION['user']['email'].endswith('@example.invalid')
STALE = os.environ.get('SURF_QA_EXPECT_STALE') == '1'


def browse(*args):
    return subprocess.run([B, *args], text=True, capture_output=True, check=True).stdout.strip()


def js(code):
    return browse('js', code)


def until(read, check, timeout=60):
    deadline = time.monotonic() + timeout
    value = None
    while time.monotonic() < deadline:
        value = read()
        if check(value):
            return value
        time.sleep(.15)
    raise AssertionError(value)


def state():
    return json.loads(js('JSON.stringify({...document.querySelector(".ms-app")?.dataset})'))


def balance():
    return js('document.querySelector(\'[title="Coin balance"] .tabular-nums\')?.textContent ?? ""')


def ride():
    key = json.dumps('vocab_monster_surf_v1:' + SESSION['user']['id'])
    return json.loads(js(f'JSON.stringify(JSON.parse(localStorage.getItem({key})))'))


home = json.loads(browse('newtab', BASE + '/', '--json'))['tabId']
browse('viewport', '1366x768')
js('localStorage.setItem("sb-mkdxdlsjisqazermmfoe-auth-token",' + json.dumps(json.dumps(SESSION)) + ');localStorage.setItem("vibe_language","en");"QA auth installed"')
browse('goto', BASE + '/')
until(balance, lambda v: v.isdigit())
time.sleep(1)
if js('Boolean(document.querySelector(\'[aria-label="Daily Reward"] button\'))') == 'true':
    browse('click', '[aria-label="Daily Reward"] button')
initial = int(balance())
surf = json.loads(browse('newtab', BASE + '/monster-run.html', '--json'))['tabId']
until(state, lambda s: s.get('sessionStatus') == 'ready' and s.get('assets') == 'ready')
if state().get('phase') == 'over':
    until(state, lambda s: s.get('settlement') == 'settled')
    browse('click', '.ms-return-intro')
browse('click', '.ms-start-card .ms-primary')
until(state, lambda s: s.get('phase') == 'surfing' and s.get('audioReady') == 'true')
started = state()
assert int(started['walletBalance']) == initial - 1, (initial, started)
browse('fill', '#ms-answer', ride()['snapshot']['deck'][0]['answer'][:1])
until(state, lambda s: int(s['crystals']) >= 30, 45)
for i in range(3):
    s = until(state, lambda s: s['phase'] == 'surfing' and s.get('audioReady') == 'true')
    word = ride()['snapshot']['deck'][int(s['checkpoint'])]['answer']
    browse('fill', '#ms-answer', word)
    browse('press', 'Enter')
    until(state, lambda s: int(s['correct']) == i + 1)
until(state, lambda s: s['phase'] == 'surfing')
browse('press', 'Escape')
browse('click', '.ms-modal .ms-secondary')
final = until(state, lambda s: s['phase'] == 'over' and s['settlement'] == 'settled')
expected = initial + 2
assert int(final['walletBalance']) == expected, (initial, final)
run_id = ride()['runId']
if not STALE:
    for width, height in [(1366, 768), (1440, 900), (1920, 1080)]:
        browse('viewport', f'{width}x{height}')
        geometry = json.loads(js('''JSON.stringify((()=>{
          const rect=s=>{const b=document.querySelector(s).getBoundingClientRect();return {top:b.top,bottom:b.bottom,left:b.left,right:b.right}};
          return {receipt:rect('[data-testid=surf-settlement]'),review:rect('.ms-word-review'),actions:rect('.ms-review-result-actions'),overflow:document.documentElement.scrollWidth>innerWidth};
        })())'''))
        assert not geometry['overflow'], geometry
        for box in ['receipt', 'review', 'actions']:
            assert 0 <= geometry[box]['top'] < geometry[box]['bottom'] <= height, geometry
        assert '+3' in js('document.querySelector(".ms-settlement-award").textContent')
        assert js('document.querySelector(".ms-settlement-balance strong").textContent') == str(expected)
        browse('screenshot', f'/tmp/surf-wallet-receipt-en-{width}.png', '--viewport')
    browse('click', '.ms-site-actions button')
    browse('viewport', '1366x768')
    browse('screenshot', '/tmp/surf-wallet-receipt-zh-1366.png', '--viewport')
browse('tab', str(home))
if STALE:
    time.sleep(2)
    observed = int(balance())
    assert observed == initial and observed != expected, (initial, observed, expected)
else:
    observed = int(until(balance, lambda v: v == str(expected), 15))
    # A failed read must not replace the confirmed balance with a fake zero.
    js('''window.__walletResponseText=Response.prototype.text;window.__walletFailedReads=0;
      Response.prototype.text=async function(...args){
        const body=await window.__walletResponseText.apply(this,args);
        if(this.url.includes('/rpc/get_wallet_state')){window.__walletFailedReads++;throw new TypeError('QA wallet read interruption');}
        return body;
      };window.dispatchEvent(new Event('vocab:wallet-changed'));"Read interruption installed"''')
    until(lambda: js('String(window.__walletFailedReads)'), lambda v: int(v) > 0, 10)
    assert balance() == str(expected)
    js('Response.prototype.text=window.__walletResponseText;window.dispatchEvent(new Event("vocab:wallet-changed"));"Wallet reads restored"')
    assert until(balance, lambda v: v == str(expected)) == str(expected)
    # Reloading a confirmed Surf receipt returns the same award without paying twice.
    browse('tab', str(surf))
    browse('reload')
    restored = until(state, lambda s: s['phase'] == 'over' and s['settlement'] == 'settled')
    assert int(restored['walletBalance']) == expected
    browse('tab', str(home))
    assert until(balance, lambda v: v == str(expected)) == str(expected)
result = {'passed': True, 'reproducedOldBug': STALE, 'runId': run_id, 'initial': initial, 'expected': expected, 'homepage': observed, 'homeTab': home, 'surfTab': surf}
Path('/tmp/surf-wallet-' + ('before' if STALE else 'after') + '.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result), flush=True)
