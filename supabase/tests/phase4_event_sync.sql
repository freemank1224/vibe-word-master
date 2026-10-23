-- Execute on the authorised Supabase project only. Every fixture and RPC write
-- is rolled back, including wallet and leaderboard side effects. No real account
-- is used. Run with a role allowed to insert isolated auth.users fixtures.
begin;
set local statement_timeout='30s';
set local lock_timeout='3s';
select set_config('vocab.qa_user',gen_random_uuid()::text,true);
select set_config('vocab.qa_other',gen_random_uuid()::text,true);
select set_config('vocab.qa_word',gen_random_uuid()::text,true);
select set_config('vocab.qa_other_word',gen_random_uuid()::text,true);
insert into auth.users(id) values(current_setting('vocab.qa_user')::uuid),(current_setting('vocab.qa_other')::uuid);
insert into public.words(id,user_id,text,language) values
  (current_setting('vocab.qa_word')::uuid,current_setting('vocab.qa_user')::uuid,'codex_phase4_'||gen_random_uuid()::text,'en'),
  (current_setting('vocab.qa_other_word')::uuid,current_setting('vocab.qa_other')::uuid,'codex_phase4_'||gen_random_uuid()::text,'en');
select set_config('request.jwt.claim.sub',current_setting('vocab.qa_user'),true);
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('vocab.qa_user'),'role','authenticated')::text,true);
set local role authenticated;

do $$
declare
  v_word uuid:=current_setting('vocab.qa_word')::uuid;
  v_other uuid:=current_setting('vocab.qa_other_word')::uuid;
  v_now bigint:=floor(extract(epoch from now())*1000)-10000;
  v_events jsonb; v_result jsonb; v_patch jsonb; v_failed boolean;
begin
  v_events:=jsonb_build_array(jsonb_build_object('event_id','qa-new','word_id',v_word,'occurred_at',v_now,
    'kind','answer','outcome','independent','duration_ms',900));
  v_result:=public.append_learning_events_v1(v_events);
  assert (v_result#>>'{words,0,revision}')::integer=1,'first append revision';
  assert jsonb_array_length(v_result#>'{words,0,events}')=1,'first append receipt';
  v_result:=public.append_learning_events_v1(v_events);
  assert (v_result#>>'{words,0,revision}')::integer=1,'retry must not increment revision';
  assert jsonb_array_length(public.get_unprojected_learning_replays_v1(50)->'words')=1,'another device sees abandoned projection';
  v_failed:=false;
  begin
    perform public.append_learning_events_v1(jsonb_set(v_events,'{0,outcome}','"incorrect"'));
  exception when invalid_parameter_value then v_failed:=true; end;
  assert v_failed,'same id different content must fail';

  v_result:=public.append_learning_events_v1(jsonb_build_array(jsonb_build_object(
    'event_id','qa-late-error','word_id',v_word,'occurred_at',v_now-60000,'kind','answer','outcome','incorrect')));
  assert (v_result#>>'{words,0,revision}')::integer=2,'late error retained';
  assert v_result#>>'{words,0,events,0,event_id}'='qa-late-error','original time replay ordering';
  assert jsonb_array_length(v_result#>'{words,0,events}')=2,'both devices retained';
  v_patch:=jsonb_build_object('correct',true,'tested',true,'score',3,'error_count',1,'consecutive_correct',1,
    'last_tested',v_now,'review_state',null,'best_time_ms',900);
  v_result:=public.commit_learning_projection_v1(v_word,1,v_patch);
  assert v_result->>'committed'='false' and v_result->>'revision'='2','stale device CAS rejected';
  v_result:=public.commit_learning_projection_v1(v_word,2,v_patch);
  assert v_result->>'committed'='true','current revision commits';
  assert (select learning_revision=2 and error_count=1 from public.words where id=v_word),'materialized revision';
  assert jsonb_array_length(public.get_unprojected_learning_replays_v1(50)->'words')=0,'repair clears dirty stream';
  assert public.commit_learning_projection_v1(v_word,2,v_patch)->>'committed'='true','lost response commit retry';
  update public.words set error_count=0,review_state=null,learning_revision=0 where id=v_word;
  assert (select learning_revision=2 and error_count=1 from public.words where id=v_word),'legacy snapshot cannot overwrite';

  v_failed:=false;
  begin
    perform public.get_learning_replay_v1(array[v_other]);
  exception when insufficient_privilege then v_failed:=true; end;
  assert v_failed,'cross-account replay forbidden';
  v_failed:=false;
  begin
    perform public.append_learning_events_v1(jsonb_build_array(jsonb_build_object(
      'event_id','qa-foreign','word_id',v_other,'occurred_at',v_now,'kind','answer','outcome','incorrect')));
  exception when insufficient_privilege then v_failed:=true; end;
  assert v_failed,'cross-account append forbidden';
  v_failed:=false;
  begin
    perform public.commit_learning_projection_v1(v_other,0,v_patch);
  exception when insufficient_privilege then v_failed:=true; end;
  assert v_failed,'cross-account projection forbidden';
  v_failed:=false;
  begin
    perform 1 from learning_private.word_events;
  exception when insufficient_privilege then v_failed:=true; end;
  assert v_failed,'direct private ledger access forbidden';
  v_failed:=false;
  begin
    perform public.get_learning_replay_v1(array[gen_random_uuid()]);
  exception when insufficient_privilege then v_failed:=true; end;
  assert v_failed,'missing word cannot return success';

  v_failed:=false;
  begin
    perform public.append_learning_events_v1(jsonb_build_array(jsonb_build_object(
      'event_id','qa-invalid-legacy','word_id',v_word,'occurred_at',v_now,'kind','legacy_snapshot',
      'outcome','incorrect','snapshot',jsonb_set(v_patch,'{review_state}','{"version":99}'::jsonb))));
  exception when invalid_parameter_value then v_failed:=true; end;
  assert v_failed,'invalid legacy snapshot cannot poison replay';
end;
$$;

do $$
declare
  v_at timestamptz:=(((now() at time zone 'Asia/Shanghai')::date-2)+time '23:59:59') at time zone 'Asia/Shanghai';
  v_result jsonb; v_retry jsonb; v_failed boolean; v_user uuid:=current_setting('vocab.qa_user')::uuid;
begin
  v_result:=public.record_test_event_v1('qa-completion',v_at,10,8,20,v_user);
  assert v_result->>'event_id'='qa-completion' and v_result->>'total_tests'='10','completion receipt';
  assert (v_result->>'record_date')::date=(v_at at time zone 'Asia/Shanghai')::date,'original Shanghai day';
  assert v_result->>'coins_awarded'='3','server coin formula';
  v_retry:=public.record_test_event_v1('qa-completion',v_at,10,8,20,v_user);
  assert v_retry->>'total_tests'='10' and v_retry->>'coins_awarded'='0','retry no double count or reward';
  assert v_retry->>'version'=v_result->>'version','retry preserves version';
  assert (select count(*)=1 from public.daily_test_records where user_id=v_user),'one detail row';
  assert (select balance=3 from public.user_wallets where user_id=v_user),'one wallet award';
  assert (select is_frozen from public.daily_stats where user_id=v_user and date=(v_at at time zone 'Asia/Shanghai')::date),'late event preserves frozen flag';
  v_result:=public.record_test_event_v1('qa-completion-next',v_at+interval '2 seconds',2,1,3,v_user);
  assert (v_result->>'record_date')::date=(v_at at time zone 'Asia/Shanghai')::date+1,'Shanghai midnight boundary';
  assert v_result->>'total_tests'='2','next day independent aggregate';
  v_failed:=false;
  begin
    perform public.record_test_event_v1('qa-completion',v_at,10,9,20,v_user);
  exception when invalid_parameter_value then v_failed:=true; end;
  assert v_failed,'completion id cannot be reused with new payload';
  v_failed:=false;
  begin
    perform public.record_test_event_v1('qa-invalid',v_at,10,11,20,v_user);
  exception when invalid_parameter_value then v_failed:=true; end;
  assert v_failed,'invalid correct count rejected';
  v_failed:=false;
  begin
    perform public.record_test_event_v1('qa-wrong-owner',v_at,10,8,20,current_setting('vocab.qa_other')::uuid);
  exception when insufficient_privilege then v_failed:=true; end;
  assert v_failed,'another account cannot receive an offline completion';
  v_failed:=false;
  begin
    perform public.record_test_event_v1('qa-missing-owner',v_at,10,8,20);
  exception when undefined_function then v_failed:=true; end;
  assert v_failed,'unguarded overload is unavailable';
  v_failed:=false;
  begin
    perform public.record_test_event_v1('qa-null-owner',v_at,10,8,20,null);
  exception when insufficient_privilege then v_failed:=true; end;
  assert v_failed,'null owner cannot bypass account binding';
  assert (select count(*)=2 from public.daily_test_records where user_id=v_user),'failed completion has no side effect';
  assert (select test_date=(now() at time zone 'Asia/Shanghai')::date from public.get_todays_stats()),'today timezone read';
end;
$$;

set local role anon;
do $$
declare v_failed boolean:=false;
begin
  begin perform public.get_unprojected_learning_replays_v1(50);
  exception when insufficient_privilege then v_failed:=true; end;
  assert v_failed,'anonymous access denied';
end;
$$;
reset role;
rollback;
select jsonb_build_object('phase4_transaction_regression','passed','assertions',38,'fixtures','rolled back') as result;
