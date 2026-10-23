-- Original learning events are immutable. The browser replays the shared TypeScript
-- scheduler, then publishes a projection with a revision compare-and-swap.
-- No second scheduling algorithm lives in SQL.
begin;

alter table public.words add column if not exists review_state jsonb;
alter table public.words add column if not exists learning_revision bigint not null default 0;
create schema if not exists learning_private;
revoke all on schema learning_private from public, anon;
grant usage on schema learning_private to authenticated;

create table learning_private.word_streams (
  word_id uuid primary key references public.words(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  projected_revision bigint not null default 0,
  base jsonb not null,
  projection jsonb not null,
  check (projected_revision between 0 and revision)
);
create table learning_private.word_events (
  user_id uuid not null references auth.users(id) on delete cascade,
  event_id text not null check (length(event_id) between 1 and 240),
  word_id uuid not null references learning_private.word_streams(word_id) on delete cascade,
  occurred_at bigint not null check (occurred_at > 0),
  payload jsonb not null,
  received_at timestamptz not null default now(),
  primary key (user_id, event_id)
);
create index word_events_replay_idx on learning_private.word_events(user_id, word_id, occurred_at, event_id collate "C");
create index word_streams_user_idx on learning_private.word_streams(user_id);
alter table learning_private.word_streams enable row level security;
alter table learning_private.word_events enable row level security;
create policy own_streams on learning_private.word_streams to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy own_events on learning_private.word_events to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
-- No direct table grants: authenticated clients can only append through the RPC.
revoke all on learning_private.word_streams, learning_private.word_events from public, anon, authenticated;

create function learning_private.word_patch(p_word public.words) returns jsonb
language sql immutable security invoker set search_path = '' as $$
  select jsonb_build_object('correct', coalesce(p_word.correct,false), 'tested', coalesce(p_word.tested,false),
    'score', coalesce(p_word.score,0), 'error_count', coalesce(p_word.error_count,0),
    'consecutive_correct', coalesce(p_word.consecutive_correct,0),
    'last_tested', floor(extract(epoch from p_word.last_tested) * 1000),
    'review_state', p_word.review_state, 'best_time_ms', p_word.best_time_ms);
$$;

-- Validate the wire format only. Scheduling and interval changes remain in TS.
create function learning_private.valid_review_state(p_state jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare v_key text;
begin
  if p_state is null or p_state='null'::jsonb then return true; end if;
  if jsonb_typeof(p_state) is distinct from 'object' or p_state->'version' is distinct from '1'::jsonb
    or not (p_state ?& array['phase','lastOutcome','lastIndependentReviewAt'])
    or p_state->>'phase' is null or p_state->>'phase' not in ('learning','review','relearning')
    or p_state->>'lastOutcome' is null or p_state->>'lastOutcome' not in ('independent','assisted','incorrect') then return false; end if;
  foreach v_key in array array['dueAt','lastReviewedAt','stabilityDays','difficulty','lapses','repetitions','learningStep'] loop
    if jsonb_typeof(p_state->v_key) is distinct from 'number' then return false; end if;
  end loop;
  if (p_state->>'dueAt')::numeric<0 or (p_state->>'lastReviewedAt')::numeric<0 or (p_state->>'stabilityDays')::numeric<=0 then return false; end if;
  if p_state->'lastIndependentReviewAt'<>'null'::jsonb and
    (jsonb_typeof(p_state->'lastIndependentReviewAt') is distinct from 'number' or (p_state->>'lastIndependentReviewAt')::numeric<0) then return false; end if;
  return true;
end;
$$;

create function learning_private.get_learning_replay_v1(p_word_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid(); v_id uuid; v_word public.words; v_state learning_private.word_streams;
  v_words jsonb := '[]'; v_events jsonb;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_word_ids is null or cardinality(p_word_ids) not between 1 and 100 then
    raise exception 'Request must contain 1..100 word ids' using errcode='22023';
  end if;
  for v_id in select distinct unnest(p_word_ids) order by 1 loop
    select w.* into v_word from public.words w
      where w.id=v_id and w.user_id=v_user and not coalesce(w.deleted,false) and w.deleted_at is null;
    if not found then raise exception 'Word unavailable' using errcode='42501'; end if;
    select s.* into v_state from learning_private.word_streams s where s.word_id=v_id and s.user_id=v_user;
    select coalesce(jsonb_agg(e.payload order by e.occurred_at, e.event_id collate "C"), '[]') into v_events
      from learning_private.word_events e where e.user_id=v_user and e.word_id=v_id;
    v_words := v_words || jsonb_build_array(jsonb_build_object('word_id',v_id,
      'revision',coalesce(v_state.revision,0), 'base',coalesce(v_state.base,learning_private.word_patch(v_word)),
      'events',v_events));
  end loop;
  return jsonb_build_object('words',v_words);
end;
$$;

create function learning_private.append_learning_events_v1(p_events jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid(); v_item jsonb; v_payload jsonb; v_old jsonb;
  v_id uuid; v_ids uuid[]; v_word public.words; v_inserted text; v_at bigint; v_number numeric;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) not between 1 and 500 then
    raise exception 'Request must contain 1..500 events' using errcode='22023';
  end if;
  select array_agg(distinct (e->>'word_id')::uuid order by (e->>'word_id')::uuid) into v_ids
    from jsonb_array_elements(p_events) e;
  if cardinality(v_ids)>100 or array_position(v_ids,null) is not null then
    raise exception 'Request must contain 1..100 valid word ids' using errcode='22023';
  end if;
  -- Every writer locks words first, in UUID order. Concurrent devices serialize
  -- baseline capture, append, and projection commits without losing events.
  foreach v_id in array v_ids loop
    select w.* into v_word from public.words w where w.id=v_id and w.user_id=v_user
      and not coalesce(w.deleted,false) and w.deleted_at is null for update;
    if not found then raise exception 'Word unavailable' using errcode='42501'; end if;
    insert into learning_private.word_streams(word_id,user_id,base,projection)
      values(v_id,v_user,learning_private.word_patch(v_word),learning_private.word_patch(v_word)) on conflict do nothing;
  end loop;
  for v_item in select value from jsonb_array_elements(p_events) loop
    if jsonb_typeof(v_item) is distinct from 'object' or coalesce(length(v_item->>'event_id'),0) not between 1 and 240
      or (v_item->>'kind') is null or (v_item->>'kind') not in ('answer','legacy_snapshot')
      or jsonb_typeof(v_item->'occurred_at') is distinct from 'number' then
      raise exception 'Invalid learning event' using errcode='22023';
    end if;
    v_at := (v_item->>'occurred_at')::bigint;
    if v_at <= 0 or v_at > floor(extract(epoch from clock_timestamp())*1000)+300000
      or (v_item->>'occurred_at')::numeric <> v_at then
      raise exception 'Invalid original occurrence time' using errcode='22023';
    end if;
    if (v_item->>'outcome') is null or (v_item->>'outcome') not in ('independent','assisted','incorrect') then
      raise exception 'Invalid learning outcome' using errcode='22023';
    end if;
    if v_item->>'kind'='legacy_snapshot' and jsonb_typeof(v_item->'snapshot') is distinct from 'object' then
      raise exception 'Legacy event requires snapshot' using errcode='22023';
    end if;
    if v_item->>'kind'='legacy_snapshot' then
      if jsonb_typeof(v_item#>'{snapshot,correct}') is distinct from 'boolean'
        or v_item#>>'{snapshot,tested}' is distinct from 'true'
        or jsonb_typeof(v_item#>'{snapshot,last_tested}') is distinct from 'number'
        or (v_item#>>'{snapshot,last_tested}')::bigint is distinct from v_at
        or jsonb_typeof(v_item#>'{snapshot,score}') is distinct from 'number'
        or (v_item#>>'{snapshot,score}')::numeric not between 0 and 100
        or jsonb_typeof(v_item#>'{snapshot,error_count}') is distinct from 'number'
        or (v_item#>>'{snapshot,error_count}')::numeric not between 0 and 1000000
        or jsonb_typeof(v_item#>'{snapshot,consecutive_correct}') is distinct from 'number'
        or (v_item#>>'{snapshot,consecutive_correct}')::numeric not between 0 and 1000000
        or not learning_private.valid_review_state(v_item#>'{snapshot,review_state}') then
        raise exception 'Invalid legacy snapshot' using errcode='22023';
      end if;
      if v_item#>>'{snapshot,best_time_ms}' is not null and
        (jsonb_typeof(v_item#>'{snapshot,best_time_ms}') is distinct from 'number'
          or (v_item#>>'{snapshot,best_time_ms}')::numeric not between 0 and 2147483647) then
        raise exception 'Invalid legacy best time' using errcode='22023';
      end if;
    end if;
    if v_item->>'duration_ms' is not null then
      v_number := (v_item->>'duration_ms')::numeric;
      if jsonb_typeof(v_item->'duration_ms') <> 'number' or v_number not between 0 and 3600000 then
        raise exception 'Invalid answer duration' using errcode='22023';
      end if;
    end if;
    if v_item->>'score' is not null and (jsonb_typeof(v_item->'score') <> 'number' or (v_item->>'score')::numeric not between 0 and 100) then
      raise exception 'Invalid answer score' using errcode='22023';
    end if;
    if v_item->>'error_delta' is not null and (jsonb_typeof(v_item->'error_delta') <> 'number' or (v_item->>'error_delta')::numeric not between 0 and 100) then
      raise exception 'Invalid error delta' using errcode='22023';
    end if;
    v_id := (v_item->>'word_id')::uuid;
    -- Canonical known fields make omitted optional nulls equivalent on retry.
    v_payload := jsonb_build_object('event_id',v_item->>'event_id','word_id',v_id,'occurred_at',v_at,
      'kind',v_item->>'kind','outcome',v_item->>'outcome','duration_ms',v_item->'duration_ms');
    if v_item->>'kind'='legacy_snapshot' then v_payload:=v_payload||jsonb_build_object('snapshot',v_item->'snapshot'); end if;
    if v_item->>'score' is not null then v_payload:=v_payload||jsonb_build_object('score',v_item->'score'); end if;
    if v_item->>'error_delta' is not null then v_payload:=v_payload||jsonb_build_object('error_delta',v_item->'error_delta'); end if;
    v_inserted := null;
    insert into learning_private.word_events(user_id,event_id,word_id,occurred_at,payload)
      values(v_user,v_item->>'event_id',v_id,v_at,v_payload) on conflict do nothing returning event_id into v_inserted;
    if v_inserted is null then
      select e.payload into v_old from learning_private.word_events e where e.user_id=v_user and e.event_id=v_item->>'event_id';
      if v_old is distinct from v_payload then raise exception 'Event id reused with different content' using errcode='22023'; end if;
    else
      update learning_private.word_streams set revision=revision+1 where word_id=v_id and user_id=v_user;
    end if;
  end loop;
  return learning_private.get_learning_replay_v1(v_ids);
end;
$$;

create function learning_private.commit_learning_projection_v1(p_word_id uuid,p_revision bigint,p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid:=auth.uid(); v_word public.words; v_state learning_private.word_streams; v_latest bigint;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select w.* into v_word from public.words w where w.id=p_word_id and w.user_id=v_user
    and not coalesce(w.deleted,false) and w.deleted_at is null for update;
  if not found then raise exception 'Word unavailable' using errcode='42501'; end if;
  select s.* into v_state from learning_private.word_streams s where s.word_id=p_word_id and s.user_id=v_user for update;
  if not found then raise exception 'Word has no event stream' using errcode='22023'; end if;
  if p_revision is null or v_state.revision<>p_revision then
    return jsonb_build_object('committed',false,'revision',v_state.revision,'word_id',p_word_id);
  end if;
  select greatest(max(e.occurred_at),coalesce((v_state.base->>'last_tested')::bigint,0)) into v_latest
    from learning_private.word_events e where e.word_id=p_word_id and e.user_id=v_user;
  if jsonb_typeof(p_patch) is distinct from 'object'
    or not(p_patch ?& array['correct','tested','score','error_count','consecutive_correct','last_tested','review_state'])
    or jsonb_typeof(p_patch->'correct') is distinct from 'boolean' or p_patch->>'tested' is distinct from 'true'
    or jsonb_typeof(p_patch->'last_tested') is distinct from 'number'
    or jsonb_typeof(p_patch->'score') is distinct from 'number'
    or jsonb_typeof(p_patch->'error_count') is distinct from 'number'
    or jsonb_typeof(p_patch->'consecutive_correct') is distinct from 'number'
    or (p_patch->>'last_tested')::bigint is distinct from v_latest
    or (p_patch->>'error_count')::numeric not between 0 and 1000000
    or (p_patch->>'score')::numeric not between 0 and 100
    or (p_patch->>'consecutive_correct')::integer not between 0 and 1000000
    or not learning_private.valid_review_state(p_patch->'review_state') then
    raise exception 'Invalid learning projection' using errcode='22023';
  end if;
  if v_state.projected_revision=p_revision then
    if v_state.projection is distinct from p_patch then
      raise exception 'Revision already has a different projection' using errcode='22023';
    end if;
    return jsonb_build_object('committed',true,'revision',p_revision,'word_id',p_word_id);
  end if;
  update learning_private.word_streams set projected_revision=p_revision,projection=p_patch where word_id=p_word_id;
  update public.words set correct=(p_patch->>'correct')::boolean,tested=true,
    score=(p_patch->>'score')::numeric,error_count=(p_patch->>'error_count')::numeric,
    consecutive_correct=(p_patch->>'consecutive_correct')::integer,
    last_tested=to_timestamp((p_patch->>'last_tested')::double precision/1000),
    review_state=p_patch->'review_state',best_time_ms=(p_patch->>'best_time_ms')::integer,learning_revision=p_revision
    where id=p_word_id and user_id=v_user;
  if not found then raise exception 'Projection updated no words' using errcode='40001'; end if;
  return jsonb_build_object('committed',true,'revision',p_revision,'word_id',p_word_id);
end;
$$;

-- A stale metadata/full-sync client must never overwrite event-managed learning.
-- The projection is changed only inside the locked CAS RPC, before its word update.
create function learning_private.preserve_learning_projection() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_patch jsonb; v_revision bigint;
begin
  select s.projection,s.projected_revision into v_patch,v_revision from learning_private.word_streams s where s.word_id=old.id;
  if found then
    if new.user_id is distinct from old.user_id then raise exception 'Cannot transfer an event-managed word' using errcode='42501'; end if;
    new.correct:=(v_patch->>'correct')::boolean; new.tested:=(v_patch->>'tested')::boolean;
    new.score:=(v_patch->>'score')::numeric; new.error_count:=(v_patch->>'error_count')::numeric;
    new.consecutive_correct:=(v_patch->>'consecutive_correct')::integer;
    new.last_tested:=to_timestamp((v_patch->>'last_tested')::double precision/1000);
    new.review_state:=v_patch->'review_state'; new.best_time_ms:=(v_patch->>'best_time_ms')::integer;
    new.learning_revision:=v_revision;
  end if;
  return new;
end;
$$;
create trigger preserve_event_learning before update on public.words
  for each row execute function learning_private.preserve_learning_projection();

create function public.append_learning_events_v1(p_events jsonb) returns jsonb
language sql security invoker set search_path='' as $$select learning_private.append_learning_events_v1(p_events)$$;
create function public.get_learning_replay_v1(p_word_ids uuid[]) returns jsonb
language sql security invoker set search_path='' as $$select learning_private.get_learning_replay_v1(p_word_ids)$$;
create function public.commit_learning_projection_v1(p_word_id uuid,p_revision bigint,p_patch jsonb) returns jsonb
language sql security invoker set search_path='' as $$select learning_private.commit_learning_projection_v1(p_word_id,p_revision,p_patch)$$;

-- Another device can finish a projection after the uploading device closes.
create function learning_private.get_unprojected_learning_replays_v1(p_limit integer default 50) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_ids uuid[];
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'Invalid replay limit' using errcode='22023'; end if;
  select array_agg(s.word_id) into v_ids from (
    select s.word_id from learning_private.word_streams s join public.words w on w.id=s.word_id
    where s.user_id=v_user and w.user_id=v_user and s.projected_revision<s.revision
      and not coalesce(w.deleted,false) and w.deleted_at is null order by s.word_id limit p_limit
  ) s;
  if v_ids is null then return jsonb_build_object('words','[]'::jsonb); end if;
  return learning_private.get_learning_replay_v1(v_ids);
end;
$$;
create function public.get_unprojected_learning_replays_v1(p_limit integer default 50) returns jsonb
language sql security invoker set search_path='' as $$select learning_private.get_unprojected_learning_replays_v1(p_limit)$$;

revoke all on all functions in schema learning_private from public, anon, authenticated;
grant execute on function learning_private.append_learning_events_v1(jsonb),learning_private.get_learning_replay_v1(uuid[]),
  learning_private.commit_learning_projection_v1(uuid,bigint,jsonb),learning_private.get_unprojected_learning_replays_v1(integer) to authenticated;
revoke all on function public.append_learning_events_v1(jsonb),public.get_learning_replay_v1(uuid[]),
  public.commit_learning_projection_v1(uuid,bigint,jsonb),public.get_unprojected_learning_replays_v1(integer) from public,anon;
grant execute on function public.append_learning_events_v1(jsonb),public.get_learning_replay_v1(uuid[]),
  public.commit_learning_projection_v1(uuid,bigint,jsonb),public.get_unprojected_learning_replays_v1(integer) to authenticated;

commit;
