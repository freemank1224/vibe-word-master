-- ================================================================
-- Migration: Add Leaderboards Table
-- Date: 2026-02-26
-- ================================================================
-- Purpose: Daily ranking system for all users
-- All dates use Beijing Time (UTC+8)
-- ================================================================

-- ================================================================
-- Table: leaderboards
-- ================================================================
-- Stores daily leaderboard entries for all users
-- stores calculated scores and raw metrics for ranking
CREATE TABLE IF NOT EXISTS public.leaderboards (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL,
    rank_date DATE NOT NULL,

    -- Calculated scores (0-1000 scale)
    total_score NUMERIC NOT NULL,
    test_count_score NUMERIC NOT NULL,
    new_words_score NUMERIC NOT NULL,
    accuracy_score NUMERIC NOT NULL,
    difficulty_score NUMERIC NOT NULL,

    -- Raw metrics for display
    tests_completed INTEGER NOT NULL,
    new_words_added INTEGER NOT NULL,
    accuracy_rate NUMERIC NOT NULL,
    avg_difficulty NUMERIC NOT NULL,

    -- Ranking position (calculated after all users processed)
    rank_position INTEGER,

    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),

    -- Foreign Keys & Constraints
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
    UNIQUE(user_id, rank_date)
);

-- Enable RLS
ALTER TABLE public.leaderboards ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Public read access - all users can view leaderboards
DROP POLICY IF EXISTS "Users can view leaderboards" ON public.leaderboards;
CREATE POLICY "Users can view leaderboards"
    ON public.leaderboards FOR SELECT
    USING (true);

-- No INSERT policy - only Edge Function with service role key can write
DROP POLICY IF EXISTS "Leaders can insert leaderboards" ON public.leaderboards;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS leaderboards_rank_date_idx ON public.leaderboards(rank_date);
CREATE INDEX IF NOT EXISTS leaderboards_user_id_idx ON public.leaderboards(user_id);
CREATE INDEX IF NOT EXISTS leaderboards_rank_position_idx ON public.leaderboards(rank_date, rank_position);
CREATE INDEX IF NOT EXISTS leaderboards_total_score_idx ON public.leaderboards(rank_date, total_score DESC);

-- ================================================================
-- Function: calculate_daily_leaderboard
-- ================================================================
-- This function:
-- 1. Calculates scores for all users for a given date
-- 2. Inserts/updates leaderboards table
-- 3. Updates rank positions
--
-- Scoring formula (from config/wordLearningConfig.ts):
-- - Test count (25%): min(testCount / 100, 1.0) * 250
-- - New words (20%): min(newWords / 20, 1.0) * 200
-- - Accuracy (30%): (correctCount / testCount) * 300
-- - Difficulty (25%): min(avgErrorCount / 3, 1.0) * 250
-- Total: 0-1000 scale
--
-- Usage:
-- - No parameter: Calculates TODAY's real-time leaderboard
-- - With date: Calculates leaderboard for specific date (historical only)
--
-- Called by Edge Function or cron job
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
    -- Get today's date in Shanghai timezone
    v_today := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE;

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
        WHERE (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE = v_calc_date
            AND (deleted = false OR deleted IS NULL)
        GROUP BY user_id
    ) n ON d.user_id = n.user_id

    -- Join average difficulty
    LEFT JOIN (
        SELECT
            user_id,
            AVG(error_count::NUMERIC) as avg_error
        FROM public.words
        WHERE (last_tested AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE = v_calc_date
            AND (deleted = false OR deleted IS NULL)
            AND tested = true
        GROUP BY user_id
    ) w ON d.user_id = w.user_id

    WHERE d.date = v_calc_date
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

    GET DIAGNOSTICS v_users_count = ROW_COUNT;

    -- Step 2: Update rank positions
    UPDATE public.leaderboards l1
    SET rank_position = subquery.row_num
    FROM (
        SELECT
            user_id,
            ROW_NUMBER() OVER (ORDER BY total_score DESC, user_id) as row_num
        FROM public.leaderboards
        WHERE rank_date = v_calc_date
    ) subquery
    WHERE l1.user_id = subquery.user_id
        AND l1.rank_date = v_calc_date;

    RETURN NEXT;
END;
$$;

-- ================================================================
-- Function: get_leaderboard
-- ================================================================
-- Returns leaderboard for a specific date
-- Always includes current user even if not in top N
-- Blocks future dates - cannot query rankings beyond today
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
    -- Get today's date in Shanghai timezone
    v_today := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE;

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
    LIMIT p_limit + 1000; -- Extra buffer for current user inclusion
END;
$$;

-- ================================================================
-- Function: get_user_rank_history
-- ================================================================
-- Returns user's ranking trend over time
-- Includes percentile calculation
-- ================================================================
CREATE OR REPLACE FUNCTION get_user_rank_history(
    p_user_id UUID DEFAULT NULL,
    p_days INTEGER DEFAULT 30
)
RETURNS TABLE(
    rank_date DATE,
    rank_position INTEGER,
    total_score NUMERIC,
    percentile INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_target_user UUID;
BEGIN
    v_target_user := COALESCE(p_user_id, auth.uid());

    RETURN QUERY
    SELECT
        l.rank_date,
        l.rank_position,
        l.total_score,
        -- Calculate percentile (100 = top, 0 = bottom)
        CASE
            WHEN (SELECT COUNT(*) FROM public.leaderboards WHERE rank_date = l.rank_date) > 0
            THEN ROUND(
                ((SELECT COUNT(*) FROM public.leaderboards WHERE rank_date = l.rank_date AND total_score < l.total_score)::NUMERIC /
                (SELECT COUNT(*) FROM public.leaderboards WHERE rank_date = l.rank_date)::NUMERIC) * 100
            )::INTEGER
            ELSE 0
        END as percentile
    FROM public.leaderboards l
    WHERE l.user_id = v_target_user
        AND l.rank_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE - (p_days || ' days')::INTERVAL
    ORDER BY l.rank_date DESC;
END;
$$;

-- ================================================================
-- Function: get_current_user_ranking
-- ================================================================
-- Quick lookup for current user's ranking on a specific date
-- Blocks future dates - cannot query rankings beyond today
-- ================================================================
CREATE OR REPLACE FUNCTION get_current_user_ranking(p_date DATE DEFAULT NULL)
RETURNS TABLE(
    rank_date DATE,
    rank_position INTEGER,
    total_score NUMERIC,
    percentile INTEGER,
    tests_completed INTEGER,
    new_words_added INTEGER,
    accuracy_rate NUMERIC,
    avg_difficulty NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_query_date DATE;
    v_today DATE;
BEGIN
    -- Get today's date in Shanghai timezone
    v_today := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE;

    -- Use provided date or default to today
    v_query_date := COALESCE(p_date, v_today);

    -- Prevent querying future dates - cap at today
    IF v_query_date > v_today THEN
        v_query_date := v_today;
    END IF;

    RETURN QUERY
    SELECT
        l.rank_date,
        l.rank_position,
        l.total_score,
        -- Calculate percentile
        CASE
            WHEN (SELECT COUNT(*) FROM public.leaderboards WHERE rank_date = l.rank_date) > 0
            THEN ROUND(
                ((SELECT COUNT(*) FROM public.leaderboards WHERE rank_date = l.rank_date AND total_score < l.total_score)::NUMERIC /
                (SELECT COUNT(*) FROM public.leaderboards WHERE rank_date = l.rank_date)::NUMERIC) * 100
            )::INTEGER
            ELSE NULL
        END as percentile,
        l.tests_completed,
        l.new_words_added,
        l.accuracy_rate,
        l.avg_difficulty
    FROM public.leaderboards l
    WHERE l.user_id = auth.uid()
        AND l.rank_date = v_query_date;
END;
$$;

-- ================================================================
-- Grant necessary permissions
-- ================================================================
-- Grant execute on functions to authenticated users
GRANT EXECUTE ON FUNCTION calculate_daily_leaderboard TO service_role;
GRANT EXECUTE ON FUNCTION get_leaderboard TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_rank_history TO authenticated;
GRANT EXECUTE ON FUNCTION get_current_user_ranking TO authenticated;

-- Grant select on leaderboards table
GRANT SELECT ON public.leaderboards TO authenticated;
