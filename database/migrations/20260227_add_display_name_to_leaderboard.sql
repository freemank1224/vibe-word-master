-- ================================================================
-- Migration: Add display_name to get_leaderboard Function
-- Date: 2026-02-27
-- ================================================================
-- Purpose: Fix missing display_name field in leaderboard query
--
-- Problem:
-- - Frontend LeaderboardPanel component expects display_name field
-- - get_leaderboard function was not returning this field
-- - Result: User names appeared empty in the UI
--
-- Solution:
-- - Added display_name TEXT field to RETURNS TABLE
-- - Generate masked display name from email for privacy
-- - Format: "abc****@example.com" (first 3 chars + **** + domain)
--
-- Examples:
-- - dysonfreeman@outlook.com → dys****@outlook.com
-- - sps_zhanggy@ujn.edu.cn → sps****@ujn.edu.cn
-- ================================================================

-- Drop and recreate function with display_name field
DROP FUNCTION IF EXISTS public.get_leaderboard(p_date DATE, p_limit INTEGER, p_include_current_user BOOLEAN) CASCADE;

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
    is_current_user BOOLEAN,
    display_name TEXT
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
        (l.user_id = auth.uid())::BOOLEAN as is_current_user,
        -- Generate masked display name from email for privacy
        CASE
            WHEN POSITION('@' IN u.email) > 0 THEN
                SUBSTRING(u.email FROM 1 FOR 3) || '****' || SUBSTRING(u.email FROM POSITION('@' IN u.email))
            ELSE
                LEFT(u.email, 3) || '****'
        END as display_name
    FROM public.leaderboards l
    JOIN auth.users u ON l.user_id = u.id
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

-- Grant permissions
GRANT EXECUTE ON FUNCTION public.get_leaderboard TO authenticated;

-- ================================================================
-- Verification
-- ================================================================
DO $$
BEGIN
    RAISE NOTICE '✅ display_name field added to get_leaderboard';
    RAISE NOTICE '✅ User names will now display in leaderboard';
    RAISE NOTICE '✅ Format: first 3 chars + **** + domain';
END $$;
