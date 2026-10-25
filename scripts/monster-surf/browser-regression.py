import subprocess, json, time, math, os
from pathlib import Path
B=str(Path.home()/'.claude/skills/gstack/browse/dist/browse')
VERSION=os.environ.get('SURF_QA_VERSION','v6')
BASE=os.environ.get('SURF_QA_URL',f'http://127.0.0.1:5332/monster-run.html?game=surf-{VERSION}&practice=1')
trace=[]
def browse(*args):
 r=subprocess.run([B,*args],capture_output=True,text=True,check=True)
 return r.stdout.strip()
def js(code):return browse('js',code)
def state():return json.loads(js('JSON.stringify({...document.querySelector(".ms-app").dataset,focus:document.activeElement.id})'))
def record(name):
 s=state();trace.append({'check':name,**s});print(name,s,flush=True);return s
def until(test,timeout=90):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  s=state()
  if test(s):return s
  time.sleep(.08)
 raise AssertionError(s)
def phase(name):return until(lambda s:s['phase']==name)
def shot(name):browse('screenshot',f'/tmp/surf-{VERSION}-{name}.png','--viewport')
def fit():
 r=json.loads(js('JSON.stringify({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,arena:document.querySelector(".ms-ocean").getBoundingClientRect().bottom,taskTop:document.querySelector(".ms-task-card")?.getBoundingClientRect().top,inputBottom:document.querySelector("#ms-answer")?.getBoundingClientRect().bottom,seaTop:document.querySelector(".ms-ocean").getBoundingClientRect().top,seaHeight:document.querySelector(".ms-ocean").getBoundingClientRect().height,cursor:getComputedStyle(document.querySelector("canvas")).cursor,pointerLock:!!document.pointerLockElement})'))
 assert not r['overflow'] and r['arena']<=r['height'] and r['cursor']!='none' and not r['pointerLock'],r
 if r.get('inputBottom'):assert r['inputBottom']<r['seaTop']+r['seaHeight']*.4,r
 panels=json.loads(js('JSON.stringify([...document.querySelectorAll(".ms-dashboard > div")].map(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width}}))'))
 if panels:
  assert len(panels)==3 and max(p['top'] for p in panels)-min(p['top'] for p in panels)<1 and max(p['bottom'] for p in panels)-min(p['bottom'] for p in panels)<1,panels
  assert abs(panels[0]['width']-panels[2]['width'])<1,panels
 trace.append({'check':'three-panels-aligned','panels':panels})
 trace.append({'check':'desktop-fit-top-input-pointer',**r})
def fill(text):
 until(lambda s:s.get('audioReady')=='true',35)
 browse('fill','#ms-answer',text)
def positions():
 return json.loads(js('JSON.stringify([...document.querySelectorAll(".lwi-position")].map(e=>({...e.dataset})))'))
def check_positions(expected):
 p=positions();assert [v['state'] for v in p]==expected,p
 return p
def submit(text,mouse=False):
 fill(text)
 browse('click','.ms-task-card form button') if mouse else browse('press','Enter')
def reload():
 browse('goto',BASE)
 for _ in range(70):
  if js('document.querySelector(".ms-start-card .ms-primary")?.disabled')=='false':return
  time.sleep(.1)
 raise AssertionError('assets did not load')

browse('viewport','1366x768');reload()
if js('document.querySelector(".ms-site-actions button").textContent')=='EN':browse('click','.ms-site-actions button')
assert js('document.querySelectorAll("[data-monster-choice]").length')=='0'
assert state()['monster']==js('new Date().getDay()')
initial_images=json.loads(js('JSON.stringify(performance.getEntriesByType("resource").map(e=>e.name).filter(n=>/characters\\/M[0-6]-surf\\.png/.test(n)))'))
assert len(initial_images)==1,initial_images
trace.append({'check':'only-today-character-downloaded','images':initial_images})
js('window.__RealDate=Date;"clock saved"')
for day in range(7):
 js(f'window.__surfTestNow=new window.__RealDate(2026,9,{25}+{day},12).getTime();window.Date=class extends window.__RealDate{{constructor(...args){{super(...(args.length?args:[window.__surfTestNow]))}}static now(){{return window.__surfTestNow}}}};window.dispatchEvent(new Event("focus"));"calendar changed"')
 until(lambda s:s['monster']==str(day) and s['assets']=='ready')
 assert js('document.querySelector("canvas").dataset.surfCharacter')==str(day)
 record('calendar-weekday-'+str(day))
js('window.Date=window.__RealDate;window.dispatchEvent(new Event("focus"));"clock restored"')
until(lambda s:s['monster']==js('new Date().getDay()') and s['assets']=='ready')
record('daily-monster-no-selector');fit();shot('ready-en-1366')
js('window.__surfAudioEvidence=[];const originalPlay=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(...args){const r={src:this.src,rate:this.playbackRate,playing:false,ended:false};window.__surfAudioEvidence.push(r);this.addEventListener("playing",()=>r.playing=true,{once:true});this.addEventListener("ended",()=>r.ended=true,{once:true});return originalPlay.apply(this,args)};"audio probe ready"')
browse('click','.ms-start-card .ms-primary');until(lambda s:s['focus']=='ms-answer');fill('o')
start=record('correct-letter-guided')
assert start['navigation']=='guided'
assert js('document.querySelector("#ms-word-meaning").textContent')=='海洋'
# The requested Chinese vocabulary clue remains Chinese in either UI language.
assert js('/[\\u3400-\\u9fff]/.test(document.body.innerText.replace("中文","").replace(document.querySelector("#ms-word-meaning").textContent,""))')=='false'
assert js('/\\bocean\\b/i.test(document.body.innerText)')=='false'
# The actual shared input: typed correctness, insertion position and serif font.
assert js('document.querySelector(".lwi-embedded")?.dataset.inputVariant')=='embedded'
check_positions(['correct','current','empty','empty','empty'])
fill('ox');check_positions(['correct','wrong','current','empty','empty'])
browse('press','Backspace');check_positions(['correct','current','empty','empty','empty'])
fill('oce');check_positions(['correct','correct','correct','current','empty'])
browse('press','ArrowLeft')
assert js('document.querySelector(".lwi-position[data-current=true]").dataset.position')=='3'
fill('oceanx');p=positions();assert p[-1]['extra']=='true' and p[-1]['state']=='wrong',p
fill('ＯＣＥ');check_positions(['correct','correct','correct','current','empty'])
# IME Enter must not submit or injure before the composition ends.
fill('oce')
js('document.querySelector("#ms-answer").dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));"composition started"')
browse('press','Enter');assert state()['hits']=='0' and state()['correct']=='0'
js('document.querySelector("#ms-answer").dispatchEvent(new CompositionEvent("compositionend",{bubbles:true}));"composition ended"')
fill('o')
font=json.loads(js('JSON.stringify({family:getComputedStyle(document.querySelector("#ms-answer")).fontFamily,size:parseFloat(getComputedStyle(document.querySelector("#ms-answer")).fontSize)})'))
assert 'Playfair Display' in font['family'] and font['size']>=48,font
trace.append({'check':'shared-input-caret-wrong-extra-normalization-ime-font','font':font,'positions':positions()})

time.sleep(.7)
audio=json.loads(js('JSON.stringify(window.__surfAudioEvidence)'));assert any(a['playing'] and a['ended'] for a in audio),audio
browse('click','.ms-listen');time.sleep(.15);assert state()['focus']=='ms-answer'
browse('click','.ms-slow');time.sleep(.15)
audio=json.loads(js('JSON.stringify(window.__surfAudioEvidence)'));assert audio[-1]['rate']==.72 and audio[-1]['playing'],audio
assert js('(()=>{const b=document.querySelector(".ms-listen"),r=b.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2).closest("button")===b})()')=='true'
browse('click','.ms-options button:first-child');browse('click','.ms-listen');time.sleep(.15)
assert json.loads(js('JSON.stringify(window.__surfAudioEvidence)'))[-1]['playing']
browse('press','Escape');p=record('paused');assert p['phase']=='paused';time.sleep(.3);assert state()['distance']==p['distance']
browse('press','Enter');phase('surfing');assert state()['focus']=='ms-answer'
fit();shot('course-set-en-1366')
# Wrong prefixes and deletion keep the last heading; a new correct character
# makes a single course decision. Dedicated idle checks live in typing-guidance.
fill('ox');a=record('wrong-letter-heading-held');time.sleep(.35);b=state()
assert b['navigation']=='locked' and a['targetX']==b['targetX'],(a,b)
fill('o');assert state()['navigation']=='waiting'
fill('oc');assert state()['navigation']=='guided'
# Empty submit is safe; clicking sea recovers the keyboard focus.
submit('  ');assert state()['hits']=='0'
browse('click','canvas');time.sleep(.1);assert state()['focus']=='ms-answer'
for index,word in enumerate(['ocean','sun','wave']):
 phase('surfing');submit(word,mouse=index==1);s=record('word-'+word)
 assert int(s['correct'])==index+1 and abs(float(s['magnet'])-1.5**(index+1))<.0001,s
 assert abs(float(s['speed'])-(1+.08*(index+1)))<.001,s
 phase('surfing')
fill('b');time.sleep(1.1)
assert js('document.querySelector(".ms-abilities span:last-child b").textContent')=='3'
assert '3' in js('document.querySelector(".ms-combo")?.textContent')
for size in ['1366x768','1440x900','1920x1080']:
 browse('viewport',size);time.sleep(.25);fit();shot('three-gulls-en-'+size.split('x')[0])
record('three-gulls-and-magnet')
browse('click','.ms-site-actions button');assert js('document.querySelector("h1").textContent')=='怪兽冲浪'
browse('viewport','1440x900');fit();shot('guided-zh-1440')
browse('click','.ms-site-actions button')
audio=json.loads(js('JSON.stringify(window.__surfAudioEvidence)'))
# A fresh wrong prefix without Enter causes a real collision with the first central island.
reload();browse('click','.ms-start-card .ms-primary');fill('x');before=record('collision-run-heading-locked')
until(lambda s:s['hits']=='1',10);s=record('physical-island-collision');assert s['phase']=='hurt',s
assert float(s['currentSpeed'])==.25,s
shot('collision-en-1440');phase('surfing');assert state()['hits']=='1'
submit('ocean');phase('surfing');s=record('collision-recovery-correct');assert s['hits']=='1' and s['correct']=='1'
submit('wrong');s=record('wrong-answer-second-injury');assert s['hits']=='2'
browse('press','Enter');assert state()['hits']=='2'
phase('surfing');submit('wrong');s=record('third-injury-sinking');assert s['hits']=='3' and s['phase']=='sinking'
time.sleep(.18);shot('sinking-en-1440');phase('over');shot('over-en-1440')
browse('click','.ms-result .ms-primary');phase('ready')
browse('click','.ms-start-card .ms-primary');until(lambda s:s['phase']=='surfing' and s.get('audioReady')=='true')
s=record('restart-reset');assert s['hits']=='0' and s['correct']=='0' and s['magnet']=='1.0000'
browse('press','Escape')
Path(f'/tmp/monster-surf-{VERSION}-browser-regression.json').write_text(json.dumps({'ok':True,'trace':trace,'audio':audio},ensure_ascii=False,indent=2))
print(f'ALL {VERSION.upper()} BROWSER CHECKS PASSED',flush=True)
