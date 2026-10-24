-- Fixed 10–50 word rounds and one full-library pass. Existing paid runs and
-- their v1 endpoints remain valid; only new v2 runs carry an explicit mode.
-- Entry and reward accounting stay unchanged and remain wallet-lock serialized.
begin;

alter table surf_private.runs
  add column mode jsonb,
  drop constraint runs_words_check,
  drop constraint runs_correct_count_check,
  add constraint runs_words_check check (jsonb_typeof(words) = 'array' and jsonb_array_length(words) >= 1),
  add constraint runs_correct_count_check check (correct_count between 0 and jsonb_array_length(words));

create function surf_private.valid_run_mode(p_mode jsonb) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select coalesce(jsonb_typeof(p_mode) = 'object' and (
    p_mode->>'kind' = 'endless' or (
      p_mode->>'kind' = 'fixed' and jsonb_typeof(p_mode->'wordCount') = 'number'
      and p_mode->>'wordCount' ~ '^(1[0-9]|[2-4][0-9]|50)$'
    )), false);
$$;

alter table surf_private.runs add constraint runs_mode_check check (
  mode is null or (surf_private.valid_run_mode(mode) and (
    mode->>'kind' = 'endless'
    or jsonb_array_length(words) <= (mode->>'wordCount')::numeric
  ))
);

create or replace function surf_private.run_payload(p_run surf_private.runs) returns jsonb
language sql immutable security invoker set search_path = '' as $$
  select jsonb_build_object('id', p_run.id, 'status', p_run.status, 'words', p_run.words, 'mode', p_run.mode,
    'entry_fee', p_run.entry_fee, 'crystals', p_run.crystals, 'correct_count', p_run.correct_count,
    'reward_coins', p_run.reward_coins, 'net_coins', p_run.reward_coins - p_run.entry_fee,
    'started_at', p_run.started_at, 'settled_at', p_run.settled_at);
$$;

create function surf_private.start_monster_surf_run_v2(p_run_id uuid, p_word_ids uuid[], p_mode jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid(); v_balance integer; v_run surf_private.runs;
  v_words jsonb; v_count integer; v_distinct integer; v_mode jsonb;
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

  if not surf_private.valid_run_mode(p_mode) then
    return jsonb_build_object('error', 'invalid_mode');
  end if;
  -- Persist only the recognized fields. Recovery always returns this original
  -- choice, even if another device starts with a different slider position.
  v_mode := case when p_mode->>'kind' = 'endless' then jsonb_build_object('kind', 'endless')
    else jsonb_build_object('kind', 'fixed', 'wordCount', (p_mode->>'wordCount')::integer) end;
  if p_word_ids is null or cardinality(p_word_ids) < 1
    or (v_mode->>'kind' = 'fixed' and cardinality(p_word_ids) > (v_mode->>'wordCount')::integer)
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

  insert into surf_private.runs(id, user_id, words, mode) values(p_run_id, v_user, v_words, v_mode) returning * into v_run;
  update public.user_wallets set balance = balance - 1, lifetime_spent = lifetime_spent + 1,
    updated_at = now() where user_id = v_user returning balance into v_balance;
  insert into public.coin_transactions(user_id, delta, balance_after, type, reference, note)
    values(v_user, -1, v_balance, 'monster_surf_entry', p_run_id::text, 'Monster Surf entry');
  return jsonb_build_object('run', surf_private.run_payload(v_run), 'balance', v_balance,
    'charged', true, 'recovered', false);
end;
$$;

create function public.start_monster_surf_run_v2(p_run_id uuid, p_word_ids uuid[], p_mode jsonb) returns jsonb
language sql security invoker set search_path = '' as $$
  select surf_private.start_monster_surf_run_v2(p_run_id, p_word_ids, p_mode)
$$;

revoke all on function surf_private.valid_run_mode(jsonb),
  surf_private.start_monster_surf_run_v2(uuid, uuid[], jsonb) from public, anon, authenticated;
grant execute on function surf_private.start_monster_surf_run_v2(uuid, uuid[], jsonb) to authenticated;
revoke all on function public.start_monster_surf_run_v2(uuid, uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.start_monster_surf_run_v2(uuid, uuid[], jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
