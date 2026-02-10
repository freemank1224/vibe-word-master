-- Migration: Add Scoring System to Stats
-- This allows calculating accuracy based on the "agreed scores" (3 for direct, 2.4 for hint).

-- 1. Add score column to words table to store the result of the last test
ALTER TABLE public.words 
ADD COLUMN IF NOT EXISTS score NUMERIC DEFAULT NULL;

-- 2. Add points column to daily_stats table for aggregated daily performance
ALTER TABLE public.daily_stats 
ADD COLUMN IF NOT EXISTS points NUMERIC DEFAULT 0;

-- 3. Update the sync function to include points aggregation
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
  v_today := current_date;

  -- Calculate fresh stats for today from words table (including deleted/buffer words)
  SELECT 
    count(*),
    count(CASE WHEN correct THEN 1 END),
    sum(coalesce(score, 0))
  INTO v_total, v_correct, v_points
  FROM public.words
  WHERE user_id = v_user_id
  AND date(last_tested) = v_today;

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

-- 4. Initial backfill for points (optional but recommended)
-- This assumes all existing 'correct' words get 3 points.
UPDATE public.daily_stats 
SET points = correct * 3 
WHERE points = 0 AND correct > 0;

NOTIFY pgrst, 'reload schema';
