-- ================================================================
-- Migration: Freeze Historical Stats
-- Purpose: Ensure past data is immutable - once a day ends,
--          the stats are frozen and never recalculated
-- ================================================================

-- Step 1: Freeze all historical data (before today)
-- This ensures all past days are permanently frozen
UPDATE public.daily_stats
SET is_frozen = true
WHERE date < (
    -- Today in Beijing Time (UTC+8)
    (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE
);

-- Step 2: Create function to auto-freeze previous day when stats are synced
CREATE OR REPLACE FUNCTION freeze_previous_days()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Freeze all days before today
    UPDATE public.daily_stats
    SET is_frozen = true, updated_at = now()
    WHERE date < (
        -- Today in Beijing Time (UTC+8)
        (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE
    )
    AND is_frozen = false;  -- Only update not-yet-frozen records

    RAISE NOTICE 'Froze % daily stats records', FOUND;
END;
$$;

-- Step 3: Update sync functions to call freeze automatically
CREATE OR REPLACE FUNCTION record_test_and_sync_stats(
    p_test_date DATE DEFAULT NULL,
    p_test_count INTEGER DEFAULT NULL,
    p_correct_count INTEGER DEFAULT NULL,
    p_points NUMERIC DEFAULT NULL,
    p_timezone_offset_hours INTEGER DEFAULT NULL
)
RETURNS TABLE(
    synced_date DATE,
    total_tests BIGINT,
    correct_tests BIGINT,
    total_points NUMERIC,
    unique_words BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_test_date DATE;
    v_test_count_val INTEGER;
    v_correct_count_val INTEGER;
    v_points_val NUMERIC;
    v_is_frozen BOOLEAN;
BEGIN
    -- Get current user ID
    v_user_id := auth.uid();

    -- Determine test date (using Beijing Time UTC+8)
    IF p_test_date IS NOT NULL THEN
        v_test_date := p_test_date;
    ELSE
        -- Calculate today's date in Beijing Time (UTC+8)
        v_test_date := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE;
    END IF;

    -- Get test parameters (with defaults)
    v_test_count_val := COALESCE(p_test_count, 0);
    v_correct_count_val := COALESCE(p_correct_count, 0);
    v_points_val := COALESCE(p_points, 0);

    -- CRITICAL: Check if this day is already frozen
    SELECT is_frozen INTO v_is_frozen
    FROM public.daily_stats
    WHERE user_id = v_user_id AND date = v_test_date;

    -- If frozen, DO NOT update - historical data is immutable!
    IF v_is_frozen = true THEN
        RAISE EXCEPTION 'Cannot modify frozen stats for date %', v_test_date
            USING HINT = 'This day has ended and its statistics are now frozen.';
    END IF;

    -- Step 1: Record this test session
    INSERT INTO public.daily_test_records (
        user_id, test_date, test_count, correct_count, points, timezone_offset
    ) VALUES (
        v_user_id, v_test_date, v_test_count_val, v_correct_count_val, v_points_val, p_timezone_offset_hours
    );

    -- Step 2: Calculate aggregated stats from test records
    -- This gives us ACCURATE incremental statistics
    INSERT INTO public.daily_stats (
        user_id, date, total_count, correct_count, total_points
    )
    SELECT
        v_user_id,
        v_test_date,
        SUM(test_count),                          -- Total tests (incremental)
        SUM(correct_count),                       -- Total correct (incremental)
        SUM(points)                               -- Total points (incremental)
    FROM public.daily_test_records
    WHERE user_id = v_user_id
        AND test_date = v_test_date
    ON CONFLICT (user_id, date)
    DO UPDATE SET
        total_count = EXCLUDED.total_count,
        correct_count = EXCLUDED.correct_count,
        total_points = EXCLUDED.total_points,
        updated_at = now()
    RETURNING
        daily_stats.date,
        daily_stats.total_count,
        daily_stats.correct_count,
        daily_stats.total_points
    INTO synced_date, total_tests, correct_tests, total_points;

    -- Step 3: Auto-freeze previous days after each sync
    -- This ensures yesterday is frozen when user tests today
    PERFORM freeze_previous_days();

    -- Step 4: Also calculate unique words for reference (using Beijing Time)
    SELECT COUNT(DISTINCT text)
    INTO unique_words
    FROM public.words
    WHERE user_id = v_user_id
        AND (last_tested AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE = v_test_date
        AND (deleted = false OR deleted IS NULL);

    RETURN NEXT;
END;
$$;

-- Step 4: Create manual freeze function for admin use
CREATE OR REPLACE FUNCTION freeze_all_past_days()
RETURNS TABLE(
    frozen_date DATE,
    records_frozen BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_today DATE;
BEGIN
    v_user_id := auth.uid();
    v_today := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE;

    -- Freeze all past days for current user
    UPDATE public.daily_stats
    SET is_frozen = true, updated_at = now()
    WHERE user_id = v_user_id
        AND date < v_today
        AND is_frozen = false
    RETURNING date, 1 INTO frozen_date, records_frozen;

    RETURN NEXT;
END;
$$;

-- Step 5: Execute initial freeze for all historical data
-- This runs immediately after migration to freeze all past days
SELECT freeze_previous_days();

-- ================================================================
-- Verification & Migration Notes
-- ================================================================
-- After applying this migration:
-- 1. All historical data (before today) is automatically frozen
-- 2. Each time stats are synced, previous days are auto-frozen
-- 3. Once frozen, stats CANNOT be modified by any sync operation
-- 4. Changing scoring rules in the future will NOT affect past frozen data
-- 5. Use SELECT freeze_all_past_days() to manually freeze if needed
-- ================================================================
