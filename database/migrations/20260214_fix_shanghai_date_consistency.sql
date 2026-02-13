-- ================================================================
-- Migration: Fix Shanghai date consistency in freeze/stat RPC
-- Date: 2026-02-14
-- Purpose:
--   1) Use one consistent Shanghai-date expression everywhere
--   2) Re-apply function definitions for environments already migrated
-- ================================================================

CREATE OR REPLACE FUNCTION freeze_previous_days()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE public.daily_stats
    SET is_frozen = true,
        updated_at = now()
    WHERE date < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::DATE
      AND COALESCE(is_frozen, false) = false;
END;
$$;

DROP FUNCTION IF EXISTS record_test_and_sync_stats(
    p_test_date DATE,
    p_client_date DATE,
    p_test_count INTEGER,
    p_correct_count INTEGER,
    p_points NUMERIC,
    p_timezone_offset_hours INTEGER,
    p_expected_version BIGINT
);

CREATE FUNCTION record_test_and_sync_stats(
    p_test_date DATE DEFAULT NULL,
    p_client_date DATE DEFAULT NULL,
    p_test_count INTEGER DEFAULT NULL,
    p_correct_count INTEGER DEFAULT NULL,
    p_points NUMERIC DEFAULT NULL,
    p_timezone_offset_hours INTEGER DEFAULT NULL,
    p_expected_version BIGINT DEFAULT NULL
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
    v_today DATE;
    v_test_date DATE;
    v_test_count_val INTEGER;
    v_correct_count_val INTEGER;
    v_points_val NUMERIC;
    v_current_version BIGINT;
    v_is_frozen BOOLEAN;
    v_conflict_detected BOOLEAN;
BEGIN
    v_user_id := auth.uid();
    v_today := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::DATE;

    PERFORM freeze_previous_days();

    IF p_test_date IS NOT NULL THEN
        v_test_date := p_test_date;
    ELSE
        v_test_date := v_today;
    END IF;

    IF v_test_date < v_today THEN
        RAISE EXCEPTION 'Cannot modify historical stats for date %', v_test_date
            USING HINT = 'Historical data is frozen. Only today''s stats are writable.';
    END IF;

    IF v_test_date > v_today THEN
        RAISE EXCEPTION 'Cannot modify future stats for date %', v_test_date
            USING HINT = 'Only today''s stats are writable.';
    END IF;

    v_test_count_val := COALESCE(p_test_count, 0);
    v_correct_count_val := COALESCE(p_correct_count, 0);
    v_points_val := COALESCE(p_points, 0);
    v_conflict_detected := FALSE;

    SELECT daily_stats.is_frozen, daily_stats.version
    INTO v_is_frozen, v_current_version
    FROM public.daily_stats
    WHERE user_id = v_user_id AND date = v_test_date;

    IF v_is_frozen = true THEN
        RAISE EXCEPTION 'Cannot modify frozen stats for date %', v_test_date
            USING HINT = 'This day has ended and its statistics are now frozen.';
    END IF;

    IF v_current_version IS NOT NULL AND p_expected_version IS NOT NULL THEN
        IF v_current_version != p_expected_version THEN
            v_conflict_detected := TRUE;

            INSERT INTO public.version_conflict_log (
                user_id, date, expected_version, actual_version, client_data
            ) VALUES (
                v_user_id, v_test_date, p_expected_version, v_current_version,
                jsonb_build_object(
                    'test_count', v_test_count_val,
                    'correct_count', v_correct_count_val,
                    'points', v_points_val,
                    'client_date', p_client_date
                )
            );

            UPDATE public.daily_stats
            SET
                total_count = daily_stats.total_count + v_test_count_val,
                correct_count = daily_stats.correct_count + v_correct_count_val,
                total_points = daily_stats.total_points + v_points_val,
                version = daily_stats.version + 1,
                updated_at = now()
            WHERE user_id = v_user_id AND date = v_test_date;

            SELECT
                daily_stats.date,
                daily_stats.total_count::BIGINT,
                daily_stats.correct_count::BIGINT,
                daily_stats.total_points::NUMERIC,
                (SELECT COUNT(DISTINCT text)
                 FROM public.words
                 WHERE user_id = v_user_id
                   AND (last_tested AT TIME ZONE 'Asia/Shanghai')::DATE = v_test_date
                   AND (deleted = false OR deleted IS NULL))::BIGINT,
                daily_stats.version::BIGINT,
                v_conflict_detected
            INTO synced_date, total_tests, correct_tests, total_points, unique_words, version, conflict_detected
            FROM public.daily_stats
            WHERE user_id = v_user_id AND date = v_test_date;

            RETURN NEXT;
        END IF;
    END IF;

    INSERT INTO public.daily_test_records (
        user_id, test_date, test_count, correct_count, points, timezone_offset
    ) VALUES (
        v_user_id, v_test_date, v_test_count_val, v_correct_count_val, v_points_val, p_timezone_offset_hours
    );

    INSERT INTO public.daily_stats (
        user_id, date, total_count, correct_count, total_points
    )
    SELECT
        v_user_id,
        v_test_date,
        SUM(daily_test_records.test_count),
        SUM(daily_test_records.correct_count),
        SUM(daily_test_records.points)
    FROM public.daily_test_records
    WHERE user_id = v_user_id
      AND test_date = v_test_date
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
        daily_stats.total_points,
        daily_stats.version
    INTO synced_date, total_tests, correct_tests, total_points, version;

    SELECT COUNT(DISTINCT text)
    INTO unique_words
    FROM public.words
    WHERE user_id = v_user_id
      AND (last_tested AT TIME ZONE 'Asia/Shanghai')::DATE = v_test_date
      AND (deleted = false OR deleted IS NULL);

    conflict_detected := FALSE;

    PERFORM freeze_previous_days();

    RETURN NEXT;
END;
$$;

SELECT freeze_previous_days();
