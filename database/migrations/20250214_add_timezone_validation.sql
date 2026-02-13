-- ================================================================
-- Migration: Add timezone validation for stats sync
-- Date: 2025-02-14
-- Purpose: Ensure client and server use consistent timezone
-- ================================================================

CREATE OR REPLACE FUNCTION record_test_and_sync_stats(
    p_test_date DATE DEFAULT NULL,
    p_client_date DATE DEFAULT NULL,
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
    unique_words BIGINT,
    date_mismatch BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS \$\$
DECLARE
    v_user_id UUID;
    v_test_date DATE;
    v_client_date DATE;
    v_test_count_val INTEGER;
    v_correct_count_val INTEGER;
    v_points_val NUMERIC;
    v_date_mismatch BOOLEAN;
BEGIN
    v_user_id := auth.uid();

    IF p_test_date IS NOT NULL THEN
        v_test_date := p_test_date;
    ELSE
        v_test_date := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE;
    END IF;

    v_client_date := p_client_date;

    v_test_count_val := COALESCE(p_test_count, 0);
    v_correct_count_val := COALESCE(p_correct_count, 0);
    v_points_val := COALESCE(p_points, 0);

    v_date_mismatch := (v_client_date IS NOT NULL AND v_client_date <> v_test_date);

    IF v_date_mismatch THEN
        RAISE WARNING 'Date mismatch: client %, server %', v_client_date, v_test_date;
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
        SUM(test_count),
        SUM(correct_count),
        SUM(points)
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

    PERFORM freeze_previous_days();

    SELECT COUNT(DISTINCT text)
    INTO unique_words
    FROM public.words
    WHERE user_id = v_user_id
        AND (last_tested AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE = v_test_date
        AND (deleted = false OR deleted IS NULL);

    RETURN NEXT;
END;
\$\$;

CREATE TABLE IF NOT EXISTS public.timezone_mismatch_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    client_date DATE NOT NULL,
    server_date DATE NOT NULL,
    test_count INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS timezone_mismatch_log_user_id_idx
ON public.timezone_mismatch_log(user_id, created_at DESC);
