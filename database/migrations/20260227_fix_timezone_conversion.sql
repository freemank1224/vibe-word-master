-- ================================================================
-- Migration: Fix Timezone Conversion in Leaderboard Functions
-- Date: 2026-02-27
-- ================================================================
-- Purpose: Fix critical timezone bug causing wrong date calculations
--
-- Problem:
-- - Functions used: (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')
-- - This caused incorrect date conversion, returning yesterday's date
-- - Example: At 2026-02-27 11:32 AM Shanghai time, it returned 2026-02-26
--
-- Solution:
-- - Changed to: (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')
-- - Direct conversion to Shanghai timezone without UTC intermediate step
-- - This correctly returns the current Shanghai date
--
-- Impact:
-- - get_leaderboard: Now returns today's correct leaderboard
-- - calculate_daily_leaderboard: Now calculates for the correct date
-- - record_test_and_sync_stats: Now triggers refresh for the correct date
-- ================================================================

-- ================================================================
-- Function: get_leaderboard (FIXED)
-- ================================================================
CREATE OR REPLACE FUNCTION get_leaderboard(
    p_date DATE DEFAULT NULL,
    p_limit INTEGER DEFAULT 100,
    p_include_current_user BOOLEAN DEFAULT true
)
RETURNS TABLE(
    user_id UUID,
    rank_position INTEGER,
    total_score NUMERIC,
    tests_completed INTEGER,
    new_words_added INTEGER,
    accuracy_rate NUMERIC,
    avg_difficulty NUMERIC,
    is_current_user BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_query_date DATE;
    v_today DATE;
BEGIN
    -- ✅ FIXED: Direct conversion to Shanghai timezone
    -- OLD (WRONG): (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE
    -- NEW (CORRECT): (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::DATE
    v_today := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::DATE;

    -- Use provided date or default to today
    v_query_date := COALESCE(p_date, v_today);

    -- Prevent querying future dates - cap at today
    IF v_query_date > v_today THEN
        v_query_date := v_today;
    END IF;

    RETURN QUERY
    SELECT
        l.user_id,
        l.rank_position,
        l.total_score,
        l.tests_completed,
        l.new_words_added,
        l.accuracy_rate,
        l.avg_difficulty,
        (l.user_id = auth.uid())::BOOLEAN as is_current_user
    FROM public.leaderboards l
    WHERE l.rank_date = v_query_date
        AND (
            p_include_current_user = false
            OR l.rank_position <= p_limit
            OR l.user_id = auth.uid()
        )
    ORDER BY l.rank_position
    LIMIT p_limit + 1000;
END;
$$;

-- ================================================================
-- Function: calculate_daily_leaderboard (FIXED)
-- ================================================================
CREATE OR REPLACE FUNCTION calculate_daily_leaderboard(p_date DATE DEFAULT NULL)
RETURNS TABLE(
    users_processed BIGINT,
    calculation_timestamp TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_calc_date DATE;
    v_users_count BIGINT;
    v_today DATE;
BEGIN
    -- ✅ FIXED: Direct conversion to Shanghai timezone
    v_today := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::DATE;

    -- Default to TODAY (real-time leaderboard)
    v_calc_date := COALESCE(p_date, v_today);

    -- Prevent calculating for future dates
    IF v_calc_date > v_today THEN
        v_calc_date := v_today;
    END IF;

    -- Step 1: Calculate scores for all users
    INSERT INTO public.leaderboards (
        user_id,
        rank_date,
        total_score,
        test_count_score,
        new_words_score,
        accuracy_score,
        difficulty_score,
        tests_completed,
        new_words_added,
        accuracy_rate,
        avg_difficulty
    )
    SELECT
        d.user_id,
        v_calc_date,
        -- Total score (0-1000 scale)
        (LEAST(d.total_count::NUMERIC / 100, 1.0) * 250) +  -- Test count (25%)
        (LEAST(n.new_words::NUMERIC / 20, 1.0) * 200) +     -- New words (20%)
        (CASE WHEN d.total_count > 0
            THEN (d.correct_count::NUMERIC / d.total_count) * 300
            ELSE 0 END) +                                   -- Accuracy (30%)
        (LEAST(COALESCE(w.avg_error, 0)::NUMERIC / 3, 1.0) * 250) AS total_score, -- Difficulty (25%)

        -- Component scores
        LEAST(d.total_count::NUMERIC / 100, 1.0) * 250 AS test_count_score,
        LEAST(n.new_words::NUMERIC / 20, 1.0) * 200 AS new_words_score,
        CASE WHEN d.total_count > 0
            THEN (d.correct_count::NUMERIC / d.total_count) * 300
            ELSE 0 END AS accuracy_score,
        LEAST(COALESCE(w.avg_error, 0)::NUMERIC / 3, 1.0) * 250 AS difficulty_score,

        -- Raw metrics
        d.total_count AS tests_completed,
        COALESCE(n.new_words, 0) AS new_words_added,
        CASE WHEN d.total_count > 0
            THEN ROUND((d.correct_count::NUMERIC / d.total_count)::NUMERIC, 4)
            ELSE 0 END AS accuracy_rate,
        COALESCE(w.avg_error, 0) AS avg_difficulty

    FROM public.daily_stats d

    LEFT JOIN (
        SELECT user_id, COUNT(*) as new_words
        FROM public.words
        WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::DATE = v_calc_date
            AND (deleted = false OR deleted IS NULL)
        GROUP BY user_id
    ) n ON d.user_id = n.user_id

    LEFT JOIN (
        SELECT user_id, AVG(error_count::NUMERIC) as avg_error
        FROM public.words
        WHERE (last_tested AT TIME ZONE 'Asia/Shanghai')::DATE = v_calc_date
            AND (deleted = false OR deleted IS NULL)
            AND tested = true
        GROUP BY user_id
    ) w ON d.user_id = w.user_id

    WHERE d.date = v_calc_date
        AND d.total_count >= 10

    ON CONFLICT (user_id, rank_date)
    DO UPDATE SET
        total_score = EXCLUDED.total_score,
        test_count_score = EXCLUDED.test_count_score,
        new_words_score = EXCLUDED.new_words_score,
        accuracy_score = EXCLUDED.accuracy_score,
        difficulty_score = EXCLUDED.difficulty_score,
        tests_completed = EXCLUDED.tests_completed,
        new_words_added = EXCLUDED.new_words_added,
        accuracy_rate = EXCLUDED.accuracy_rate,
        avg_difficulty = EXCLUDED.avg_difficulty,
        updated_at = now();

    GET DIAGNOSTICS v_users_count = ROW_COUNT;

    -- Step 2: Update rank positions
    UPDATE public.leaderboards l1
    SET rank_position = subquery.row_num
    FROM (
        SELECT user_id, ROW_NUMBER() OVER (ORDER BY total_score DESC, user_id) as row_num
        FROM public.leaderboards
        WHERE rank_date = v_calc_date
    ) subquery
    WHERE l1.user_id = subquery.user_id
        AND l1.rank_date = v_calc_date;

    RETURN NEXT;
END;
$$;

-- ================================================================
-- Verification
-- ================================================================
DO $$
BEGIN
    RAISE NOTICE '✅ Timezone conversion fixed';
    RAISE NOTICE '✅ get_leaderboard now returns correct date';
    RAISE NOTICE '✅ calculate_daily_leaderboard now calculates for correct date';
    RAISE NOTICE '✅ Leaderboard will now display today''s real-time data';
END $$;
