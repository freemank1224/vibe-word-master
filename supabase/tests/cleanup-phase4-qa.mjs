// Explicit teardown for the temporary account used by the live phase 4 suite.
// Never prints keys/passwords. Refuses accounts outside the reserved QA prefix.
import { readFileSync,writeFileSync,unlinkSync,mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const file=process.argv[2];
if(!file || process.argv[3]!=='--delete') throw Error('Pass the QA credentials file and --delete after all browser tests finish');
const c=JSON.parse(readFileSync(file,'utf8'));
assert(c.url==='https://mkdxdlsjisqazermmfoe.supabase.co');
assert(/^codex-phase4-[a-f0-9-]+@example\.invalid$/.test(c.email));
assert(/^[a-f0-9-]{36}$/.test(c.userId));
const dir=mkdtempSync(join(tmpdir(),'vocab-phase4-cleanup-'));
const sql=`begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
do $qa$
declare v_table record; v_dates date[]; v_date date;
begin
  if not exists(select 1 from auth.users where id='${c.userId}'::uuid and email='${c.email}') then
    raise exception 'QA account identity mismatch';
  end if;
  select array_agg(distinct rank_date) into v_dates from public.leaderboards where user_id='${c.userId}'::uuid;
  delete from public.words where user_id='${c.userId}'::uuid;
  delete from public.sessions where user_id='${c.userId}'::uuid;
  for v_table in select c.table_name from information_schema.columns c
    join information_schema.tables t using(table_catalog,table_schema,table_name)
    where c.table_schema='public' and c.column_name='user_id' and c.udt_name='uuid' and t.table_type='BASE TABLE'
  loop
    execute format('delete from public.%I where user_id=$1',v_table.table_name) using '${c.userId}'::uuid;
  end loop;
  delete from learning_private.test_events where user_id='${c.userId}'::uuid;
  -- Remove the temporary ranking position as well as the temporary row.
  foreach v_date in array coalesce(v_dates,'{}'::date[]) loop
    perform public.calculate_daily_leaderboard(v_date);
  end loop;
end;
$qa$;
commit;
select 'QA business records removed' as result;`;
const path=join(dir,'business-cleanup.sql');writeFileSync(path,sql,{mode:0o600});
execFileSync('supabase',['db','query','--linked','--file',path],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const keys=JSON.parse(execFileSync('supabase',['projects','api-keys','--project-ref','mkdxdlsjisqazermmfoe','--output','json'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}));
const service=keys.find(k=>k.name==='service_role')?.api_key;
assert(service,'QA teardown requires Auth Admin access');
const response=await fetch(`${c.url}/auth/v1/admin/users/${c.userId}`,{method:'DELETE',headers:{apikey:service,Authorization:`Bearer ${service}`}});
if(!response.ok) throw Error(`QA Auth deletion failed (${response.status})`);
const verify=`select jsonb_build_object('auth_users',(select count(*) from auth.users where id='${c.userId}'),
 'auth_identities',(select count(*) from auth.identities where user_id='${c.userId}'),
 'words',(select count(*) from public.words where user_id='${c.userId}'),
 'sessions',(select count(*) from public.sessions where user_id='${c.userId}'),
 'daily_stats',(select count(*) from public.daily_stats where user_id='${c.userId}'),
 'daily_test_records',(select count(*) from public.daily_test_records where user_id='${c.userId}'),
 'wallets',(select count(*) from public.user_wallets where user_id='${c.userId}'),
 'coins',(select count(*) from public.coin_transactions where user_id='${c.userId}'),
 'leaderboards',(select count(*) from public.leaderboards where user_id='${c.userId}'),
 'learning_events',(select count(*) from learning_private.word_events where user_id='${c.userId}'),
 'test_events',(select count(*) from learning_private.test_events where user_id='${c.userId}')) as remaining;`;
const verifyPath=join(dir,'verify.sql');writeFileSync(verifyPath,verify,{mode:0o600});
const result=JSON.parse(execFileSync('supabase',['db','query','--linked','--file',verifyPath],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
const remaining=result.rows?.[0]?.remaining;
assert(remaining && Object.values(remaining).every(count=>count===0),'QA data remains');
writeFileSync('/tmp/vocab-phase4-cleanup-result.json',JSON.stringify({userId:c.userId,remaining,status:'passed'},null,2),{mode:0o600});
unlinkSync(file);
console.log(JSON.stringify({status:'passed',remaining,credentialsRemoved:true}));
