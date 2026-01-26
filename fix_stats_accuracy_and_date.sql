-- Fix: Accurate Scoring & Timezone-Aware Stats
-- This patch fixes two critical issues:
-- 1. Accuracy Calculation: Treating NULL scores (legacy/migrated data) as full points if marked correct, preventing artificial drops in accuracy.
-- 2. Date Handling: Forcing China Standard Time (UTC+8) for day boundaries to ensure stats appear on the correct "local" day.

-- 1. Update the sync function to be timezone aware and robust against missing scores
CREATE OR REPLACE FUNCTION sync_todays_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id uuid;
  v_today date;
  v_total int;
  v_correct int;
  v_points numeric;
BEGIN
  v_user_id := auth.uid();
  
  -- FORCE TIMEZONE: Use Asia/Shanghai (UTC+8) for the definition of "Today"
  -- This ensures that if it's 1AM on the 27th in China, the date is 27th, even if UTC is still 26th.
  v_today := date(now() AT TIME ZONE 'Asia/Shanghai');

  -- Calculate fresh stats for today from words table
  -- We also convert last_tested to Asia/Shanghai to match the bucket day.
  SELECT 
    count(*),
    count(CASE WHEN correct THEN 1 END),
    -- ROBUST SCORE SUM: If score is NULL but correct is TRUE, assume 3 points (legacy fix).
    sum(
      CASE 
        WHEN score IS NOT NULL THEN score
        WHEN correct THEN 3 -- Fallback for legacy correct words without explicit score
        ELSE 0 
      END
    )
  INTO v_total, v_correct, v_points
  FROM public.words
  WHERE user_id = v_user_id
  AND date(last_tested AT TIME ZONE 'Asia/Shanghai') = v_today;

  -- Upsert into daily_stats
  INSERT INTO public.daily_stats (user_id, date, total, correct, points)
  VALUES (v_user_id, v_today, coalesce(v_total, 0), coalesce(v_correct, 0), coalesce(v_points, 0))
  ON CONFLICT (user_id, date) 
  DO UPDATE SET 
    total = excluded.total, 
    correct = excluded.correct,
    points = excluded.points,
    updated_at = now();
END;
$$;

-- 2. Backfill/Repair "Today's" stats immediately to fix the UI for the user
-- This runs the sync logic immediately for the current user (requires calling it via RPC, but declaring here just refreshes the function definition).
-- We can't easily iterate all users here, but the next action by any user will fix their stats.

NOTIFY pgrst, 'reload schema';
