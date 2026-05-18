-- ================================================================
-- Migration: Show custom username in leaderboard
-- Date: 2026-05-16
-- ================================================================
-- Purpose:
--   If a user has set a custom username in user_profiles, show that
--   instead of the masked email on the leaderboard.
--   The masked email is still returned as a separate `email_masked`
--   field so the frontend can display it on hover.
--
-- Changes:
--   - get_leaderboard: LEFT JOIN user_profiles, prefer username over
--     masked email for display_name
--   - Added email_masked TEXT column to return type
-- ================================================================

DROP FUNCTION IF EXISTS public.get_leaderboard(p_date DATE, p_limit INTEGER, p_include_current_user BOOLEAN) CASCADE;

CREATE OR REPLACE FUNCTION public.get_leaderboard(
    p_date                DATE    DEFAULT NULL,
    p_limit               INTEGER DEFAULT 100,
    p_include_current_user BOOLEAN DEFAULT true
)
RETURNS TABLE(
    user_id         UUID,
    rank_position   INTEGER,
    total_score     NUMERIC,
    tests_completed INTEGER,
    new_words_added INTEGER,
    accuracy_rate   NUMERIC,
    avg_difficulty  NUMERIC,
    is_current_user BOOLEAN,
    display_name    TEXT,
    email_masked    TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_query_date DATE;
    v_today      DATE;
BEGIN
    v_today      := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::DATE;
    v_query_date := COALESCE(p_date, v_today);

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
        (l.user_id = auth.uid())::BOOLEAN AS is_current_user,

        -- display_name: custom username if set, otherwise masked email
        COALESCE(
            NULLIF(TRIM(COALESCE(p.username, '')), ''),
            CASE
                WHEN POSITION('@' IN u.email) > 0
                    THEN SUBSTRING(u.email FROM 1 FOR 3) || '****' || SUBSTRING(u.email FROM POSITION('@' IN u.email))
                ELSE LEFT(u.email, 3) || '****'
            END
        ) AS display_name,

        -- email_masked: always the masked email (for hover tooltip)
        CASE
            WHEN POSITION('@' IN u.email) > 0
                THEN SUBSTRING(u.email FROM 1 FOR 3) || '****' || SUBSTRING(u.email FROM POSITION('@' IN u.email))
            ELSE LEFT(u.email, 3) || '****'
        END AS email_masked

    FROM public.leaderboards l
    JOIN  auth.users        u ON l.user_id = u.id
    LEFT JOIN public.user_profiles p ON l.user_id = p.user_id
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

GRANT EXECUTE ON FUNCTION public.get_leaderboard TO authenticated;

DO $$
BEGIN
    RAISE NOTICE '✅ get_leaderboard now shows custom username when available';
    RAISE NOTICE '✅ email_masked field added for hover tooltip';
END;
$$;
