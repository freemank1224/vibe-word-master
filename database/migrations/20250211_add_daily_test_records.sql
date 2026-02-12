-- ================================================================
-- Migration: Add Daily Test Records Table
-- ================================================================
-- Purpose: Support incremental statistics calculation
-- This table records each test session, enabling accurate aggregation
-- NOTE: All dates are calculated using Beijing Time (UTC+8)
-- ================================================================

-- Create daily_test_records table
CREATE TABLE IF NOT EXISTS public.daily_test_records (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL,
    test_date DATE NOT NULL,
    test_count INTEGER NOT NULL,           -- Number of words in this test
    correct_count INTEGER NOT NULL,        -- Number of correct answers in this test
    points NUMERIC NOT NULL,               -- Points earned in this test
    timezone_offset INTEGER,               -- User's timezone offset in hours (for reference)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),

    -- Foreign Keys
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- Enable RLS
ALTER TABLE public.daily_test_records ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DROP POLICY IF EXISTS "Users can view their own test records" ON public.daily_test_records;
CREATE POLICY "Users can view their own test records"
    ON public.daily_test_records FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own test records" ON public.daily_test_records;
CREATE POLICY "Users can insert their own test records"
    ON public.daily_test_records FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS daily_test_records_user_id_idx ON public.daily_test_records(user_id);
CREATE INDEX IF NOT EXISTS daily_test_records_test_date_idx ON public.daily_test_records(test_date);
CREATE INDEX IF NOT EXISTS daily_test_records_user_date_idx ON public.daily_test_records(user_id, test_date);

-- ================================================================
-- Updated RPC Function: Record Test and Sync Stats (Incremental)
-- Uses Beijing Time (UTC+8) for all date calculations
-- ================================================================
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

    -- Step 3: Also calculate unique words for reference (using Beijing Time)
    SELECT COUNT(DISTINCT text)
    INTO unique_words
    FROM public.words
    WHERE user_id = v_user_id
        AND (last_tested AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE = v_test_date
        AND (deleted = false OR deleted IS NULL);

    RETURN NEXT;
END;
$$;

-- ================================================================
-- Updated RPC Function: Get Today's Stats (Aggregated from records)
-- Uses Beijing Time (UTC+8) for all date calculations
-- ================================================================
CREATE OR REPLACE FUNCTION get_todays_stats(p_timezone_offset_hours INTEGER DEFAULT NULL)
RETURNS TABLE(
    test_date DATE,
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
    v_today DATE;
BEGIN
    -- Get current user ID
    v_user_id := auth.uid();

    -- Calculate today's date in Beijing Time (UTC+8)
    v_today := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE;

    -- Get aggregated stats from test records
    SELECT
        v_today,
        COALESCE(SUM(r.test_count), 0)::BIGINT,
        COALESCE(SUM(r.correct_count), 0)::BIGINT,
        COALESCE(SUM(r.points), 0)::NUMERIC,
        (SELECT COUNT(DISTINCT w.text)
         FROM public.words w
         WHERE w.user_id = v_user_id
            AND (w.last_tested AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE = v_today
            AND (w.deleted = false OR w.deleted IS NULL)
        )::BIGINT
    INTO test_date, total_tests, correct_tests, total_points, unique_words
    FROM public.daily_test_records r
    WHERE r.user_id = v_user_id
        AND r.test_date = v_today;

    RETURN NEXT;
END;
$$;

-- ================================================================
-- Helper Function: Recalculate Historical Stats
-- Uses Beijing Time (UTC+8) for all date calculations
-- ================================================================
-- Run this once after migration to backfill historical data from words table
CREATE OR REPLACE FUNCTION backfill_daily_stats_from_words(
    p_start_date DATE DEFAULT NULL,
    p_end_date DATE DEFAULT NULL
)
RETURNS TABLE(
    processed_date DATE,
    records_processed BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_date DATE;
    v_start_date DATE;
    v_end_date DATE;
    v_word_count INTEGER;
    v_correct_count INTEGER;
    v_points NUMERIC;
BEGIN
    v_user_id := auth.uid();

    -- Default to last 30 days if not specified
    v_start_date := COALESCE(p_start_date, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE - INTERVAL '30 days');
    v_end_date := COALESCE(p_end_date, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE);

    -- Loop through each date
    FOR v_date IN
        SELECT generate_series(v_start_date, v_end_date, INTERVAL '1 day')::DATE
    LOOP
        -- Calculate stats from words table (for historical data, using Beijing Time)
        SELECT
            COUNT(*),
            COUNT(*) FILTER (WHERE correct = true),
            COALESCE(SUM(score), 0)
        INTO v_word_count, v_correct_count, v_points
        FROM public.words
        WHERE user_id = v_user_id
            AND (last_tested AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE = v_date
            AND (deleted = false OR deleted IS NULL);

        -- Only insert if there's data
        IF v_word_count > 0 THEN
            -- Check if record already exists
            IF NOT EXISTS (
                SELECT 1 FROM public.daily_test_records
                WHERE user_id = v_user_id AND test_date = v_date
            ) THEN
                -- Insert as a single historical record
                INSERT INTO public.daily_test_records (
                    user_id, test_date, test_count, correct_count, points, timezone_offset
                ) VALUES (
                    v_user_id, v_date, v_word_count, v_correct_count, v_points, 8
                );

                -- Update daily_stats
                INSERT INTO public.daily_stats (
                    user_id, date, total_count, correct_count, total_points
                ) VALUES (
                    v_user_id, v_date, v_word_count, v_correct_count, v_points
                )
                ON CONFLICT (user_id, date) DO NOTHING;

                processed_date := v_date;
                records_processed := 1;
                RETURN NEXT;
            END IF;
        END IF;
    END LOOP;
END;
$$;

-- ================================================================
-- Verification & Migration Notes
-- ================================================================
-- After applying this migration:
-- 1. New tests will be recorded in daily_test_records
-- 2. Stats will be calculated incrementally from test records
-- 3. All dates use Beijing Time (UTC+8) via 'Asia/Shanghai' timezone
-- 4. To backfill historical data, run: SELECT * FROM backfill_daily_stats_from_words();
-- 5. Old sync_todays_stats_with_timezone function is kept for compatibility
-- ================================================================
