"""Desktop playback regression against the project's real Supabase recordings."""
import json, os, subprocess, time
from pathlib import Path
B = str(Path.home() / '.claude/skills/gstack/browse/dist/browse')
BASE = os.environ.get('SURF_QA_URL', 'http://127.0.0.1:5332/monster-run.html?practice=1')
def browse(*args):
    return subprocess.run([B, *args], capture_output=True, text=True, check=True).stdout.strip()
def js(source):return browse('js', source)
def state():return json.loads(js('JSON.stringify({...document.querySelector(".ms-app").dataset,focus:document.activeElement.id})'))
def until(check, timeout=90):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        value=state()
        if check(value):return value
        time.sleep(.1)
    raise AssertionError(value)

browse('goto', BASE);browse('viewport','1366x768')
until(lambda s:s['phase']=='ready' and s['assets']=='ready')
js('''window.__recordingProbe=[];window.__recordingDownloads=[];window.__systemVoiceCalls=0;window.__blockRecordings=true;
const realFetch=window.fetch.bind(window);
window.fetch=async function(input,init){
 const src=typeof input==='string'?input:input instanceof URL?input.href:input.url;
 const response=await realFetch(input,init);
 if(src.includes('.supabase.co/functions/v1/pronunciation')||src.includes('.supabase.co/storage/v1/object/')){
   const read=response.blob.bind(response);response.blob=async()=>{const blob=await read();
     if(response.ok&&blob.size)window.__recordingDownloads.push({src,bytes:blob.size});return blob};
 }
 return response;
};
window.__actualMediaPlay=HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play=function(...args){
 const row={src:this.src,rate:this.playbackRate,preservesPitch:this.preservesPitch,playing:false,ended:false};
 window.__recordingProbe.push(row);
 this.addEventListener('playing',()=>row.playing=true,{once:true});
 this.addEventListener('ended',()=>row.ended=true,{once:true});
 if(window.__blockRecordings)return Promise.reject(new Error('QA recording temporarily unavailable'));
 return window.__actualMediaPlay.apply(this,args);
};
if(window.speechSynthesis){window.__actualSpeak=speechSynthesis.speak.bind(speechSynthesis);speechSynthesis.speak=(...args)=>{window.__systemVoiceCalls++;return window.__actualSpeak(...args)}};
'Playback observation ready' ''')
browse('click','.ms-start-card .ms-primary')
failed=until(lambda s:s['audioStatus']=='error')
assert failed['distance']=='0' and failed['hits']=='0' and failed['audioReady']=='false',failed
assert js('document.querySelector("#ms-answer").readOnly')=='true'
time.sleep(.3)
assert state()['distance']=='0'
assert js('window.__systemVoiceCalls')=='0'
js('window.__blockRecordings=false;"Recording connection restored"')
browse('click','.ms-listen')
until(lambda s:s['audioReady']=='true' and s['focus']=='ms-answer')
for answer in ['ocean','sun']:
    until(lambda s:s['phase']=='surfing' and s['audioReady']=='true')
    browse('fill','#ms-answer',answer);browse('press','Enter')
    until(lambda s:s['phase']=='cleared')
until(lambda s:s['phase']=='surfing' and s['audioReady']=='true')
browse('click','.ms-slow')
until(lambda s:s['audioStatus']=='played' and s['focus']=='ms-answer')
audio=json.loads(js('JSON.stringify(window.__recordingProbe)'))
assert audio[-1]['rate']==.72 and audio[-1]['preservesPitch'] and audio[-1]['playing'],audio[-1]
assert all(a['src'].startswith('blob:') for a in audio),audio
downloads=json.loads(js('JSON.stringify(window.__recordingDownloads)'))
assert len(downloads)>=20 and all('mkdxdlsjisqazermmfoe.supabase.co/' in a['src'] for a in downloads),downloads
assert not any('/monster-surf/audio/' in a['src'] for a in audio)
assert js('window.__systemVoiceCalls')=='0'
for w,h in [(1366,768),(1440,900),(1920,1080)]:
    browse('viewport',f'{w}x{h}')
    box=json.loads(js('JSON.stringify((()=>{const b=document.querySelector("#ms-answer").getBoundingClientRect();return {bottom:b.bottom,top:b.top,overflow:document.documentElement.scrollWidth>innerWidth}})())'))
    assert 0<=box['top']<box['bottom']<=h and not box['overflow'],box
    browse('screenshot',f'/tmp/surf-recording-active-{w}.png','--viewport')
browse('press','Escape');until(lambda s:s['phase']=='paused')
browse('click','.ms-modal .ms-secondary');until(lambda s:s['phase']=='over')
browse('click','.ms-review-word:first-child .ms-review-replay')
time.sleep(.5)
assert state()['phase']=='over'
assert js('window.__systemVoiceCalls')=='0'
report={'passed':True,'recordings':json.loads(js('JSON.stringify(window.__recordingProbe)')),'downloads':downloads,'systemVoiceCalls':0,'loadingFreezesRide':True,'recordingRetryAndFocus':True,'desktopSizes':[[1366,768],[1440,900],[1920,1080]]}
Path('/tmp/surf-recording-browser.json').write_text(json.dumps(report,indent=2))
print('STORED RECORDING BROWSER REGRESSION PASSED')
