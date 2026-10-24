-- Monster Surf economy. Pickups are Sea Crystals, never wallet coins.
-- Entry costs one coin; settlement pays min(correct distinct words, crystals / 10).
-- The browser reports gameplay, but cannot choose an award amount or exceed its
-- snapshotted personal word deck. This is a bounded client-game economy, not
-- server-authoritative physics or anti-cheat validation.
begin;

create schema if not exists surf_private;
revoke all on schema surf_private from public, anon, authenticated;
grant usage on schema surf_private to authenticated;

create table surf_private.runs (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'settled')),
  words jsonb not null check (jsonb_typeof(words) = 'array' and jsonb_array_length(words) between 1 and 100),
  entry_fee integer not null default 1 check (entry_fee = 1),
  crystals integer not null default 0 check (crystals between 0 and 1000000),
  correct_count integer not null default 0 check (correct_count between 0 and 100),
  reward_coins integer not null default 0 check (reward_coins between 0 and correct_count),
  attempts jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  settled_at timestamptz,
  check ((status = 'active' and settled_at is null) or (status = 'settled' and settled_at is not null))
);
create unique index monster_surf_one_active_run on surf_private.runs(user_id) where status = 'active';
create index monster_surf_user_history on surf_private.runs(user_id, started_at desc);
alter table surf_private.runs enable row level security;
create policy own_surf_runs on surf_private.runs to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
revoke all on surf_private.runs from public, anon, authenticated;

-- Extend only the ledger's type checks, preserving any existing types that
-- were added by other releases. Surf deliberately does not use award_game_coins.
do $$
declare c record;
begin
  for c in select conname, pg_get_expr(conbin, conrelid) as predicate
    from pg_constraint where conrelid = 'public.coin_transactions'::regclass
      and contype = 'c' and pg_get_constraintdef(oid) ilike '%type = ANY%'
  loop
    execute format('alter table public.coin_transactions drop constraint %I', c.conname);
    execute format('alter table public.coin_transactions add constraint %I check ((%s) or type in (''monster_surf_entry'', ''monster_surf_reward''))', c.conname, c.predicate);
  end loop;
end $$;

create function surf_private.run_payload(p_run surf_private.runs) returns jsonb
language sql immutable security invoker set search_path = '' as $$
  select jsonb_build_object('id', p_run.id, 'status', p_run.status, 'words', p_run.words,
    'entry_fee', p_run.entry_fee, 'crystals', p_run.crystals, 'correct_count', p_run.correct_count,
    'reward_coins', p_run.reward_coins, 'net_coins', p_run.reward_coins - p_run.entry_fee,
    'started_at', p_run.started_at, 'settled_at', p_run.settled_at);
$$;

create function surf_private.normalize_answer(p_text text) returns text
language sql immutable security invoker set search_path = '' as $$
  select replace(replace(replace(replace(lower(regexp_replace(normalize(p_text, NFKC),
    '^[[:space:]' || chr(65279) || ']+|[[:space:]' || chr(65279) || ']+$', '', 'g')),
    '’', chr(39)), '‘', chr(39)), '‐', '-'), '‑', '-');
$$;

-- Privileged code stays in a non-exposed schema. Every entry point derives the
-- owner from auth.uid(); no caller-supplied user id is ever accepted.
create function surf_private.get_monster_surf_account_v1() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_balance integer; v_run surf_private.runs;
begin
  if v_user is null then return jsonb_build_object('error', 'not_authenticated'); end if;
  select balance into v_balance from public.user_wallets where user_id = v_user;
  select * into v_run from surf_private.runs where user_id = v_user and status = 'active';
  return jsonb_build_object('balance', coalesce(v_balance, 0),
    'active_run', case when v_run.id is null then null else surf_private.run_payload(v_run) end);
end;
$$;

create function surf_private.start_monster_surf_run_v1(p_run_id uuid, p_word_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid(); v_balance integer; v_run surf_private.runs;
  v_words jsonb; v_count integer; v_distinct integer;
begin
  if v_user is null then return jsonb_build_object('error', 'not_authenticated'); end if;
  if p_run_id is null then return jsonb_build_object('error', 'invalid_run_id'); end if;

  -- All economy mutations lock the wallet first, including settlement. This
  -- serializes concurrent tabs, new UUIDs, retries and the existing wallet RPCs.
  insert into public.user_wallets(user_id) values(v_user) on conflict(user_id) do nothing;
  select balance into v_balance from public.user_wallets where user_id = v_user for update;

  select * into v_run from surf_private.runs where id = p_run_id;
  if found then
    if v_run.user_id <> v_user then return jsonb_build_object('error', 'run_unavailable'); end if;
    return jsonb_build_object('run', surf_private.run_payload(v_run), 'balance', v_balance,
      'charged', false, 'recovered', true);
  end if;
  select * into v_run from surf_private.runs where user_id = v_user and status = 'active';
  if found then
    return jsonb_build_object('run', surf_private.run_payload(v_run), 'balance', v_balance,
      'charged', false, 'recovered', true);
  end if;

  if p_word_ids is null or cardinality(p_word_ids) not between 1 and 100
    or array_position(p_word_ids, null) is not null
    or cardinality(p_word_ids) <> (select count(distinct id) from unnest(p_word_ids) as u(id)) then
    return jsonb_build_object('error', 'invalid_words');
  end if;
  select count(*), count(distinct normalized.answer),
    jsonb_agg(jsonb_build_object('word_id', w.id, 'answer', normalized.answer,
      'meaning_zh', meanings.zh,
      'meaning_en', case when meanings.en ~ U&'[\2E80-\2FFF\3005\3007\303B\3400-\4DBF\4E00-\9FFF\F900-\FAFF\+020000-\+0323AF]' then ''
        else left(regexp_replace(meanings.en, '(?<![A-Za-z0-9_])' || normalized.answer || '(?![A-Za-z0-9_])', '____', 'gi'), 240) end,
      'audio_url', w.audio_url) order by requested.position)
    into v_count, v_distinct, v_words
    from unnest(p_word_ids) with ordinality as requested(id, position)
    join public.words w on w.id = requested.id and w.user_id = v_user
      and not coalesce(w.deleted, false) and w.deleted_at is null
    cross join lateral (select surf_private.normalize_answer(w.text) as answer) normalized
    left join lateral (select value as option from jsonb_array_elements(
      case when jsonb_typeof(w.meaning_options) = 'array' then w.meaning_options else '[]'::jsonb end)
      where value->>'key' = w.selected_meaning_key limit 1) chosen on true
    cross join lateral (select
      btrim(regexp_replace(coalesce(nullif(chosen.option->>'meaningZh', ''), w.definition_cn, ''), '\s+', ' ', 'g')) as zh,
      btrim(regexp_replace(coalesce(case when chosen.option is not null then chosen.option->>'definitionEn'
        else w.definition_en end, ''), '\s+', ' ', 'g')) as en) meanings
    where surf_private.normalize_answer(coalesce(nullif(w.language, ''), 'en')) ~ '^en(-[a-z]{2,})?$'
      and normalized.answer ~ '^[a-z]+([-''][a-z]+)*$' and length(normalized.answer) between 2 and 24
      -- The shared TS selector handles full Unicode Script=Han recognition.
      -- Server eligibility is deliberately a superset so rare valid Han clues
      -- cannot charge-fail because of PostgreSQL Unicode-version differences.
      and length(meanings.zh) between 1 and 240
      and not meanings.zh ~* ('(?<![A-Za-z0-9_])' || normalized.answer || '(?![A-Za-z0-9_])');
  if v_count <> cardinality(p_word_ids) or v_distinct <> v_count then
    return jsonb_build_object('error', 'invalid_words');
  end if;
  if v_balance < 1 then return jsonb_build_object('error', 'insufficient_balance', 'balance', v_balance); end if;

  insert into surf_private.runs(id, user_id, words) values(p_run_id, v_user, v_words) returning * into v_run;
  update public.user_wallets set balance = balance - 1, lifetime_spent = lifetime_spent + 1,
    updated_at = now() where user_id = v_user returning balance into v_balance;
  insert into public.coin_transactions(user_id, delta, balance_after, type, reference, note)
    values(v_user, -1, v_balance, 'monster_surf_entry', p_run_id::text, 'Monster Surf entry');
  return jsonb_build_object('run', surf_private.run_payload(v_run), 'balance', v_balance,
    'charged', true, 'recovered', false);
end;
$$;

create function surf_private.settle_monster_surf_run_v1(p_run_id uuid, p_crystals integer, p_attempts jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid(); v_balance integer; v_run surf_private.runs;
  v_attempt jsonb; v_word jsonb; v_answer text; v_correct integer := 0; v_reward integer;
begin
  if v_user is null then return jsonb_build_object('error', 'not_authenticated'); end if;
  select balance into v_balance from public.user_wallets where user_id = v_user for update;
  if not found then return jsonb_build_object('error', 'run_unavailable'); end if;
  select * into v_run from surf_private.runs where id = p_run_id and user_id = v_user for update;
  if not found then return jsonb_build_object('error', 'run_unavailable'); end if;
  -- Return the committed result before considering a changed retry payload.
  if v_run.status = 'settled' then
    return jsonb_build_object('run', surf_private.run_payload(v_run), 'balance', v_balance, 'already_settled', true);
  end if;
  if p_crystals is null or p_crystals not between 0 and 1000000 then
    return jsonb_build_object('error', 'invalid_crystals');
  end if;
  if jsonb_typeof(p_attempts) is distinct from 'array'
    or jsonb_array_length(p_attempts) > jsonb_array_length(v_run.words) * 3 + 10 then
    return jsonb_build_object('error', 'invalid_attempts');
  end if;
  for v_attempt in select value from jsonb_array_elements(p_attempts) loop
    v_word := v_run.words -> v_correct;
    if v_word is null or jsonb_typeof(v_attempt) is distinct from 'object'
      or jsonb_typeof(v_attempt->'word_id') is distinct from 'string'
      or v_attempt->>'word_id' is distinct from v_word->>'word_id'
      or jsonb_typeof(v_attempt->'answer') is distinct from 'string'
      or length(v_attempt->>'answer') not between 1 and 128 then
      return jsonb_build_object('error', 'invalid_attempts');
    end if;
    v_answer := surf_private.normalize_answer(v_attempt->>'answer');
    if v_answer = '' then return jsonb_build_object('error', 'invalid_attempts'); end if;
    -- Wrong retries stay on this word; only a correct submission moves to the
    -- next snapshotted word. Duplicate and out-of-order successes cannot pay.
    if v_answer = v_word->>'answer' then v_correct := v_correct + 1; end if;
  end loop;
  v_reward := least(v_correct, p_crystals / 10);
  update surf_private.runs set status = 'settled', crystals = p_crystals, correct_count = v_correct,
    reward_coins = v_reward, attempts = p_attempts, settled_at = now()
    where id = p_run_id and user_id = v_user returning * into v_run;
  if v_reward > 0 then
    update public.user_wallets set balance = balance + v_reward, lifetime_earned = lifetime_earned + v_reward,
      updated_at = now() where user_id = v_user returning balance into v_balance;
    insert into public.coin_transactions(user_id, delta, balance_after, type, reference, note)
      values(v_user, v_reward, v_balance, 'monster_surf_reward', p_run_id::text, 'Monster Surf Sea Crystal exchange');
  end if;
  return jsonb_build_object('run', surf_private.run_payload(v_run), 'balance', v_balance, 'already_settled', false);
end;
$$;

create function public.get_monster_surf_account_v1() returns jsonb
language sql security invoker set search_path = '' as $$ select surf_private.get_monster_surf_account_v1() $$;
create function public.start_monster_surf_run_v1(p_run_id uuid, p_word_ids uuid[]) returns jsonb
language sql security invoker set search_path = '' as $$ select surf_private.start_monster_surf_run_v1(p_run_id, p_word_ids) $$;
create function public.settle_monster_surf_run_v1(p_run_id uuid, p_crystals integer, p_attempts jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select surf_private.settle_monster_surf_run_v1(p_run_id, p_crystals, p_attempts) $$;

revoke all on all functions in schema surf_private from public, anon, authenticated;
grant execute on function surf_private.get_monster_surf_account_v1(),
  surf_private.start_monster_surf_run_v1(uuid, uuid[]), surf_private.settle_monster_surf_run_v1(uuid, integer, jsonb) to authenticated;
revoke all on function public.get_monster_surf_account_v1(), public.start_monster_surf_run_v1(uuid, uuid[]),
  public.settle_monster_surf_run_v1(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.get_monster_surf_account_v1(), public.start_monster_surf_run_v1(uuid, uuid[]),
  public.settle_monster_surf_run_v1(uuid, integer, jsonb) to authenticated;

commit;
