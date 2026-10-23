-- Bind an offline completion to its originating account before any write.
-- Remove the old overload so a caller cannot omit the ownership guard.
begin;
drop function public.record_test_event_v1(text,timestamptz,integer,integer,numeric);
drop function learning_private.record_test_event_v1(text,timestamptz,integer,integer,numeric);
create function learning_private.record_test_event_v1(p_event_id text,p_occurred_at timestamptz,
  p_test_count integer,p_correct_count integer,p_points numeric,p_expected_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid:=auth.uid(); v_date date; v_existing learning_private.test_events;
  v_inserted text; v_stats public.daily_stats; v_unique bigint; v_coins integer:=0; v_award jsonb;
begin
  if v_user is null or p_expected_user_id is null or v_user is distinct from p_expected_user_id then
    raise exception 'Test event account mismatch' using errcode='42501';
  end if;
  if coalesce(length(p_event_id),0) not between 1 and 240 or p_occurred_at is null
    or not isfinite(p_occurred_at) or p_occurred_at <= '1970-01-01'::timestamptz
    or p_occurred_at>clock_timestamp()+interval '5 minutes'
    or p_test_count is null or p_test_count not between 1 and 10000
    or p_correct_count is null or p_correct_count not between 0 and p_test_count
    or p_points is null or p_points not between 0 and 1000000 then
    raise exception 'Invalid test event' using errcode='22023';
  end if;
  v_date:=(p_occurred_at at time zone 'Asia/Shanghai')::date;
  insert into learning_private.test_events(user_id,event_id,occurred_at,record_date,test_count,correct_count,points)
    values(v_user,p_event_id,p_occurred_at,v_date,p_test_count,p_correct_count,p_points)
    on conflict do nothing returning event_id into v_inserted;
  if v_inserted is null then
    select e.* into v_existing from learning_private.test_events e where e.user_id=v_user and e.event_id=p_event_id;
    if v_existing.occurred_at is distinct from p_occurred_at or v_existing.test_count is distinct from p_test_count
      or v_existing.correct_count is distinct from p_correct_count or v_existing.points is distinct from p_points then
      raise exception 'Event id reused with different content' using errcode='22023';
    end if;
  else
    -- Serialize with other new clients and lock the canonical aggregate before
    -- adding its immutable detail. Keep legacy reports reading the same tables.
    insert into public.daily_stats(user_id,date,total_count,correct_count,total_points,is_frozen)
      values(v_user,v_date,0,0,0,v_date<(now() at time zone 'Asia/Shanghai')::date) on conflict(user_id,date) do nothing;
    perform 1 from public.daily_stats ds where ds.user_id=v_user and ds.date=v_date for update;
    insert into public.daily_test_records(user_id,test_date,test_count,correct_count,points,timezone_offset,created_at)
      values(v_user,v_date,p_test_count,p_correct_count,p_points,8,p_occurred_at);
    update public.daily_stats set total_count=coalesce(total_count,0)+p_test_count,
      correct_count=coalesce(correct_count,0)+p_correct_count,total_points=coalesce(total_points,0)+p_points,
      version=coalesce(version,0)+1,updated_at=now()
      where user_id=v_user and date=v_date;
    -- Same formula as the previous client; the server chooses the reward and
    -- commits it in this transaction. New clients never call it separately.
    v_coins:=round((least(p_test_count::numeric/100,1)*250+p_correct_count::numeric/p_test_count*300)/100)::integer;
    if v_coins>0 then
      v_award:=public.award_game_coins('quiz_score',p_event_id,v_coins);
      if v_award is null or v_award ? 'error' then raise exception 'Coin award failed; event rolled back'; end if;
      if (v_award->>'awarded')::boolean is distinct from true then v_coins:=0; end if;
    end if;
    perform public.calculate_daily_leaderboard(v_date);
  end if;
  select ds.* into v_stats from public.daily_stats ds where ds.user_id=v_user and ds.date=v_date;
  if not found then raise exception 'Test event has no aggregate receipt' using errcode='40001'; end if;
  -- The event ledger is authoritative for cross-day reviews. Include historical
  -- legacy words as a compatibility fallback without double counting word ids.
  select count(*) into v_unique from (
    select e.word_id from learning_private.word_events e where e.user_id=v_user
      and (to_timestamp(e.occurred_at::double precision/1000) at time zone 'Asia/Shanghai')::date=v_date
    union select w.id from public.words w where w.user_id=v_user and not coalesce(w.deleted,false)
      and (w.last_tested at time zone 'Asia/Shanghai')::date=v_date
  ) reviewed;
  return jsonb_build_object('event_id',p_event_id,'record_date',v_date,'synced_date',v_date,
    'total_tests',v_stats.total_count,'correct_tests',v_stats.correct_count,'total_points',v_stats.total_points,
    'unique_words',v_unique,'version',v_stats.version,'conflict_detected',false,
    'already_recorded',v_inserted is null,'coins_awarded',v_coins);
end;
$$;
create function public.record_test_event_v1(p_event_id text,p_occurred_at timestamptz,
  p_test_count integer,p_correct_count integer,p_points numeric,p_expected_user_id uuid) returns jsonb
language sql security invoker set search_path='' as $$
  select learning_private.record_test_event_v1(p_event_id,p_occurred_at,p_test_count,p_correct_count,p_points,p_expected_user_id)
$$;
revoke all on function learning_private.record_test_event_v1(text,timestamptz,integer,integer,numeric,uuid) from public,anon;
revoke all on function public.record_test_event_v1(text,timestamptz,integer,integer,numeric,uuid) from public,anon;
grant execute on function learning_private.record_test_event_v1(text,timestamptz,integer,integer,numeric,uuid) to authenticated;
grant execute on function public.record_test_event_v1(text,timestamptz,integer,integer,numeric,uuid) to authenticated;


commit;
