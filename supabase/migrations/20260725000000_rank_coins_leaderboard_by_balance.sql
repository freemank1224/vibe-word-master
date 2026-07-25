-- ================================================================
-- Migration: Rank the coins leaderboard by current balance
--
-- The coin-wealth leaderboard (rotating banner + "财富榜" tab in the
-- global leaderboard modal) previously ranked users by
-- user_wallets.lifetime_earned (gross coins ever earned), while the
-- header's right-side CoinCounter shows user_wallets.balance
-- (spendable balance). Because scene-game spends reduce balance but
-- NOT lifetime_earned, the two surfaces diverged by exactly
-- lifetime_spent the moment a user played a scene game — so a user
-- saw one number top-center and a different one top-right.
--
-- Align both surfaces on `balance` so the wealth leaderboard always
-- matches the live coin counter. Only the `coins` branch of each
-- function changes; everything else is reissued verbatim because
-- CREATE OR REPLACE needs the full function body.
-- ================================================================

-- ----------------------------------------------------------------
-- 1. get_global_champions() — coins branch now ranked by balance
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_global_champions()
RETURNS TABLE (
  category          TEXT,
  category_label    TEXT,
  category_icon     TEXT,
  champion_user_id  UUID,
  champion_name     TEXT,
  champion_avatar   TEXT,
  score_value       NUMERIC,
  score_label       TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- daily_total
  RETURN QUERY
  SELECT
    'daily_total'::TEXT  AS category,
    '日常总分'::TEXT      AS category_label,
    'emoji_events'::TEXT AS category_icon,
    u.id                 AS champion_user_id,
    COALESCE(NULLIF(TRIM(COALESCE(up.username, '')), ''), split_part(u.email, '@', 1)) AS champion_name,
    up.avatar_url        AS champion_avatar,
    s.score              AS score_value,
    TO_CHAR(s.score, 'FM999,999,990') || ' 分' AS score_label
  FROM (
    SELECT l.user_id AS uid, SUM(l.total_score) AS score
    FROM public.leaderboards l
    GROUP BY l.user_id
    ORDER BY score DESC
    LIMIT 1
  ) s
  JOIN auth.users u ON u.id = s.uid
  LEFT JOIN public.user_profiles up ON up.user_id = s.uid;

  -- achievements
  RETURN QUERY
  SELECT
    'achievements'::TEXT  AS category,
    '成就解锁'::TEXT       AS category_label,
    'military_tech'::TEXT AS category_icon,
    u.id                  AS champion_user_id,
    COALESCE(NULLIF(TRIM(COALESCE(up.username, '')), ''), split_part(u.email, '@', 1)) AS champion_name,
    up.avatar_url         AS champion_avatar,
    s.score               AS score_value,
    TO_CHAR(s.score, 'FM999,999,990') || ' 个' AS score_label
  FROM (
    SELECT ua.user_id, COUNT(*)::NUMERIC AS score
    FROM public.user_achievements ua
    GROUP BY ua.user_id
    ORDER BY score DESC
    LIMIT 1
  ) s
  JOIN auth.users u ON u.id = s.user_id
  LEFT JOIN public.user_profiles up ON up.user_id = s.user_id;

  -- game_total
  RETURN QUERY
  SELECT
    'game_total'::TEXT     AS category,
    '游戏总分'::TEXT        AS category_label,
    'sports_esports'::TEXT AS category_icon,
    u.id                   AS champion_user_id,
    COALESCE(NULLIF(TRIM(COALESCE(up.username, '')), ''), split_part(u.email, '@', 1)) AS champion_name,
    up.avatar_url          AS champion_avatar,
    s.score                AS score_value,
    TO_CHAR(s.score, 'FM999,999,990') || ' 分' AS score_label
  FROM (
    SELECT rr.uid, SUM(rr.total_score) AS score
    FROM (
      SELECT pgr.user_id AS uid, pgr.total_score AS total_score
      FROM public.puzzle_game_rounds pgr
      UNION ALL
      SELECT sgr.user_id AS uid, sgr.total_score AS total_score
      FROM public.scene_game_rounds sgr
    ) rr
    GROUP BY rr.uid
    ORDER BY score DESC
    LIMIT 1
  ) s
  JOIN auth.users u ON u.id = s.uid
  LEFT JOIN public.user_profiles up ON up.user_id = s.uid;

  -- word_mastery
  RETURN QUERY
  SELECT
    'word_mastery'::TEXT AS category,
    '单词掌握'::TEXT      AS category_label,
    'verified'::TEXT     AS category_icon,
    u.id                 AS champion_user_id,
    COALESCE(NULLIF(TRIM(COALESCE(up.username, '')), ''), split_part(u.email, '@', 1)) AS champion_name,
    up.avatar_url        AS champion_avatar,
    s.score              AS score_value,
    TO_CHAR(s.score, 'FM999,999,990') || ' 个' AS score_label
  FROM (
    SELECT w.user_id, COUNT(*)::NUMERIC AS score
    FROM public.words w
    WHERE w.tested = true
      AND w.error_count = 0
      AND (w.deleted = false OR w.deleted IS NULL)
    GROUP BY w.user_id
    ORDER BY score DESC
    LIMIT 1
  ) s
  JOIN auth.users u ON u.id = s.user_id
  LEFT JOIN public.user_profiles up ON up.user_id = s.user_id;

  -- coins — ranked by balance (matches the header's live CoinCounter)
  RETURN QUERY
  SELECT
    'coins'::TEXT        AS category,
    '财富榜'::TEXT        AS category_label,
    'monetization_on'::TEXT AS category_icon,
    u.id                 AS champion_user_id,
    COALESCE(NULLIF(TRIM(COALESCE(up.username, '')), ''), split_part(u.email, '@', 1)) AS champion_name,
    up.avatar_url        AS champion_avatar,
    s.score              AS score_value,
    TO_CHAR(s.score, 'FM999,999,990') || ' 金币' AS score_label
  FROM (
    SELECT w.user_id, w.balance::NUMERIC AS score
    FROM public.user_wallets w
    ORDER BY score DESC
    LIMIT 1
  ) s
  JOIN auth.users u ON u.id = s.user_id
  LEFT JOIN public.user_profiles up ON up.user_id = s.user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_global_champions() TO authenticated;

-- ----------------------------------------------------------------
-- 2. get_global_leaderboard() — coins branch now ranked by balance
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_global_leaderboard(
  p_category TEXT DEFAULT 'daily_total',
  p_limit    INTEGER DEFAULT 10
)
RETURNS TABLE (
  rank_position   INTEGER,
  user_id         UUID,
  display_name    TEXT,
  email_masked    TEXT,
  avatar_url      TEXT,
  score_value     NUMERIC,
  score_label     TEXT,
  is_current_user BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current UUID := auth.uid();
  v_limit   INTEGER := GREATEST(p_limit, 1);
BEGIN
  CASE p_category
    -- daily_total
    WHEN 'daily_total' THEN
      RETURN QUERY
      WITH scored AS (
        SELECT l.user_id AS uid, SUM(l.total_score) AS score_value
        FROM public.leaderboards l
        GROUP BY l.user_id
      ),
      ranked AS (
        SELECT sc.uid AS uid, sc.score_value AS score_value,
               ROW_NUMBER() OVER (ORDER BY sc.score_value DESC) AS rank_position
        FROM scored sc
      ),
      combined AS (
        SELECT r.uid, r.score_value, r.rank_position
        FROM ranked r WHERE r.rank_position <= v_limit
        UNION ALL
        SELECT r.uid, r.score_value, r.rank_position
        FROM ranked r WHERE r.uid = v_current AND r.rank_position > v_limit
      )
      SELECT c.rank_position::INTEGER,
             c.uid AS user_id,
             COALESCE(NULLIF(TRIM(COALESCE(up.username, '')), ''), split_part(u.email, '@', 1)) AS display_name,
             CONCAT(LEFT(split_part(u.email, '@', 1), 2), '***') AS email_masked,
             up.avatar_url,
             c.score_value,
             TO_CHAR(c.score_value, 'FM999,999,990') || ' 分' AS score_label,
             (c.uid = v_current) AS is_current_user
      FROM combined c
      JOIN auth.users u ON u.id = c.uid
      LEFT JOIN public.user_profiles up ON up.user_id = c.uid
      ORDER BY c.rank_position;

    -- achievements
    WHEN 'achievements' THEN
      RETURN QUERY
      WITH scored AS (
        SELECT ua.user_id AS uid, COUNT(*)::NUMERIC AS score_value
        FROM public.user_achievements ua
        GROUP BY ua.user_id
      ),
      ranked AS (
        SELECT sc.uid AS uid, sc.score_value AS score_value,
               ROW_NUMBER() OVER (ORDER BY sc.score_value DESC) AS rank_position
        FROM scored sc
      ),
      combined AS (
        SELECT r.uid, r.score_value, r.rank_position
        FROM ranked r WHERE r.rank_position <= v_limit
        UNION ALL
        SELECT r.uid, r.score_value, r.rank_position
        FROM ranked r WHERE r.uid = v_current AND r.rank_position > v_limit
      )
      SELECT c.rank_position::INTEGER,
             c.uid AS user_id,
             COALESCE(NULLIF(TRIM(COALESCE(up.username, '')), ''), split_part(u.email, '@', 1)) AS display_name,
             CONCAT(LEFT(split_part(u.email, '@', 1), 2), '***') AS email_masked,
             up.avatar_url,
             c.score_value,
             TO_CHAR(c.score_value, 'FM999,999,990') || ' 个' AS score_label,
             (c.uid = v_current) AS is_current_user
      FROM combined c
      JOIN auth.users u ON u.id = c.uid
      LEFT JOIN public.user_profiles up ON up.user_id = c.uid
      ORDER BY c.rank_position;

    -- game_total
    WHEN 'game_total' THEN
      RETURN QUERY
      WITH raw_rounds AS (
        SELECT pgr.user_id AS uid, pgr.total_score AS total_score
        FROM public.puzzle_game_rounds pgr
        UNION ALL
        SELECT sgr.user_id AS uid, sgr.total_score AS total_score
        FROM public.scene_game_rounds sgr
      ),
      scored AS (
        SELECT rr.uid AS uid, SUM(rr.total_score) AS score_value
        FROM raw_rounds rr
        GROUP BY rr.uid
      ),
      ranked AS (
        SELECT sc.uid AS uid, sc.score_value AS score_value,
               ROW_NUMBER() OVER (ORDER BY sc.score_value DESC) AS rank_position
        FROM scored sc
      ),
      combined AS (
        SELECT r.uid, r.score_value, r.rank_position
        FROM ranked r WHERE r.rank_position <= v_limit
        UNION ALL
        SELECT r.uid, r.score_value, r.rank_position
        FROM ranked r WHERE r.uid = v_current AND r.rank_position > v_limit
      )
      SELECT c.rank_position::INTEGER,
             c.uid AS user_id,
             COALESCE(NULLIF(TRIM(COALESCE(up.username, '')), ''), split_part(u.email, '@', 1)) AS display_name,
             CONCAT(LEFT(split_part(u.email, '@', 1), 2), '***') AS email_masked,
             up.avatar_url,
             c.score_value,
             TO_CHAR(c.score_value, 'FM999,999,990') || ' 分' AS score_label,
             (c.uid = v_current) AS is_current_user
      FROM combined c
      JOIN auth.users u ON u.id = c.uid
      LEFT JOIN public.user_profiles up ON up.user_id = c.uid
      ORDER BY c.rank_position;

    -- word_mastery
    WHEN 'word_mastery' THEN
      RETURN QUERY
      WITH scored AS (
        SELECT w.user_id AS uid, COUNT(*)::NUMERIC AS score_value
        FROM public.words w
        WHERE w.tested = true
          AND w.error_count = 0
          AND (w.deleted = false OR w.deleted IS NULL)
        GROUP BY w.user_id
      ),
      ranked AS (
        SELECT sc.uid AS uid, sc.score_value AS score_value,
               ROW_NUMBER() OVER (ORDER BY sc.score_value DESC) AS rank_position
        FROM scored sc
      ),
      combined AS (
        SELECT r.uid, r.score_value, r.rank_position
        FROM ranked r WHERE r.rank_position <= v_limit
        UNION ALL
        SELECT r.uid, r.score_value, r.rank_position
        FROM ranked r WHERE r.uid = v_current AND r.rank_position > v_limit
      )
      SELECT c.rank_position::INTEGER,
             c.uid AS user_id,
             COALESCE(NULLIF(TRIM(COALESCE(up.username, '')), ''), split_part(u.email, '@', 1)) AS display_name,
             CONCAT(LEFT(split_part(u.email, '@', 1), 2), '***') AS email_masked,
             up.avatar_url,
             c.score_value,
             TO_CHAR(c.score_value, 'FM999,999,990') || ' 个' AS score_label,
             (c.uid = v_current) AS is_current_user
      FROM combined c
      JOIN auth.users u ON u.id = c.uid
      LEFT JOIN public.user_profiles up ON up.user_id = c.uid
      ORDER BY c.rank_position;

    -- coins — ranked by balance (matches the header's live CoinCounter)
    WHEN 'coins' THEN
      RETURN QUERY
      WITH scored AS (
        SELECT w.user_id AS uid, w.balance::NUMERIC AS score_value
        FROM public.user_wallets w
      ),
      ranked AS (
        SELECT sc.uid AS uid, sc.score_value AS score_value,
               ROW_NUMBER() OVER (ORDER BY sc.score_value DESC) AS rank_position
        FROM scored sc
      ),
      combined AS (
        SELECT r.uid, r.score_value, r.rank_position
        FROM ranked r WHERE r.rank_position <= v_limit
        UNION ALL
        SELECT r.uid, r.score_value, r.rank_position
        FROM ranked r WHERE r.uid = v_current AND r.rank_position > v_limit
      )
      SELECT c.rank_position::INTEGER,
             c.uid AS user_id,
             COALESCE(NULLIF(TRIM(COALESCE(up.username, '')), ''), split_part(u.email, '@', 1)) AS display_name,
             CONCAT(LEFT(split_part(u.email, '@', 1), 2), '***') AS email_masked,
             up.avatar_url,
             c.score_value,
             TO_CHAR(c.score_value, 'FM999,999,990') || ' 金币' AS score_label,
             (c.uid = v_current) AS is_current_user
      FROM combined c
      JOIN auth.users u ON u.id = c.uid
      LEFT JOIN public.user_profiles up ON up.user_id = c.uid
      ORDER BY c.rank_position;

    ELSE
      RAISE EXCEPTION 'unknown global leaderboard category: %', p_category
        USING HINT = 'Valid categories: daily_total, achievements, game_total, word_mastery, coins';
  END CASE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_global_leaderboard(TEXT, INTEGER) TO authenticated;
