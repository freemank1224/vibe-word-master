-- Fix: Client-Side Timezone Driven Stats
-- Instead of hardcoding 'Asia/Shanghai' or guessing via IP (which is hard in Postgres),
-- we accept the client's local date as a parameter. The frontend knows best what "Today" is.

-- 1. Update the sync function to accept a date parameter
CREATE OR REPLACE FUNCTION sync_stats_for_date(p_local_date date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id uuid;
  v_total int;
  v_correct int;
  v_points numeric;
BEGIN
  v_user_id := auth.uid();
  
  -- Calculate stats for the SPECIFIED date
  -- We now match last_tested against the client-provided date.
  -- Important: We assume last_tested is stored in UTC. 
  -- To match correct local day, we need to know the offset, OR we simplify:
  -- Since 'last_tested' is set to now() when the user acts, 
  -- and the user says "it is 2026-01-27", then any action happening "now" belongs to that date.
  
  -- IMPROVED STRATEGY: 
  -- Instead of complex timezone math in DB, we aggregate words where 
  -- the time diff between 'last_tested' (UTC) and 'now' (UTC) is small (e.g. recent), 
  -- OR we trust the client logic.
  
  -- ACTUALLY, the Most Robust Way for a "Daily Tracker":
  -- The client is the source of truth for "What day is it?".
  -- When we sync, we calculate stats for words tested *recently* that logically belong to this "session".
  -- BUT for historical consistency, we stick to:
  -- "Aggregation by the Date String the Client Believes it is."

  -- However, querying "words tested on date X" inside DB requires knowing the timezone offset of X.
  -- Let's stick to the previous 'Asia/Shanghai' default within the DB for *automatic* jobs, 
  -- BUT allow the client to trigger a sync with an explicit timezone offset if needed.
  
  -- REVISED APPROACH FOR DYNAMIC TIMEZONE:
  -- We don't change the function signature to avoid breaking existing RPC calls if not necessary.
  -- But since we MUST support dynamic timezones, let's look at a simpler trick:
  -- We won't use this function for *reading* history (which is static).
  -- We use it for *writing* today's summary.
  
  -- Let's assume the client passes the "Date String" they want to update.
  -- But we also need to query the `words` table. 
  -- The `words` table has `last_tested` (TIMESTAMPTZ).
  
  -- Let's try a different angle: 
  -- The CLIENT updates the local stats. 
  -- The DB aggregation is just a backup.
  
  -- SOLUTION: Use a User-Settings table to store timezone? No, too heavy.
  -- SOLUTION: Pass the client's Timezone Offset (in hours) to the function.
END;
$$;

-- FINAL IMPLEMENTATION:
-- We replace the parameter-less `sync_todays_stats` with one that TAKES an offset.
-- e.g. If user is in China, offset = 8. If New York, offset = -5.

CREATE OR REPLACE FUNCTION sync_todays_stats_with_timezone(p_timezone_offset_hours int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id uuid;
  v_client_today date;
  v_total int;
  v_correct int;
  v_points numeric;
  v_interval interval;
BEGIN
  v_user_id := auth.uid();
  
  -- Construct the interval from the integer offset (e.g., 8 -> '8 hours')
  v_interval := (p_timezone_offset_hours || ' hours')::interval;

  -- 1. Determine "Today" based on the Client's Perspective
  -- UTC Now + Offset = Client Local Time. extraction of Date = Client Date.
  v_client_today := date(now() + v_interval);

  -- 2. Aggregate Words
  -- We group words into this day if their `last_tested` time, shifted by the SAME offset, falls on `v_client_today`.
  SELECT 
    count(*),
    count(CASE WHEN correct THEN 1 END),
    sum(
      CASE 
        WHEN score IS NOT NULL THEN score
        WHEN correct THEN 3 -- Legacy fallback
        ELSE 0 
      END
    )
  INTO v_total, v_correct, v_points
  FROM public.words
  WHERE user_id = v_user_id
  AND date(last_tested + v_interval) = v_client_today;

  -- 3. Upsert into daily_stats
  INSERT INTO public.daily_stats (user_id, date, total, correct, points)
  VALUES (v_user_id, v_client_today, coalesce(v_total, 0), coalesce(v_correct, 0), coalesce(v_points, 0))
  ON CONFLICT (user_id, date) 
  DO UPDATE SET 
    total = excluded.total, 
    correct = excluded.correct,
    points = excluded.points,
    updated_at = now();
END;
$$;

NOTIFY pgrst, 'reload schema';
