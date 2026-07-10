-- ================================================================
-- Migration: Add Global Champion Leaderboards (Hall of Fame)
-- Date: 2026-07-11
-- ================================================================
-- Purpose:
--   Power the rotating "Hall of Fame" banner in the header + the
--   floating 5-tab leaderboard modal.
--
-- Adds:
--   1. Support indexes on user_achievements + words (aggregation speed)
--   2. get_global_champions()   → lightweight 5-row summary for the banner
--   3. get_global_leaderboard(p_category, p_limit) → ranked rows for the modal
--
-- Both functions run as SECURITY DEFINER because user_achievements and
-- words are RLS-protected (auth.uid() = user_id) — we need to read all
-- users' rows to compute global rankings.
--
-- PL/pgSQL note: every column reference inside the function body is
-- alias-qualified (`l.user_id`, `sc.uid`, `r.rank_position`, …) to avoid
-- the classic "column reference is ambiguous" error — OUT parameters
-- (`user_id`, `score_value`, …) shadow bare column names.
-- ================================================================

-- ----------------------------------------------------------------
-- 1. Indexes
-- ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_user_achievements_user_id
  ON public.user_achievements(user_id);

CREATE INDEX IF NOT EXISTS idx_words_user_alive
  ON public.words(user_id)
  WHERE deleted = false OR deleted IS NULL;

CREATE INDEX IF NOT EXISTS idx_words_mastery
  ON public.words(user_id)
  WHERE tested = true AND error_count = 0 AND (deleted = false OR deleted IS NULL);

CREATE INDEX IF NOT EXISTS idx_leaderboards_user_score
  ON public.leaderboards(user_id, total_score);

CREATE INDEX IF NOT EXISTS idx_puzzle_game_rounds_user_score
  ON public.puzzle_game_rounds(user_id, total_score);

CREATE INDEX IF NOT EXISTS idx_scene_game_rounds_user_score
  ON public.scene_game_rounds(user_id, total_score);

-- ----------------------------------------------------------------
-- 2. get_global_champions() — for the banner (5 rows max)
-- ----------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_global_champions() CASCADE;

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
  -- daily_total: SUM(leaderboards.total_score) per user
  RETURN QUERY
  SELECT
    'daily_total'::TEXT   AS category,
    '日常总分'::TEXT       AS category_label,
    'emoji_events'::TEXT  AS category_icon,
    u.id                  AS champion_user_id,
    COALESCE(NULLIF(TRIM(COALESCE(up.username, '')), ''), split_part(u.email, '@', 1)) AS champion_name,
    up.avatar_url         AS champion_avatar,
    s.score               AS score_value,
    TO_CHAR(s.score, 'FM999,999,990') || ' 分' AS score_label
  FROM (
    SELECT l.user_id, SUM(l.total_score) AS score
    FROM public.leaderboards l
    GROUP BY l.user_id
    ORDER BY score DESC
    LIMIT 1
  ) s
  JOIN auth.users u ON u.id = s.user_id
  LEFT JOIN public.user_profiles up ON up.user_id = s.user_id;

  -- achievements: COUNT(*) per user
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

  -- game_total: SUM(total_score) across puzzle + scene rounds
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
    SELECT rounds.user_id, SUM(rounds.total_score) AS score
    FROM (
      SELECT pgr.user_id, pgr.total_score FROM public.puzzle_game_rounds pgr
      UNION ALL
      SELECT sgr.user_id, sgr.total_score FROM public.scene_game_rounds sgr
    ) rounds
    GROUP BY rounds.user_id
    ORDER BY score DESC
    LIMIT 1
  ) s
  JOIN auth.users u ON u.id = s.user_id
  LEFT JOIN public.user_profiles up ON up.user_id = s.user_id;

  -- word_mastery: COUNT of tested + zero-error + not-deleted words
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

  -- words_added: COUNT of non-deleted words
  RETURN QUERY
  SELECT
    'words_added'::TEXT  AS category,
    '单词添加'::TEXT      AS category_label,
    'library_add'::TEXT  AS category_icon,
    u.id                 AS champion_user_id,
    COALESCE(NULLIF(TRIM(COALESCE(up.username, '')), ''), split_part(u.email, '@', 1)) AS champion_name,
    up.avatar_url        AS champion_avatar,
    s.score              AS score_value,
    TO_CHAR(s.score, 'FM999,999,990') || ' 个' AS score_label
  FROM (
    SELECT w.user_id, COUNT(*)::NUMERIC AS score
    FROM public.words w
    WHERE (w.deleted = false OR w.deleted IS NULL)
    GROUP BY w.user_id
    ORDER BY score DESC
    LIMIT 1
  ) s
  JOIN auth.users u ON u.id = s.user_id
  LEFT JOIN public.user_profiles up ON up.user_id = s.user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_global_champions() TO authenticated;

-- ----------------------------------------------------------------
-- 3. get_global_leaderboard(p_category, p_limit) — for the modal
-- ----------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_global_leaderboard(TEXT, INTEGER) CASCADE;

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

    -- words_added
    WHEN 'words_added' THEN
      RETURN QUERY
      WITH scored AS (
        SELECT w.user_id AS uid, COUNT(*)::NUMERIC AS score_value
        FROM public.words w
        WHERE (w.deleted = false OR w.deleted IS NULL)
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

    ELSE
      RAISE EXCEPTION 'unknown global leaderboard category: %', p_category
        USING HINT = 'Valid categories: daily_total, achievements, game_total, word_mastery, words_added';
  END CASE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_global_leaderboard(TEXT, INTEGER) TO authenticated;

DO $$
BEGIN
  RAISE NOTICE '✅ get_global_champions() and get_global_leaderboard() installed';
  RAISE NOTICE '✅ Indexes created on user_achievements, words, leaderboards, puzzle_game_rounds, scene_game_rounds';
END;
$$;
