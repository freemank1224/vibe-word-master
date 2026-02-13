-- ================================================================
-- Migration: Update record_test_and_sync_stats with version control
-- Purpose: Implement optimistic locking and conflict detection
-- Date: 2025-02-14
-- Author: System (Phase B Implementation)
-- ================================================================

-- Drop the old function first
DROP FUNCTION IF EXISTS record_test_and_sync_stats(p_test_date DATE, p_client_date DATE, p_test_count INTEGER, p_correct_count INTEGER, p_points NUMERIC, p_timezone_offset_hours INTEGER);

-- Create new function with version control
CREATE FUNCTION record_test_and_sync_stats(
    p_test_date DATE DEFAULT NULL,
    p_client_date DATE DEFAULT NULL,
    p_test_count INTEGER DEFAULT NULL,
    p_correct_count INTEGER DEFAULT NULL,
    p_points NUMERIC DEFAULT NULL,
    p_timezone_offset_hours INTEGER DEFAULT NULL,
    p_expected_version BIGINT DEFAULT NULL  -- New: Expected version for optimistic locking
)
RETURNS TABLE(
    synced_date DATE,
    total_tests BIGINT,
    correct_tests BIGINT,
    total_points NUMERIC,
    unique_words BIGINT,
    version BIGINT,
    conflict_detected BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_test_date DATE;
    v_client_date DATE;
    v_test_count_val INTEGER;
    v_correct_count_val INTEGER;
    v_points_val NUMERIC;
    v_current_version BIGINT;
    v_new_version BIGINT;
    v_is_frozen BOOLEAN;
    v_conflict_detected BOOLEAN;
BEGIN
    -- Get current user ID
    v_user_id := auth.uid();

    -- Determine test date (Shanghai timezone)
    IF p_test_date IS NOT NULL THEN
        v_test_date := p_test_date;
    ELSE
        v_test_date := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE;
    END IF;

    v_client_date := p_client_date;

    -- Get test parameters
    v_test_count_val := COALESCE(p_test_count, 0);
    v_correct_count_val := COALESCE(p_correct_count, 0);
    v_points_val := COALESCE(p_points, 0);
    v_conflict_detected := FALSE;

    -- Get current version and frozen status
    SELECT is_frozen, version INTO v_is_frozen, v_current_version
    FROM public.daily_stats
    WHERE user_id = v_user_id AND date = v_test_date;

    -- Step 1: Check if date is frozen
    IF v_is_frozen = true THEN
        RAISE EXCEPTION 'Cannot modify frozen stats for date %', v_test_date
            USING HINT = 'This day has ended and its statistics are now frozen.';
    END IF;

    -- Step 2: Version conflict detection
    IF v_current_version IS NOT NULL AND p_expected_version IS NOT NULL THEN
        IF v_current_version != p_expected_version THEN
            -- Version conflict detected!
            v_conflict_detected := TRUE;

            -- Log conflict event
            INSERT INTO public.version_conflict_log (
                user_id, date, expected_version, actual_version, client_data
            ) VALUES (
                v_user_id, v_test_date, p_expected_version, v_current_version,
                jsonb_build_object(
                    'test_count', p_test_count,
                    'correct_count', p_correct_count,
                    'points', p_points
                )
            );

            -- Incremental update strategy (prevents data loss)
            UPDATE public.daily_stats
            SET
                total_count = daily_stats.total_count + p_test_count,
                correct_count = daily_stats.correct_count + p_correct_count,
                total_points = daily_stats.total_points + p_points,
                version = daily_stats.version + 1,
                updated_at = now()
            WHERE user_id = v_user_id AND date = v_test_date;

            -- Return merged state
            SELECT
                v_test_date,
                (daily_stats.total_count + p_test_count)::BIGINT,
                (daily_stats.correct_count + p_correct_count)::BIGINT,
                (daily_stats.total_points + p_points)::NUMERIC,
                (SELECT COUNT(DISTINCT text) FROM public.words
                 WHERE user_id = v_user_id
                   AND (last_tested AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE = v_test_date
                   AND (deleted = false OR deleted IS NULL))::BIGINT,
                (daily_stats.version + 1)::BIGINT,
                v_conflict_detected
            INTO synced_date, total_tests, correct_tests, total_points, unique_words, version, v_conflict_detected
            FROM public.daily_stats
            WHERE user_id = v_user_id AND date = v_test_date;

            RETURN NEXT;
        END IF;
    END IF;

    -- Step 3: Normal flow (no conflict)
    -- Insert test record
    INSERT INTO public.daily_test_records (
        user_id, test_date, test_count, correct_count, points, timezone_offset
    ) VALUES (
        v_user_id, v_test_date, v_test_count_val, v_correct_count_val, v_points_val, p_timezone_offset_hours
    );

    -- Aggregate statistics (full recalculation from test records)
    INSERT INTO public.daily_stats (
        user_id, date, total_count, correct_count, total_points
    )
    SELECT
        v_user_id,
        v_test_date,
        SUM(test_count),
        SUM(correct_count),
        SUM(points)
    FROM public.daily_test_records
    WHERE user_id = v_user_id AND test_date = v_test_date
    ON CONFLICT (user_id, date) DO UPDATE SET
        total_count = EXCLUDED.total_count,
        correct_count = EXCLUDED.correct_count,
        total_points = EXCLUDED.total_points,
        version = daily_stats.version + 1,
        updated_at = now()
    RETURNING
        daily_stats.date,
        daily_stats.total_count,
        daily_stats.correct_count,
        daily_stats.total_points
    INTO synced_date, total_tests, correct_tests, total_points;

    -- Calculate unique words
    SELECT COUNT(DISTINCT text)
    INTO unique_words
    FROM public.words
    WHERE user_id = v_user_id
        AND (last_tested AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE = v_test_date
        AND (deleted = false OR deleted IS NULL);

    -- Return result (no conflict)
    SELECT
        synced_date,
        total_tests,
        correct_tests,
        total_points,
        unique_words,
        COALESCE(v_current_version, 0) + 1,
        v_conflict_detected
    INTO synced_date, total_tests, correct_tests, total_points, unique_words, version, v_conflict_detected;

    RETURN NEXT;
END;
$$;

-- ================================================================
-- Testing checklist:
-- [ ] Test normal flow (no conflict)
-- [ ] Test concurrent updates (version mismatch)
-- [ ] Verify conflict log entries created
-- [ ] Verify incremental merge prevents data loss
-- [ ] Test with frozen stats
-- ================================================================
