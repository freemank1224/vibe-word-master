-- ================================================================
-- Migration: Initialize Leaderboard History
-- Date: 2026-02-26
-- ================================================================
-- Purpose: One-time initialization of historical leaderboard data
-- This script backfills leaderboard rankings for all historical dates
-- from the first user activity to yesterday
-- ================================================================

-- ================================================================
-- Function: initialize_leaderboard_history
-- ================================================================
-- Backfills leaderboard data for all historical dates
-- Should be run once as part of initial setup
-- ================================================================
CREATE OR REPLACE FUNCTION initialize_leaderboard_history()
RETURNS TABLE(
    start_date DATE,
    end_date DATE,
    days_processed BIGINT,
    total_users_processed BIGINT,
    processing_time INTERVAL
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_start_date DATE;
    v_end_date DATE;
    v_current_date DATE;
    v_days_count BIGINT;
    v_total_users BIGINT;
    v_start_time TIMESTAMP WITH TIME ZONE;
    v_result RECORD;
BEGIN
    -- Get today's date in Shanghai timezone
    v_end_date := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE - INTERVAL '1 day';

    -- Find the earliest date with user activity
    SELECT MIN(date) INTO v_start_date
    FROM public.daily_stats
    WHERE total_count > 0;

    -- If no data exists, return empty result
    IF v_start_date IS NULL THEN
        RAISE NOTICE 'No historical data found to initialize';
        RETURN QUERY
        SELECT NULL::DATE, NULL::DATE, 0::BIGINT, 0::BIGINT, INTERVAL '0';
        RETURN;
    END IF;

    v_start_time := now();
    v_days_count := 0;
    v_total_users := 0;

    RAISE NOTICE 'Initializing leaderboard history from % to %', v_start_date, v_end_date;

    -- Loop through each date from start to end
    v_current_date := v_start_date;
    WHILE v_current_date <= v_end_date LOOP
        -- Calculate leaderboard for this date
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
            v_current_date,
            -- Total score (0-1000 scale)
            (LEAST(d.total_count::NUMERIC / 100, 1.0) * 250) +  -- Test count (25%)
            (LEAST(n.new_words::NUMERIC / 20, 1.0) * 200) +     -- New words (20%)
            (CASE WHEN d.total_count > 0
                THEN (d.correct_count::NUMERIC / d.total_count) * 300
                ELSE 0 END) +                                   -- Accuracy (30%)
            (LEAST(COALESCE(w.avg_error, 0)::NUMERIC / 3, 1.0) * 250) AS total_score, -- Difficulty (25%)

            -- Component scores (for display)
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

        -- Join new words count
        LEFT JOIN (
            SELECT user_id, COUNT(*) as new_words
            FROM public.words
            WHERE (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE = v_current_date
                AND (deleted = false OR deleted IS NULL)
            GROUP BY user_id
        ) n ON d.user_id = n.user_id

        -- Join average difficulty
        LEFT JOIN (
            SELECT
                user_id,
                AVG(error_count::NUMERIC) as avg_error
            FROM public.words
            WHERE (last_tested AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE = v_current_date
                AND (deleted = false OR deleted IS NULL)
                AND tested = true
            GROUP BY user_id
        ) w ON d.user_id = w.user_id

        WHERE d.date = v_current_date
            AND d.total_count >= 10  -- Minimum qualification threshold

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

        GET DIAGNOSTICS v_total_users = ROW_COUNT;
        v_days_count := v_days_count + 1;

        -- Update rank positions for this date
        UPDATE public.leaderboards l1
        SET rank_position = subquery.row_num
        FROM (
            SELECT
                user_id,
                ROW_NUMBER() OVER (ORDER BY total_score DESC, user_id) as row_num
            FROM public.leaderboards
            WHERE rank_date = v_current_date
        ) subquery
        WHERE l1.user_id = subquery.user_id
            AND l1.rank_date = v_current_date;

        RAISE NOTICE 'Processed date: % (users: %)', v_current_date, v_total_users;

        -- Move to next date
        v_current_date := v_current_date + INTERVAL '1 day';
    END LOOP;

    RETURN QUERY
    SELECT
        v_start_date as start_date,
        v_end_date as end_date,
        v_days_count as days_processed,
        v_total_users as total_users_processed,
        now() - v_start_time as processing_time;
END;
$$;

-- ================================================================
-- Grant necessary permissions
-- ================================================================
GRANT EXECUTE ON FUNCTION initialize_leaderboard_history TO service_role;

-- ================================================================
-- Usage Instructions
-- ================================================================
-- To initialize historical leaderboard data, run:
--
-- SELECT * FROM initialize_leaderboard_history();
--
-- This will:
-- 1. Find the earliest date with user activity in daily_stats
-- 2. Calculate leaderboard rankings for each date from then to yesterday
-- 3. Store all historical rankings in the leaderboards table
-- 4. Return summary statistics (dates processed, time taken)
--
-- WARNING: This may take several minutes depending on data volume
-- ================================================================
