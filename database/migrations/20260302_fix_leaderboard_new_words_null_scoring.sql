-- ================================================================
-- Migration: Fix Leaderboard NULL New Words Scoring
-- Date: 2026-03-02
-- ================================================================
-- Purpose:
-- - Enforce strict scoring for new_words component
-- - Prevent NULL from being treated as full score by LEAST()
--
-- Root cause:
-- - LEFT JOIN may produce n.new_words = NULL
-- - LEAST(NULL, 1.0) in PostgreSQL returns 1.0 (not NULL)
-- - This incorrectly granted full 200 points for users with 0 new words
--
-- Fix:
-- - Use COALESCE(n.new_words, 0) before normalization
-- - Apply fix to both real-time and historical initialization functions
-- ================================================================

-- ================================================================
-- Function: calculate_daily_leaderboard (strict new_words scoring)
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
    v_today := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::DATE;
    v_calc_date := COALESCE(p_date, v_today);

    IF v_calc_date > v_today THEN
        v_calc_date := v_today;
    END IF;

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
        (LEAST(d.total_count::NUMERIC / 100, 1.0) * 250) +
        (LEAST(COALESCE(n.new_words, 0)::NUMERIC / 20, 1.0) * 200) +
        (CASE WHEN d.total_count > 0
            THEN (d.correct_count::NUMERIC / d.total_count) * 300
            ELSE 0 END) +
        (LEAST(COALESCE(w.avg_error, 0)::NUMERIC / 3, 1.0) * 250) AS total_score,

        LEAST(d.total_count::NUMERIC / 100, 1.0) * 250 AS test_count_score,
        LEAST(COALESCE(n.new_words, 0)::NUMERIC / 20, 1.0) * 200 AS new_words_score,
        CASE WHEN d.total_count > 0
            THEN (d.correct_count::NUMERIC / d.total_count) * 300
            ELSE 0 END AS accuracy_score,
        LEAST(COALESCE(w.avg_error, 0)::NUMERIC / 3, 1.0) * 250 AS difficulty_score,

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
-- Function: initialize_leaderboard_history (strict new_words scoring)
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
    v_end_date := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::DATE - INTERVAL '1 day';

    SELECT MIN(date) INTO v_start_date
    FROM public.daily_stats
    WHERE total_count > 0;

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

    v_current_date := v_start_date;
    WHILE v_current_date <= v_end_date LOOP
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
            (LEAST(d.total_count::NUMERIC / 100, 1.0) * 250) +
            (LEAST(COALESCE(n.new_words, 0)::NUMERIC / 20, 1.0) * 200) +
            (CASE WHEN d.total_count > 0
                THEN (d.correct_count::NUMERIC / d.total_count) * 300
                ELSE 0 END) +
            (LEAST(COALESCE(w.avg_error, 0)::NUMERIC / 3, 1.0) * 250) AS total_score,

            LEAST(d.total_count::NUMERIC / 100, 1.0) * 250 AS test_count_score,
            LEAST(COALESCE(n.new_words, 0)::NUMERIC / 20, 1.0) * 200 AS new_words_score,
            CASE WHEN d.total_count > 0
                THEN (d.correct_count::NUMERIC / d.total_count) * 300
                ELSE 0 END AS accuracy_score,
            LEAST(COALESCE(w.avg_error, 0)::NUMERIC / 3, 1.0) * 250 AS difficulty_score,

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
            WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::DATE = v_current_date
                AND (deleted = false OR deleted IS NULL)
            GROUP BY user_id
        ) n ON d.user_id = n.user_id

        LEFT JOIN (
            SELECT
                user_id,
                AVG(error_count::NUMERIC) as avg_error
            FROM public.words
            WHERE (last_tested AT TIME ZONE 'Asia/Shanghai')::DATE = v_current_date
                AND (deleted = false OR deleted IS NULL)
                AND tested = true
            GROUP BY user_id
        ) w ON d.user_id = w.user_id

        WHERE d.date = v_current_date
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

        GET DIAGNOSTICS v_total_users = ROW_COUNT;
        v_days_count := v_days_count + 1;

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
