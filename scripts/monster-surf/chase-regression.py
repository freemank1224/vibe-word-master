"""Real keyboard/mouse chase flows through gstack browse; no game-state injection."""
import json
import os
import subprocess
import time
from pathlib import Path

B = str(Path.home() / '.claude/skills/gstack/browse/dist/browse')
VERSION = os.environ.get('SURF_QA_VERSION', 'v6')
BASE = os.environ.get('SURF_QA_URL', f'http://127.0.0.1:5332/monster-run.html?game=surf-{VERSION}')
WORDS = ['ocean', 'sun', 'wave', 'beach', 'blue', 'shell', 'island', 'wind', 'fish', 'boat',
         'coral', 'star', 'water', 'cloud', 'turtle', 'rain', 'anchor', 'moon']
trace = []


def browse(*args):
    return subprocess.run([B, *args], check=True, capture_output=True, text=True).stdout.strip()


def js(code):
    return browse('js', code)


def state():
    return json.loads(js('JSON.stringify({...document.querySelector(".ms-app").dataset,focus:document.activeElement.id,canvas:{...document.querySelector("canvas").dataset}})'))


def until(check, timeout=10):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = state()
        if check(last):
            return last
        time.sleep(.06)
    raise AssertionError(last)


def record(name):
    s = state()
    trace.append({'check': name, **s})
    print(name, s, flush=True)
    return s


def shot(name):
    browse('screenshot', f'/tmp/surf-{VERSION}-chase-{name}.png', '--viewport')


def ready_input():
    return until(lambda s: s['phase'] == 'surfing')


def guided():
    s = ready_input()
    browse('fill', '#ms-answer', WORDS[int(s['checkpoint']) % len(WORDS)][:1])


def answer(value=None, mouse=False):
    s = ready_input()
    expected = WORDS[int(s['checkpoint']) % len(WORDS)]
    browse('fill', '#ms-answer', expected if value is None else value)
    browse('click', '.ms-task-card form button') if mouse else browse('press', 'Enter')
    return until(lambda n: n['phase'] != 'surfing')


def start():
    browse('goto', BASE)
    until(lambda s: s['assets'] == 'ready')
    if js('document.querySelector(".ms-site-actions button").textContent') == 'EN':
        browse('click', '.ms-site-actions button')
    browse('click', '.ms-start-card .ms-primary')
    until(lambda s: s['focus'] == 'ms-answer' and s['phase'] == 'surfing')


def reach_ten():
    for n in range(1, 11):
        s = answer(mouse=n == 6)
        assert int(s['correct']) == n, s
        if n < 10:
            assert s['chasePhase'] == 'dormant', s
        else:
            assert s['chasePhase'] == 'warning' and s['chaseStreak'] == '0', s
            assert s['chaseMistakes'] == '0', s
    return record('tenth-word-warning-zero-escape-progress')


def fit():
    layout = json.loads(js('''JSON.stringify((()=>{
      const bounds=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}};
      return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,
        cards:[...document.querySelectorAll('.ms-dashboard>div')].map(bounds),
        ocean:bounds(document.querySelector('.ms-ocean')),canvas:bounds(document.querySelector('canvas')),
        input:bounds(document.querySelector('#ms-answer')),meaning:bounds(document.querySelector('#ms-word-meaning')),
        replayAccessible:(()=>{const e=document.querySelector('.ms-listen'),r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===e})(),
        cursor:getComputedStyle(document.querySelector('canvas')).cursor,
        family:getComputedStyle(document.querySelector('#ms-answer')).fontFamily};
    })())'''))
    assert not layout['overflow'] and layout['ocean']['bottom'] <= layout['height'], layout
    assert layout['replayAccessible'] and layout['cursor'] != 'none', layout
    assert 'Playfair Display' in layout['family'], layout
    cards = layout['cards']
    assert len(cards) == 3 and max(c['y'] for c in cards) - min(c['y'] for c in cards) < 1, layout
    assert max(c['bottom'] for c in cards) - min(c['bottom'] for c in cards) < 1, layout
    assert abs(cards[0]['width'] - cards[2]['width']) < 1, layout
    assert layout['input']['bottom'] <= cards[1]['bottom'], layout
    canvas_state = state()['canvas']
    assert canvas_state['seaMonsterVisible'] == 'true', canvas_state
    assert float(canvas_state['seaMonsterY']) + layout['canvas']['y'] >= cards[1]['bottom'], (canvas_state, layout)
    assert 0 <= float(canvas_state['seaMonsterX']) < layout['canvas']['width'], canvas_state
    assert float(canvas_state['seaMonsterX']) + float(canvas_state['seaMonsterWidth']) <= layout['canvas']['width'], canvas_state
    assert float(canvas_state['seaMonsterY']) + float(canvas_state['seaMonsterHeight']) <= layout['canvas']['height'], canvas_state
    trace.append({'check': 'desktop-chase-layout', **layout, 'canvasState': canvas_state})


browse('viewport', '1366x768')
start()
reach_ten()
shot('warning-en-1366')
browse('press', 'Escape')
p = record('warning-paused')
js('window.__surfPausedFrame=document.querySelector("canvas").toDataURL();"pause captured"')
time.sleep(.4)
frozen = state()
for key in ['distance', 'chasePhaseMs', 'chaseGap', 'chaseBoost']:
    assert frozen[key] == p[key], (key, p, frozen)
assert js('window.__surfPausedFrame===document.querySelector("canvas").toDataURL()') == 'true'
browse('press', 'Enter')
guided()
until(lambda s: s['chasePhase'] == 'chasing')
time.sleep(.6)
s = record('follows-without-an-unearned-attack')
assert s['phase'] == 'surfing' and s['chaseMistakes'] == '0', s
assert js('document.querySelector("#ms-word-meaning").textContent') == '珊瑚'
browse('click', '.ms-listen')
until(lambda s: s['focus'] == 'ms-answer')
browse('click', '.ms-slow')
until(lambda s: s['focus'] == 'ms-answer')
for size in ['1366x768', '1440x900', '1920x1080']:
    browse('viewport', size)
    time.sleep(.15)
    fit()
    shot('following-en-' + size.split('x')[0])
assert js('/[\\u3400-\\u9fff]/.test(document.body.innerText.replace("中文","").replace(document.querySelector("#ms-word-meaning").textContent,""))') == 'false'
browse('click', '.ms-site-actions button')
browse('viewport', '1440x900')
fit()
shot('following-zh-1440')
browse('click', '.ms-site-actions button')

# The motion preference keeps chase geometry and the task usable without idle bobbing.
browse('click', '.ms-options button:last-child')
time.sleep(.15)
assert state()['reducedMotion'] == 'true'
assert state()['canvas']['seaMonsterPose'] == 'emerge'
fit()
shot('less-motion-en-1440')
browse('click', '.ms-options button:last-child')

before_gap = float(state()['chaseGap'])
for n in range(1, 6):
    s = answer(mouse=n == 3)
    assert int(s['chaseStreak']) == n and s['chaseMistakes'] == '0', s
    assert float(s['currentSpeed']) > (1 + int(s['correct']) * .08), s
    if n == 1:
        time.sleep(.16)
        assert float(state()['chaseGap']) > before_gap
        shot('surge-en-1440')
    if n < 5:
        assert s['chasePhase'] in ['warning', 'chasing'], s
    else:
        assert s['chasePhase'] == 'retreating', s
        record('five-consecutive-words-retreat')
        shot('retreat-en-1440')
guided()
until(lambda s: s['chasePhase'] == 'escaped')
record('escaped-and-still-playable')
answer()
guided()
assert state()['chasePhase'] == 'escaped'
browse('press', 'Escape')

# A second real run starts with existing injuries: chase failures remain independent.
browse('viewport', '1366x768')
start()
answer('wrong')
answer('wrong')
assert state()['hits'] == '2'
reach_ten()
guided()
first = answer('wrong')
assert first['chaseMistakes'] == '1' and first['hits'] == '2' and first['phase'] == 'hurt', first
record('first-error-approach-keeps-original-lives')
shot('first-approach-en-1366')
answer()
assert state()['chaseStreak'] == '1' and state()['chaseMistakes'] == '1'
second = answer('wrong')
assert second['chaseMistakes'] == '2' and second['chaseStreak'] == '0' and second['hits'] == '2', second
record('second-error-resets-escape-streak')
shot('second-approach-en-1366')
third = answer('wrong')
assert third['chasePhase'] == 'attacking' and third['chaseMistakes'] == '3' and third['phase'] == 'sinking', third
time.sleep(.25)
shot('attack-en-1366')
browse('press', 'Escape')
paused_attack = record('attack-paused')
time.sleep(.25)
assert state()['chasePhaseMs'] == paused_attack['chasePhaseMs']
browse('press', 'Enter')
until(lambda s: s['phase'] == 'over')
record('third-error-attack-game-over')
shot('game-over-en-1366')
browse('click', '.ms-result .ms-primary')
s = record('restart-clears-chase')
assert s['chasePhase'] == 'dormant' and s['chaseMistakes'] == '0' and s['chaseStreak'] == '0'
assert s['hits'] == '0' and s['correct'] == '0'
browse('press', 'Escape')
Path(f'/tmp/monster-surf-{VERSION}-chase-regression.json').write_text(json.dumps({'ok': True, 'trace': trace}, ensure_ascii=False, indent=2))
print(f'ALL {VERSION.upper()} CHASE BROWSER CHECKS PASSED', flush=True)
