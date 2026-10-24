"""Desktop QA against an explicitly provisioned official Supabase QA account.

Usage: SURF_QA_SESSION=/tmp/...json python3 scripts/monster-surf/economy-regression.py
The session file is private and must belong to a disposable QA user. No real-user
wallets, mock databases, game-state injection or answer shortcuts are used.
"""
import json
import os
import subprocess
import time
from pathlib import Path

B = str(Path.home() / '.claude/skills/gstack/browse/dist/browse')
BASE = os.environ.get('SURF_QA_URL', 'http://127.0.0.1:5332/monster-run.html')
SESSION = Path(os.environ['SURF_QA_SESSION'])
trace = []


def browse(*args):
    return subprocess.run([B, *args], capture_output=True, text=True, check=True).stdout.strip()


def js(source):
    return browse('js', source)


def state():
    return json.loads(js('JSON.stringify({...document.querySelector(".ms-app").dataset,focus:document.activeElement.id})'))


def until(check, timeout=90):
    end = time.monotonic() + timeout
    value = None
    while time.monotonic() < end:
        value = state()
        if check(value):
            return value
        time.sleep(.1)
    raise AssertionError(value)


def record(name):
    value = state()
    trace.append({'check': name, **value})
    print(name, value, flush=True)
    return value


def ride():
    key = json.dumps('vocab_monster_surf_v1:' + session['user']['id'])
    return json.loads(js(f'JSON.stringify(JSON.parse(localStorage.getItem({key})))'))


def select_count(value):
    js(f'''(()=>{{const el=document.querySelector('[data-testid="surf-word-count"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,{value});
      el.dispatchEvent(new Event('input',{{bubbles:true}}));return el.value;}})()''')
    assert js('document.querySelector("[data-testid=surf-word-count]").value') == str(value)


def preload_evidence():
    return json.loads(js('''JSON.stringify({downloads:window.__paidRecordingProbe.downloads,
      starts:performance.getEntriesByType('resource').filter(e=>e.name.includes('/rpc/start_monster_surf_run_v2'))
        .map(e=>({started:e.startTime,duration:e.duration})),
      blocked:window.__paidRecordingProbe.blocked})'''))


def answer(text=None):
    s = until(lambda s: s['phase'] == 'surfing' and s.get('audioReady') == 'true')
    word = ride()['snapshot']['deck'][int(s['checkpoint'])]['answer']
    browse('fill', '#ms-answer', word if text is None else text)
    browse('press', 'Enter')
    until(lambda s: s['phase'] != 'surfing')


def fit(kind, width, height):
    browse('viewport', f'{width}x{height}')
    value = json.loads(js('''JSON.stringify((()=>{
      const r=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return {top:b.top,bottom:b.bottom,left:b.left,right:b.right}};
      return {w:innerWidth,h:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,
        ocean:r('.ms-ocean'),start:r('.ms-start-card'),result:r('.ms-result'),input:r('#ms-answer'),
        cards:[...document.querySelectorAll('.ms-dashboard>div')].map(e=>({top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom})),
        review:r('.ms-word-review'),actions:r('.ms-review-result-actions'),
        cursor:getComputedStyle(document.querySelector('canvas')).cursor};})())'''))
    assert not value['overflow'] and value['ocean']['bottom'] <= height and value['cursor'] != 'none', value
    for element in ['start', 'result', 'input', 'review', 'actions']:
        if value[element]:
            assert value[element]['top'] >= 0 and value[element]['bottom'] <= height, value
    if value['cards']:
        assert max(x['top'] for x in value['cards']) - min(x['top'] for x in value['cards']) < 1, value
        assert max(x['bottom'] for x in value['cards']) - min(x['bottom'] for x in value['cards']) < 1, value
    trace.append({'check': kind, **value})
    browse('screenshot', f'/tmp/surf-economy-{kind}-{width}.png', '--viewport')


session = json.loads(SESSION.read_text())
assert session['user']['email'].endswith('@example.invalid'), 'Disposable QA account required'
browse('goto', BASE)
# Auth setup only. Never log session contents or use game-state shortcuts.
js('localStorage.setItem("sb-mkdxdlsjisqazermmfoe-auth-token",' + json.dumps(json.dumps(session)) + ');"QA auth installed"')
browse('goto', BASE)
until(lambda s: s['sessionStatus'] == 'ready' and s['assets'] == 'ready')
if js('document.querySelector(".ms-site-actions button").textContent') == 'EN':
    browse('click', '.ms-site-actions button')
initial = record('personal-review-intro')
assert initial['phase'] == 'ready', 'Use a QA account with no pending ride'
assert int(initial['walletBalance']) == int(os.environ.get('SURF_QA_EXPECTED_BALANCE', '160')), initial
assert 'NO RANDOM PICKS' in js('document.querySelector(".ms-selection-info").textContent')
select_count(10)
for size in [(1366, 768), (1440, 900), (1920, 1080)]:
    fit('intro-en', *size)
browse('click', '.ms-site-actions button')
fit('intro-zh', 1366, 768)
browse('click', '.ms-site-actions button')
js('''window.__paidRecordingProbe={block:true,blocked:0,downloads:[]};
const actualFetch=window.fetch.bind(window);
window.fetch=async function(input,init){
 const src=typeof input==='string'?input:input instanceof URL?input.href:input.url;
 const recording=src.includes('.supabase.co/functions/v1/pronunciation')||src.includes('.supabase.co/storage/v1/object/');
 if(recording&&window.__paidRecordingProbe.block){window.__paidRecordingProbe.blocked++;throw new Error('QA recording outage before entry');}
 const response=await actualFetch(input,init);
 if(recording){const read=response.blob.bind(response);response.blob=async()=>{
   const body=await read();if(response.ok&&body.size)window.__paidRecordingProbe.downloads.push({src,bytes:body.size,completed:performance.now()});
   return body;};}
 return response;
};"Paid preparation observation installed"''')
browse('click', '.ms-start-card .ms-primary')
until(lambda s: s.get('preloadStatus') == 'error' and s['phase'] == 'ready')
time.sleep(.5)
failed = record('failed-audio-preparation-does-not-charge')
assert failed['walletBalance'] == initial['walletBalance'] and failed['distance'] == '0', failed
before_retry = preload_evidence()
assert before_retry['blocked'] > 0 and not before_retry['starts'] and not before_retry['downloads'], before_retry
trace.append({'check': 'failed-preload-no-entry-request', **before_retry})
js('window.__paidRecordingProbe.block=false;"Recording service restored"')
browse('click', '.ms-launch-loading-actions button:not(.ms-launch-cancel)')
until(lambda s: s['phase'] == 'surfing' and s.get('audioReady') == 'true' and s['focus'] == 'ms-answer')
started = record('one-coin-entry')
assert int(started['walletBalance']) == int(initial['walletBalance']) - 1
assert len(ride()['snapshot']['deck']) == 10
prepared = preload_evidence()
assert len(prepared['starts']) == 1 and len(prepared['downloads']) == 10, prepared
assert all(row['completed'] <= prepared['starts'][0]['started'] for row in prepared['downloads']), prepared
trace.append({'check': 'all-ten-recordings-complete-before-paid-entry-request', **prepared})
# Correct prefix lets the genuine automatic route gather crystals.
browse('fill', '#ms-answer', ride()['snapshot']['deck'][0]['answer'][:1])
until(lambda s: int(s['crystals']) >= 30, 35)
browse('click', '.ms-listen')
assert state()['focus'] == 'ms-answer'
answer('wrong')
assert state()['hits'] == '1'
answer()
until(lambda s: s['phase'] == 'surfing' and s.get('audioReady') == 'true')
answer()
until(lambda s: s['phase'] == 'surfing' and s.get('audioReady') == 'true')
answer()
until(lambda s: s['phase'] == 'surfing' and s.get('audioReady') == 'true')
browse('fill', '#ms-answer', ride()['snapshot']['deck'][3]['answer'][:1])
for size in [(1366, 768), (1440, 900), (1920, 1080)]:
    fit('active-en', *size)
browse('press', 'Escape')
saved = record('paused-before-reload')
run_id = ride()['runId']
assert len(ride()['attempts']) == 4
browse('goto', BASE)
until(lambda s: s['sessionStatus'] == 'ready' and s['assets'] == 'ready')
assert 'RESUME' in js('document.querySelector(".ms-start-card .ms-primary").textContent')
browse('click', '.ms-start-card .ms-primary')
until(lambda s: s['phase'] == 'paused')
restored = record('paid-run-resumed-without-charge')
assert restored['walletBalance'] == saved['walletBalance'] and restored['correct'] == '3'
assert ride()['runId'] == run_id
# Lose only the response after the real server commits. Reload must show the
# same receipt and must neither pay again nor silently charge a new entry fee.
js('''window.__surfRealResponseText=Response.prototype.text;Response.prototype.text=async function(...args){
 const body=await window.__surfRealResponseText.apply(this,args);
 if(this.url.includes('settle_monster_surf_run_v1'))throw new TypeError('QA lost settlement response');
 return body;};"Settlement response fault installed"''')
browse('click', '.ms-modal .ms-secondary')
until(lambda s: s['phase'] == 'over' and s['settlement'] == 'none')
assert js('document.querySelector(".ms-result .ms-primary").disabled') == 'true'
browse('goto', BASE)
until(lambda s: s['settlement'] == 'settled' and s['phase'] == 'over', 35)
final = record('lost-reply-recovered-on-reload')
assert int(final['walletBalance']) == int(started['walletBalance']) + 3, final
assert '+3' in js('document.querySelector(".ms-settlement").innerText')
assert '+2' in js('document.querySelector(".ms-net").innerText')
# The final screen is a read-only projection of the exact answer journal.
until(lambda s: s['learningSync'] == 'synced', 35)
assert js('document.querySelector("[data-testid=surf-review-accuracy]").textContent') == '67%'
assert js('document.querySelectorAll(".ms-review-word").length') == '10'
assert js('document.querySelectorAll("[data-review-status=corrected]").length') == '1'
assert js('document.querySelectorAll("[data-review-status=first-try-correct]").length') == '2'
assert js('document.querySelectorAll("[data-review-status=unanswered]").length') == '1'
assert js('document.querySelectorAll("[data-review-status=not-reached]").length') == '6'
assert js('document.activeElement.id') == 'ms-over'
review_attempts = ride()['attempts']
assert all(a['learning']['durationMs'] > 0 for a in review_attempts)
browse('click', '[data-testid=surf-review-mistakes]')
assert js('document.querySelectorAll(".ms-review-word").length') == '1'
assert 'wrong' in js('document.querySelector(".ms-review-wrong-answers").textContent')
browse('click', '.ms-review-word:first-child .ms-review-replay')
browse('press', 'Enter')
assert state()['phase'] == 'over', 'Replay must not restart the game'
for size in [(1366, 768), (1440, 900), (1920, 1080)]:
    fit('mistakes-en', *size)
browse('click', '[data-testid=surf-review-all]')
browse('viewport', '1366x768')
browse('click', '.ms-review-scroll')
browse('press', 'End')
assert float(js('document.querySelector(".ms-review-scroll").scrollTop')) > 0
assert float(js('document.querySelector(".ms-review-result-actions").getBoundingClientRect().bottom')) <= 768
browse('press', 'Home')
for size in [(1366, 768), (1440, 900), (1920, 1080)]:
    fit('result-en', *size)
# A confirmed receipt also restores the full review after a normal refresh.
browse('goto', BASE)
until(lambda s: s['phase'] == 'over' and s['settlement'] == 'settled' and s['learningSync'] == 'synced', 35)
assert ride()['attempts'] == review_attempts
assert state()['walletBalance'] == final['walletBalance']
assert js('document.querySelectorAll(".ms-review-word").length') == '10'
record('confirmed-review-restored-without-new-events')
browse('click', '.ms-site-actions button')
fit('result-zh', 1366, 768)
Path('/tmp/surf-economy-browser-result.json').write_text(json.dumps({'ok': True, 'runId': run_id, 'trace': trace}, ensure_ascii=False, indent=2))
print('PAID SURF BROWSER REGRESSION PASSED', flush=True)
