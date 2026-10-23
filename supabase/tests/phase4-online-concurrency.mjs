// Opt-in live Supabase regression. Credentials must belong to a temporary QA
// user, never a real learner. Reads a mode-0600 credential file outside the repo.
// Creates an isolated session/word, removes those in finally, and leaves its
// unique test event ids in a cleanup manifest for the final QA-user teardown.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { parseLearningReplay, projectLearningEvents } from '../../services/learningReplay.ts';
import { syncLearningEvents } from '../../services/learningEventSync.ts';

const credentialsFile=process.argv[2];
if (!credentialsFile) throw new Error('Pass the temporary QA credentials file');
const credentials=JSON.parse(readFileSync(credentialsFile,'utf8'));
assert(credentials.url==='https://mkdxdlsjisqazermmfoe.supabase.co','Explicit project scope');
assert(credentials.email.startsWith('codex-phase4-') && credentials.email.endsWith('@example.invalid'),'Temporary QA account only');
const login=await fetch(`${credentials.url}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:credentials.anonKey,'Content-Type':'application/json'},body:JSON.stringify({email:credentials.email,password:credentials.password})});
const auth=await login.json();
assert(login.ok && auth.user?.id===credentials.userId,'QA login');
const headers={apikey:credentials.anonKey,Authorization:`Bearer ${auth.access_token}`,'Content-Type':'application/json',Prefer:'return=representation'};
async function request(path,method='GET',body) {
  for(let attempt=0;attempt<3;attempt++) {
    let response;
    try {
      response=await fetch(`${credentials.url}/rest/v1/${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    } catch(error) {
      if(attempt===2 || !(method==='GET'||method==='DELETE'||path.startsWith('rpc/'))) throw error;
      await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));continue;
    }
    const value=await response.json();
    if(!response.ok) throw new Error(`${method} ${path.split('?')[0]}: ${response.status} ${value.message||'Request failed'}`);
    return value;
  }
}
const rpc=(name,body)=>request(`rpc/${name}`,'POST',body);
const runId=randomUUID();
const sessionId=randomUUID(),wordId=randomUUID();
const prefix=`qa-concurrency-${runId}`;
const result={runId,checks:[],userId:credentials.userId};
const check=(name)=>{
  result.checks.push(name);
  writeFileSync('/tmp/vocab-phase4-concurrency-result.json',JSON.stringify({...result,status:'running'},null,2),{mode:0o600});
};
const at=Date.now()-86400_000*2;
const statsIds=[`${prefix}-stats-duplicate`,...Array.from({length:4},(_,i)=>`${prefix}-stats-${i}`)];
const date=new Date(at+8*3600_000).toISOString().slice(0,10);
const baseline=(await request(`daily_stats?user_id=eq.${credentials.userId}&date=eq.${date}&select=total_count,correct_count,total_points`))[0]??{total_count:0,correct_count:0,total_points:0};
writeFileSync('/tmp/vocab-phase4-concurrency-fixtures.json',JSON.stringify({runId,userId:credentials.userId,sessionId,wordId,statsIds}),{mode:0o600});
try {
  await request('sessions','POST',{id:sessionId,user_id:credentials.userId,name:`Phase 4 concurrency ${runId}`});
  await request('words','POST',{id:wordId,user_id:credentials.userId,session_id:sessionId,text:`phasefour${runId.replaceAll('-','')}`,language:'en',definition_cn:'临时并发回归词'});
  const events=Array.from({length:16},(_,i)=>({event_id:`${prefix}-event-${String(i).padStart(2,'0')}`,word_id:wordId,occurred_at:at+i*610_000,kind:'answer',outcome:i%3===0?'incorrect':'independent',duration_ms:1000+i}));
  // 32 separate HTTP transactions race on one word, with every original event
  // delivered twice and transport order intentionally unrelated to event time.
  await Promise.all([...events].reverse().flatMap(event=>[rpc('append_learning_events_v1',{p_events:[event]}),rpc('append_learning_events_v1',{p_events:[event]})]));
  let replay=parseLearningReplay(await rpc('get_learning_replay_v1',{p_word_ids:[wordId]}))[0];
  assert.equal(replay.revision,16);assert.equal(replay.events.length,16);
  check('32 concurrent deliveries retain exactly 16 unique events');
  const oldProjection=projectLearningEvents(replay.base,replay.events);
  const late={event_id:`${prefix}-late-error`,word_id:wordId,occurred_at:at-60000,kind:'answer',outcome:'incorrect',duration_ms:null};
  await rpc('append_learning_events_v1',{p_events:[late]});
  assert.equal((await rpc('commit_learning_projection_v1',{p_word_id:wordId,p_revision:16,p_patch:oldProjection})).committed,false);
  check('late error invalidates an earlier device projection');
  replay=parseLearningReplay(await rpc('get_learning_replay_v1',{p_word_ids:[wordId]}))[0];
  const projection=projectLearningEvents(replay.base,replay.events);
  const commits=await Promise.all(Array.from({length:8},()=>rpc('commit_learning_projection_v1',{p_word_id:wordId,p_revision:17,p_patch:projection})));
  assert(commits.every(value=>value.committed===true && value.revision===17));
  const row=(await request(`words?id=eq.${wordId}&select=learning_revision,error_count,review_state,last_tested`))[0];
  assert.equal(row.learning_revision,17);assert.equal(Number(row.error_count),projection.error_count);assert.deepEqual(row.review_state,projection.review_state);
  check('8 simultaneous CAS retries produce the shared TypeScript scheduler projection');
  const crashEvent={event_id:`${prefix}-crash`,word_id:wordId,occurred_at:at+16*610_000,kind:'answer',outcome:'incorrect',duration_ms:null};
  await rpc('append_learning_events_v1',{p_events:[crashEvent]});
  const memory=new Map();const storage={getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value)};
  const transport={getUserId:async()=>credentials.userId,append:events=>rpc('append_learning_events_v1',{p_events:events}),getReplay:ids=>rpc('get_learning_replay_v1',{p_word_ids:ids}),getUnprojected:()=>rpc('get_unprojected_learning_replays_v1',{p_limit:100}),commit:(id,revision,patch)=>rpc('commit_learning_projection_v1',{p_word_id:id,p_revision:revision,p_patch:patch})};
  await syncLearningEvents(credentials.userId,transport,storage);
  assert.equal((await request(`words?id=eq.${wordId}&select=learning_revision`))[0].learning_revision,18);
  check('a second device with empty local storage repairs an abandoned append');
  const stat=(eventId)=>rpc('record_test_event_v1',{p_event_id:eventId,p_occurred_at:new Date(at).toISOString(),p_test_count:10,p_correct_count:8,p_points:20,p_expected_user_id:credentials.userId});
  const wrongOwnerPayload={p_event_id:`${prefix}-wrong-owner`,p_occurred_at:new Date(at).toISOString(),p_test_count:10,p_correct_count:8,p_points:20,p_expected_user_id:randomUUID()};
  await assert.rejects(()=>rpc('record_test_event_v1',wrongOwnerPayload),/Test event account mismatch/);
  const {p_expected_user_id:_owner,...missingOwner}=wrongOwnerPayload;
  await assert.rejects(()=>rpc('record_test_event_v1',missingOwner),/Could not find the function/);
  check('account switch and missing owner cannot misattribute completion');
  const duplicates=await Promise.all(Array.from({length:12},()=>stat(statsIds[0])));
  assert.equal(duplicates.reduce((sum,x)=>sum+x.coins_awarded,0),3);
  assert.equal(duplicates.filter(x=>!x.already_recorded).length,1);
  check('12 parallel completion retries award once');
  await Promise.all(statsIds.slice(1).map(stat));
  const receipt=await stat(statsIds[0]);
  assert.equal(receipt.total_tests,baseline.total_count+50);assert.equal(receipt.correct_tests,baseline.correct_count+40);assert.equal(Number(receipt.total_points),Number(baseline.total_points)+100);
  const ledger=await request(`coin_transactions?user_id=eq.${credentials.userId}&reference=like.${prefix}*&select=delta,reference`);
  assert.equal(ledger.length,5);assert.equal(ledger.reduce((sum,x)=>sum+x.delta,0),15);
  check('4 concurrent distinct completions add without lost updates');
  const anonymous=await fetch(`${credentials.url}/rest/v1/rpc/get_unprojected_learning_replays_v1`,{method:'POST',headers:{apikey:credentials.anonKey,Authorization:`Bearer ${credentials.anonKey}`,'Content-Type':'application/json'},body:'{"p_limit":50}'});
  assert(!anonymous.ok);check('anonymous HTTP RPC access denied');
  writeFileSync('/tmp/vocab-phase4-concurrency-result.json',JSON.stringify({...result,status:'passed'},null,2),{mode:0o600});
  console.log(JSON.stringify({status:'passed',checks:result.checks}));
} finally {
  await request(`words?id=eq.${wordId}&user_id=eq.${credentials.userId}`,'DELETE');
  await request(`sessions?id=eq.${sessionId}&user_id=eq.${credentials.userId}`,'DELETE');
}
