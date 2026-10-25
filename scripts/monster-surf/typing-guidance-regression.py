"""Input-driven steering through real gstack keyboard/mouse actions.

No state injection: coordinates, heading, time and phase are read-only DOM
telemetry. Every course correction comes from an actual input edit.
"""
import json
import os
import subprocess
import time
from pathlib import Path

B = str(Path.home() / '.claude/skills/gstack/browse/dist/browse')
BASE = os.environ.get('SURF_QA_URL', 'http://127.0.0.1:5332/monster-run.html?practice=1')
trace = []


def browse(*args):
    return subprocess.run([B, *args], check=True, capture_output=True, text=True).stdout.strip()


def js(source):
    return browse('js', source)


def state():
    return json.loads(js('JSON.stringify({...document.querySelector(".ms-app")?.dataset,input:document.querySelector("#ms-answer")?.value,focus:document.activeElement.id})'))


def until(check, timeout=90):
    deadline = time.monotonic() + timeout
    value = None
    while time.monotonic() < deadline:
        value = state()
        if check(value):
            return value
        time.sleep(.08)
    raise AssertionError(value)


def record(name, **data):
    row = {'check': name, **data}
    trace.append(row)
    print(json.dumps(row), flush=True)


def start():
    browse('goto', BASE)
    until(lambda s: s.get('phase') == 'ready' and s.get('assets') == 'ready')
    browse('click', '.ms-start-card .ms-primary')
    return until(lambda s: s.get('phase') == 'surfing' and s.get('audioReady') == 'true' and s.get('focus') == 'ms-answer')


def held(name, before=None, seconds=.25):
    before = before or state()
    time.sleep(seconds)
    after = state()
    assert before['phase'] == after['phase'] == 'surfing', (name, before, after)
    assert before['hits'] == after['hits'], (name, before, after)
    assert before['targetX'] == after['targetX'], (name, before, after)
    dt = (float(after['elapsedMs']) - float(before['elapsedMs'])) / 1000
    assert dt > .05, (name, before, after)
    expected_x = min(935, max(65, float(before['x']) + float(before['vx']) * dt))
    assert abs(float(after['x']) - expected_x) < .02, (name, expected_x, before, after)
    expected_vx = 0 if expected_x in (65, 935) else float(before['vx'])
    assert abs(float(after['vx']) - expected_vx) < .00001, (name, before, after)
    record(name, before=before, after=after)
    return after


browse('viewport', '1366x768')
start()
idle = held('no-input-keeps-initial-heading', seconds=.45)
assert idle['navigation'] == 'waiting' and idle['x'] == '500.000' and idle['vx'] == '0.000000', idle
browse('type', 'x')
wrong = held('wrong-first-letter-does-not-turn', seconds=.35)
assert wrong['navigation'] == 'locked' and wrong['x'] == idle['x'], wrong

start()
browse('type', 'o')
guided = state()
assert guided['navigation'] == 'guided' and float(guided['vx']) != 0, guided
held('correct-letter-left-idle-does-not-autopilot', guided, 3.2)
browse('type', 'x')
locked = state()
assert locked['navigation'] == 'locked', locked
held('wrong-suffix-keeps-the-existing-course', locked)

start()
browse('type', 'ox')
before_delete = state()
browse('press', 'Backspace')
deleted = state()
assert deleted['input'] == 'o' and deleted['navigation'] == 'waiting', deleted
assert deleted['targetX'] == before_delete['targetX'] and deleted['vx'] == before_delete['vx'], (before_delete, deleted)
held('deleting-wrong-letter-does-not-buy-a-turn', deleted, .15)
browse('fill', '#ms-answer', 'Ｏ')
normalized = state()
assert normalized['navigation'] == 'waiting', normalized
assert normalized['targetX'] == deleted['targetX'] and normalized['vx'] == deleted['vx'], (deleted, normalized)
held('case-or-width-only-edit-does-not-turn', normalized, .15)
browse('click', '#ms-answer')
browse('press', 'ControlOrMeta+A')
browse('press', 'Backspace')
cleared = state()
assert cleared['navigation'] == 'waiting', cleared
held('clearing-input-keeps-heading', cleared, .15)

start()
browse('type', 'o')
first = held('first-letter-sets-one-course', seconds=.2)
browse('type', 'c')
second = state()
assert second['input'] == 'oc' and second['navigation'] == 'guided', second
assert second['vx'] != first['vx'], (first, second)
held('next-correct-letter-sets-a-new-course-once', second, .2)
browse('click', '.ms-listen')
until(lambda s: s['focus'] == 'ms-answer')
browse('click', 'canvas')
assert state()['focus'] == 'ms-answer'
browse('type', 'ean')
browse('press', 'Enter')
until(lambda s: s['correct'] == '1')
until(lambda s: s['phase'] == 'surfing' and s['audioReady'] == 'true')
held('next-word-is-idle-until-new-correct-input', seconds=.2)

# Capture the actual desktop scene, question and input together. Freeze only
# after each viewport capture; no viewport is treated as a portrait/mobile gate.
for width, height in [(1366, 768), (1440, 900), (1920, 1080)]:
    browse('viewport', f'{width}x{height}')
    start()
    browse('type', 'o')
    geometry = json.loads(js('''JSON.stringify((()=>{
      const bounds=s=>{const r=document.querySelector(s).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}};
      return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,
        scene:bounds('.ms-ocean'),question:bounds('#ms-word-meaning'),input:bounds('#ms-answer'),
        cursor:getComputedStyle(document.querySelector('canvas')).cursor};})())'''))
    assert not geometry['overflow'] and geometry['cursor'] != 'none', geometry
    for name in ['scene', 'question', 'input']:
        assert 0 <= geometry[name]['top'] < geometry[name]['bottom'] <= height, geometry
        assert 0 <= geometry[name]['left'] < geometry[name]['right'] <= width, geometry
    browse('screenshot', f'/tmp/surf-typing-guidance-{width}.png', '--viewport')
    browse('press', 'Escape')
    paused = state()
    time.sleep(.15)
    assert state()['elapsedMs'] == paused['elapsedMs']
    browse('press', 'Enter')
    resumed = until(lambda s: s['phase'] == 'surfing' and s['focus'] == 'ms-answer')
    held(f'resume-does-not-restart-autopilot-{width}', resumed, .15)
    record('desktop-keyboard-mouse-focus-and-layout', **geometry)
    browse('press', 'Escape')

Path('/tmp/surf-typing-guidance-regression.json').write_text(json.dumps({'passed': True, 'trace': trace}, ensure_ascii=False, indent=2))
print('ALL INPUT-DRIVEN STEERING BROWSER CHECKS PASSED', flush=True)
