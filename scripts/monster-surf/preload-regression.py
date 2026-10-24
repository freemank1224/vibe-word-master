"""Real-recording preload/streaming checks; all browser control uses gstack browse.

Run against a completed production build. This uses only the explicit free demo,
never a paid account, and stores no authentication or request headers in reports.
"""
import json
import os
import subprocess
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

B = str(Path.home() / '.claude/skills/gstack/browse/dist/browse')
url = urlsplit(os.environ.get('SURF_QA_URL', 'http://127.0.0.1:5332/monster-run.html'))
query = dict(parse_qsl(url.query))
query['practice'] = '1'
BASE = urlunsplit((url.scheme, url.netloc, url.path, urlencode(query), url.fragment))
trace = []
WORDS = ['ocean', 'sun', 'wave', 'beach', 'blue', 'shell', 'island', 'wind', 'fish', 'boat',
         'coral', 'star', 'water', 'cloud', 'turtle', 'rain', 'anchor', 'moon', 'dolphin',
         'sand', 'breeze', 'pearl', 'sail', 'horizon']


def browse(*args):
    return subprocess.run([B, *args], capture_output=True, text=True, check=True).stdout.strip()


def js(source):
    return browse('js', source)


def state():
    return json.loads(js('JSON.stringify({...document.querySelector(".ms-app")?.dataset,focus:document.activeElement?.id})'))


def until(check, timeout=90):
    deadline = time.monotonic() + timeout
    value = None
    while time.monotonic() < deadline:
        value = state()
        if check(value):
            return value
        time.sleep(.12)
    raise AssertionError(value)


def evidence():
    return json.loads(js('JSON.stringify({fetches:window.__preloadProbe.fetches,plays:window.__preloadProbe.plays,voices:window.__preloadProbe.voices})'))


def record(name, details=None):
    row = {'check': name, 'state': state(), 'details': details}
    trace.append(row)
    print(name, row['state'], flush=True)


PROBE = r'''
window.__preloadProbe={fetches:[],plays:[],voices:0,network:'open'};
const probe=window.__preloadProbe;
const realFetch=window.fetch.bind(window);
window.fetch=async function(input,init){
  const src=typeof input==='string'?input:input instanceof URL?input.href:input.url;
  const target=new URL(src,location.href);
  const recording=/\.supabase\.co$/.test(target.hostname)&&
    (/\/functions\/v1\/pronunciation(?:\/|$)/.test(target.pathname)||/\/storage\/v1\/object\//.test(target.pathname));
  if(!recording)return realFetch(input,init);
  const row={src:target.href,started:performance.now(),completed:null,bytes:0,blocked:false,aborted:false};
  probe.fetches.push(row);
  const signal=init?.signal||input?.signal;
  try{
    if(probe.network==='blocked'){row.blocked=true;throw new Error('QA recording network blocked');}
    if(probe.network==='hold'){
      await new Promise((resolve,reject)=>{
        const abort=()=>reject(new DOMException('QA preparation cancelled','AbortError'));
        if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
      });
    }
    const response=await realFetch(input,init);
    const read=response.blob.bind(response);
    response.blob=async()=>{
      const body=await read();
      if(response.ok){row.completed=performance.now();row.bytes=body.size;}
      return body;
    };
    return response;
  }catch(error){row.aborted=error?.name==='AbortError';row.error=error?.name||'Error';throw error;}
};
const realPlay=HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play=function(...args){
  const row={src:this.src,started:performance.now(),rate:this.playbackRate,preservesPitch:this.preservesPitch,
    prepared:probe.fetches.filter(f=>f.completed!==null&&f.bytes>0).length,playing:false,ended:false,
    phase:document.querySelector('.ms-app')?.dataset.phase};
  probe.plays.push(row);
  this.addEventListener('playing',()=>row.playing=true,{once:true});
  this.addEventListener('ended',()=>row.ended=true,{once:true});
  return realPlay.apply(this,args);
};
if(window.speechSynthesis){
  const realSpeak=speechSynthesis.speak.bind(speechSynthesis);
  speechSynthesis.speak=(...args)=>{probe.voices++;return realSpeak(...args);};
}
'Recording probe ready'
'''


def fresh():
    browse('viewport', '1366x768')
    browse('goto', BASE)
    until(lambda s: s.get('phase') == 'ready' and s.get('assets') == 'ready')
    if js('document.querySelector(".ms-site-actions button").textContent.trim()') == 'EN':
        browse('click', '.ms-site-actions button')
    js(PROBE)


def select_count(value):
    # A real native range setter + bubbling input event keeps React's tracker in sync.
    js(f'''(()=>{{const el=document.querySelector('[data-testid="surf-word-count"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,{value});
      el.dispatchEvent(new Event('input',{{bubbles:true}}));return el.value;}})()''')
    actual = js('document.querySelector("[data-testid=surf-word-count]").value')
    assert actual == str(value), actual


def playable():
    return until(lambda s: s.get('phase') == 'surfing' and s.get('audioReady') == 'true')


def answer(word, correct):
    playable()
    browse('fill', '#ms-answer', word)
    browse('press', 'Enter')
    until(lambda s: int(s.get('correct', '0')) == correct)
    if correct < 10:
        playable()


def fit(stage):
    result = json.loads(js('''JSON.stringify((()=>{
      const rect=selector=>{const el=document.querySelector(selector);if(!el)return null;
        const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
      return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,
        ocean:rect('.ms-ocean'),card:rect('.ms-start-card'),input:rect('#ms-answer'),
        question:rect('.ms-task-card'),start:rect('.ms-start-card .ms-primary'),
        cursor:getComputedStyle(document.querySelector('canvas')).cursor};})())'''))
    assert not result['overflow'] and result['cursor'] != 'none', result
    for key in ('ocean', 'input', 'question', 'start'):
        box = result.get(key)
        if box:
            assert 0 <= box['top'] < box['bottom'] <= result['height'], (key, result)
            assert 0 <= box['left'] < box['right'] <= result['width'], (key, result)
    if result['card']:
        assert result['card']['top'] >= result['ocean']['top'], result
        assert result['card']['bottom'] <= result['ocean']['bottom'], result
    if result['question']:
        assert result['question']['bottom'] < result['ocean']['top'] + result['ocean']['height'] * .55, result
    record(stage, result)


def successful_downloads(data):
    return [row for row in data['fetches'] if row['completed'] is not None and row['bytes'] > 0]


def assert_local_playback(data):
    assert data['plays'] and all(row['src'].startswith('blob:') for row in data['plays']), data
    assert any(row['playing'] for row in data['plays']), data
    assert data['voices'] == 0, data


browse('viewport', '1366x768')
fresh()
assert js('document.querySelector("[data-testid=surf-word-count]").value') == '20'
select_count(10)
js('document.querySelector("[data-testid=surf-word-count]").focus();"Range focused"')
browse('press', 'ArrowRight')
assert js('document.querySelector("[data-testid=surf-word-count]").value') == '11'
browse('press', 'Home')
assert js('document.querySelector("[data-testid=surf-word-count]").value') == '10'
for width, height in [(1366, 768), (1440, 900), (1920, 1080)]:
    browse('viewport', f'{width}x{height}')
    fit(f'selector-fit-{width}')
    browse('screenshot', f'/tmp/surf-preload-ready-{width}.png', '--viewport')
browse('viewport', '1366x768')
browse('click', '.ms-start-card .ms-primary')
playable()
data = evidence()
assert state()['deckSize'] == '10' and state()['runMode'] == 'fixed', state()
assert_local_playback(data)
downloads = successful_downloads(data)
assert len(downloads) == 10 and data['plays'][0]['prepared'] == 10, data
assert all(row['completed'] <= data['plays'][0]['started'] for row in downloads), data
record('fixed-all-ten-bodies-complete-before-first-play', data)
js('window.__preloadProbe.network="blocked";"Network disabled after preparation"')
browse('fill', '#ms-answer', 'o')
for width, height in [(1366, 768), (1440, 900), (1920, 1080)]:
    browse('viewport', f'{width}x{height}')
    fit(f'active-fit-{width}')
    browse('screenshot', f'/tmp/surf-preload-active-{width}.png', '--viewport')
browse('click', '.ms-listen')
until(lambda s: s.get('audioStatus') == 'played' and s.get('focus') == 'ms-answer')
browse('click', '.ms-slow')
until(lambda s: s.get('audioStatus') == 'played' and s.get('focus') == 'ms-answer')
slow = evidence()['plays'][-1]
assert slow['rate'] == .72 and slow['preservesPitch'] and slow['playing'], slow
for index, word in enumerate(WORDS[:10], 1):
    answer(word, index)
until(lambda s: s.get('phase') == 'over')
data = evidence()
assert len(data['fetches']) == len(downloads), data
assert_local_playback(data)
assert state()['correct'] == '10' and state()['deckSize'] == '10', state()
assert js('document.querySelectorAll(".ms-review-word").length') == '10'
record('fixed-completes-offline-with-replay-slow-and-enter', data)

# Endless downloads exactly the opening window, then one new recording per advance.
fresh()
select_count(51)
assert 'Endless Mode' in js('document.querySelector("[data-testid=surf-word-count]").getAttribute("aria-valuetext")')
browse('click', '.ms-start-card .ms-primary')
playable()
data = evidence()
assert state()['deckSize'] == '24' and state()['runMode'] == 'endless', state()
assert len(successful_downloads(data)) == 20 and data['plays'][0]['prepared'] == 20, data
assert_local_playback(data)
record('endless-twenty-before-first-play', data)
first_play = data['plays'][0]['started']
for index, word in enumerate(WORDS[:4], 1):
    answer(word, index)
    browse('fill', '#ms-answer', WORDS[index][0])
    until(lambda _s: len(successful_downloads(evidence())) >= 20 + index)
    assert state()['phase'] == 'surfing' and state()['audioReady'] == 'true', state()
data = evidence()
assert len(successful_downloads(data)) == 24, data
assert sum(row['started'] > first_play for row in successful_downloads(data)) == 4, data
assert state()['deckSize'] == '24' and int(state()['correct']) == 4, state()
record('endless-streams-remaining-four-during-play', data)
js('window.__preloadProbe.network="blocked";"All remaining words are now buffered"')
for index, word in enumerate(WORDS[4:], 5):
    answer(word, index)
until(lambda s: s.get('phase') == 'over')
assert state()['correct'] == '24' and state()['deckSize'] == '24', state()
assert len(evidence()['fetches']) == len(data['fetches']), evidence()
assert js('document.querySelectorAll(".ms-review-word").length') == '24'
record('endless-finishes-entire-demo-once-without-loop', evidence())

# Failed preparation must never enter the sea. Retrying uses actual recordings.
fresh()
select_count(10)
js('window.__preloadProbe.network="blocked";"Simulated recording outage"')
browse('click', '.ms-start-card .ms-primary')
until(lambda s: s.get('preloadStatus') == 'error')
failed = state()
assert failed['phase'] == 'ready' and failed['distance'] == '0' and failed['hits'] == '0', failed
assert not evidence()['plays'] and evidence()['voices'] == 0, evidence()
fit('recording-failure-remains-on-launch')
browse('screenshot', '/tmp/surf-preload-failed-1366.png', '--viewport')
js('window.__preloadProbe.network="open";"Recordings restored"')
browse('click', '.ms-launch-loading-actions button:not(.ms-launch-cancel)')
playable()
assert len(successful_downloads(evidence())) == 10, evidence()
assert_local_playback(evidence())
record('failed-preparation-retry-recovers-before-start', evidence())

# Cancel while requests are pending: no start, no playback, editable count again.
fresh()
select_count(10)
js('window.__preloadProbe.network="hold";"Hold recording responses"')
browse('click', '.ms-start-card .ms-primary')
until(lambda s: s.get('preloadStatus') == 'loading')
assert js('document.querySelector("[data-testid=surf-word-count]").disabled') == 'true'
browse('click', '.ms-launch-cancel')
until(lambda s: s.get('phase') == 'ready' and s.get('preloadStatus') != 'loading')
assert not evidence()['plays'] and any(row['aborted'] for row in evidence()['fetches']), evidence()
assert js('document.querySelector("[data-testid=surf-word-count]").disabled') == 'false'
js('window.__preloadProbe.network="open";"Cancelled loading can restart"')
select_count(11)
browse('click', '.ms-start-card .ms-primary')
playable()
assert state()['deckSize'] == '11', state()
assert len(successful_downloads(evidence())) == 11, evidence()
record('cancel-aborts-and-changed-selection-can-start', evidence())
browse('press', 'Escape')
until(lambda s: s.get('phase') == 'paused')
Path('/tmp/surf-preload-browser.json').write_text(json.dumps({'passed': True, 'trace': trace}, indent=2))
print('RECORDING PRELOAD AND ENDLESS STREAMING REGRESSION PASSED', flush=True)
