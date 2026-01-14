-- Migration: Frozen History & Daily Buffer V2

-- 1. Create `daily_stats` table for persistent history
-- This table stores the final score for each day, immune to word deletions.
create table if not exists public.daily_stats (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references auth.users(id) on delete cascade not null,
    date date not null,
    total int default 0,
    correct int default 0,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    unique(user_id, date)
);

-- Enable Security
alter table public.daily_stats enable row level security;

create policy "Users can manage their own stats"
    on public.daily_stats for all
    using (auth.uid() = user_id);

-- 2. Ensure Soft Delete columns exist
alter table public.words 
    add column if not exists deleted boolean default false,
    add column if not exists deleted_at timestamptz default null;

alter table public.sessions 
    add column if not exists deleted boolean default false,
    add column if not exists deleted_at timestamptz default null;

-- 3. Function: Consolidate History (Backfill)
-- Populates daily_stats from existing words for past dates.
create or replace function consolidate_daily_stats()
returns void
language plpgsql
security definer
as $$
begin
    insert into public.daily_stats (user_id, date, total, correct)
    select 
        user_id, 
        date(last_tested) as date,
        count(*) as total,
        count(case when correct then 1 end) as correct
    from public.words
    where last_tested is not null
    group by user_id, date(last_tested)
    on conflict (user_id, date) 
    do update set 
        total = excluded.total, 
        correct = excluded.correct;
end;
$$;

-- 4. Function: Sync Today's Stats
-- Calculates today's stats from the words table (including deleted/buffer words)
-- and updates the persistent daily_stats table.
create or replace function sync_todays_stats()
returns void
language plpgsql
security definer
as $$
declare
  v_user_id uuid;
  v_today date;
  v_total int;
  v_correct int;
begin
  v_user_id := auth.uid();
  v_today := current_date;

  -- Calculate fresh stats for today from words table (including deleted!)
  select 
    count(*),
    count(case when correct then 1 end)
  into v_total, v_correct
  from public.words
  where user_id = v_user_id
  and date(last_tested) = v_today;

  -- Upsert into daily_stats
  insert into public.daily_stats (user_id, date, total, correct)
  values (v_user_id, v_today, coalesce(v_total, 0), coalesce(v_correct, 0))
  on conflict (user_id, date)
  do update set
    total = excluded.total,
    correct = excluded.correct,
    updated_at = now();
end;
$$;

-- 5. Function: Cleanup Buffer
-- Permanently deletes words that are marked deleted AND were last tested before today.
-- If a deleted word was NEVER tested, it is also safe to delete.
create or replace function cleanup_buffer()
returns void
language plpgsql
security definer
as $$
begin
  -- Delete words: deleted AND (last_tested < today OR last_tested IS NULL)
  delete from public.words
  where user_id = auth.uid()
  and deleted = true
  and (last_tested is null or date(last_tested) < current_date);

  -- Delete sessions: deleted AND created_at < today
  delete from public.sessions
  where user_id = auth.uid()
  and deleted = true
  and date(created_at) < current_date;
end;
$$;

-- Run backfill immediately for existing data
select consolidate_daily_stats();
