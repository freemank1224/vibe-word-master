"""Postgame edge cases using gstack and a disposable official Supabase QA account.

Run after economy-regression.py with the same SURF_QA_SESSION. No gameplay state
injection: answers, settlement, retry and restart all use actual UI controls.
"""
import json
import os
import subprocess
import time
from pathlib import Path

B = str(Path.home() / '.claude/skills/gstack/browse/dist/browse')
BASE = os.environ.get('SURF_QA_URL', 'http://127.0.0.1:5332/monster-run.html')
SESSION = json.loads(Path(os.environ['SURF_QA_SESSION']).read_text())
assert SESSION['user']['email'].endswith('@example.invalid')


def browse(*args):
    return subprocess.run([B, *args], capture_output=True, text=True, check=True).stdout.strip()


def js(source):
    return browse('js', source)


def state():
    return json.loads(js('JSON.stringify(document.querySelector(".ms-app").dataset)'))


def until(check, timeout=90):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = state()
        if check(value):
            return value
        time.sleep(.1)
    raise AssertionError(value)


def ride():
    return json.loads(js('JSON.stringify(JSON.parse(localStorage.getItem(' + json.dumps('vocab_monster_surf_v1:' + SESSION['user']['id']) + ')))'))


def next_ride():
    browse('click', '.ms-result .ms-primary')
    until(lambda s: s['phase'] == 'ready')
    js('''(()=>{const el=document.querySelector('[data-testid="surf-word-count"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,10);
      el.dispatchEvent(new Event('input',{bubbles:true}));return el.value;})()''')
    browse('click', '.ms-start-card .ms-primary')
    until(lambda s: s['phase'] == 'surfing' and s.get('audioReady') == 'true')
    assert state()['deckSize'] == '10'


browse('goto', BASE)
js('localStorage.setItem("sb-mkdxdlsjisqazermmfoe-auth-token",' + json.dumps(json.dumps(SESSION)) + ');"QA auth installed"')
browse('goto', BASE)
until(lambda s: s['phase'] == 'over' and s['settlement'] == 'settled' and s['assets'] == 'ready')
if js('document.querySelector(".ms-site-actions button").textContent') == 'EN':
    browse('click', '.ms-site-actions button')
initial_balance = int(state()['walletBalance'])
# No answer submitted: no error and no manufactured 0% accuracy.
next_ride()
browse('press', 'Escape')
until(lambda s: s['phase'] == 'paused')
browse('click', '.ms-modal .ms-secondary')
until(lambda s: s['phase'] == 'over' and s['settlement'] == 'settled')
assert ride()['attempts'] == []
assert js('document.querySelector("[data-testid=surf-review-accuracy]").textContent') == '—'
assert js('document.querySelectorAll("[data-review-status=unanswered]").length') == '1'
assert js('document.querySelectorAll("[data-review-status=not-reached]").length') == '9'
assert int(state()['walletBalance']) == initial_balance - 1
browse('click', '[data-testid=surf-review-mistakes]')
assert 'No answers were submitted' in js('document.querySelector(".ms-review-empty").textContent')
browse('screenshot', '/tmp/surf-review-zero-answers.png', '--viewport')
zero_run_id = ride()['runId']
# Lose learning upload responses only; wallet settlement stays available.
# Upload may have committed already: retry must keep exactly the same event IDs.
next_ride()
js('''window.__surfReviewResponseText=Response.prototype.text;
Response.prototype.text=async function(...args){
 const body=await window.__surfReviewResponseText.apply(this,args);
 if(this.url.includes('append_learning_events_v1'))throw new TypeError('QA lost learning upload response');
 return body;};"Learning upload fault installed"''')
for answer in ['wrnog', 'wrogn', 'worng']:
    until(lambda s: s['phase'] == 'surfing' and s.get('audioReady') == 'true')
    browse('fill', '#ms-answer', answer)
    browse('press', 'Enter')
    until(lambda s: s['phase'] != 'surfing')
until(lambda s: s['phase'] == 'over' and s['settlement'] == 'settled' and s['learningSync'] == 'pending')
wrong_ride = ride()
assert len(wrong_ride['attempts']) == 3
assert js('document.querySelector("[data-testid=surf-review-accuracy]").textContent') == '0%'
assert js('document.querySelectorAll("[data-review-status=incorrect]").length') == '1'
assert 'sync pending' in js('document.querySelector(".ms-review-sync").textContent')
browse('click', '[data-testid=surf-review-mistakes]')
assert js('document.querySelectorAll(".ms-review-word").length') == '1'
assert js('document.querySelectorAll(".ms-review-wrong-answers code").length') == '3'
browse('screenshot', '/tmp/surf-review-learning-pending.png', '--viewport')
js('Response.prototype.text=window.__surfReviewResponseText;"Learning upload restored"')
browse('click', '.ms-review-sync .ms-secondary')
until(lambda s: s['learningSync'] == 'synced')
assert ride()['attempts'] == wrong_ride['attempts']
assert int(state()['walletBalance']) == initial_balance - 2
browse('goto', BASE)
until(lambda s: s['phase'] == 'over' and s['settlement'] == 'settled' and s['learningSync'] == 'synced')
assert ride()['attempts'] == wrong_ride['attempts']
assert int(state()['walletBalance']) == initial_balance - 2
for width, height in [(1366, 768), (1440, 900), (1920, 1080)]:
    browse('viewport', f'{width}x{height}')
    browse('screenshot', f'/tmp/surf-review-three-misses-{width}.png', '--viewport')
Path('/tmp/surf-review-edge-result.json').write_text(json.dumps({
    'passed': True, 'zeroRunId': zero_run_id, 'wrongRunId': wrong_ride['runId'],
    'wrongWordId': wrong_ride['attempts'][0]['wordId'],
    'eventIds': [a['learning']['eventId'] for a in wrong_ride['attempts']],
    'balanceBefore': initial_balance, 'balanceAfter': int(state()['walletBalance']),
}, indent=2))
print('SURF REVIEW EDGE REGRESSION PASSED', flush=True)
