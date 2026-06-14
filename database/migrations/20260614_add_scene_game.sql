-- ================================================================
-- Migration: Add Scene Fusion Game (看图拼写 / 大海捞针)
-- Date: 2026-06-14
--
-- Adds:
--   1. scene_assets       — shared cache of fused scene images + per-word regions
--   2. scene_game_rounds  — per-user round results (mirror of puzzle_game_rounds)
--   3. record_scene_game_round / get_scene_game_leaderboard RPCs
--
-- Deliberately separate from image_assets (UNIQUE on single word) and from
-- puzzle_game_rounds / leaderboards — zero blast radius on existing pipelines.
-- ================================================================

-- ----------------------------------------------------------------
-- 1. scene_assets: shared, world-readable cache of fused scenes
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.scene_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    word_set_hash TEXT NOT NULL,
    day_index SMALLINT NOT NULL CHECK (day_index BETWEEN 0 AND 6),
    language TEXT NOT NULL DEFAULT 'en',
    words JSONB NOT NULL DEFAULT '[]'::jsonb,
    storage_bucket TEXT NOT NULL DEFAULT 'word-images',
    storage_path TEXT NOT NULL,
    public_url TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '',
    regions JSONB NOT NULL DEFAULT '[]'::jsonb,
    model TEXT,
    vision_model TEXT,
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'failed')),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS scene_assets_cache_uidx
    ON public.scene_assets (word_set_hash, day_index, language);
CREATE INDEX IF NOT EXISTS scene_assets_status_idx ON public.scene_assets (status);

ALTER TABLE public.scene_assets ENABLE ROW LEVEL SECURITY;

-- Shared cache: anyone may read ready scenes (no user data inside).
DROP POLICY IF EXISTS "Anyone can read ready scene assets" ON public.scene_assets;
CREATE POLICY "Anyone can read ready scene assets"
    ON public.scene_assets FOR SELECT
    USING (true);
-- Writes are service-role only (edge function). No client INSERT/UPDATE policy.

-- ----------------------------------------------------------------
-- 2. scene_game_rounds: per-user round results
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.scene_game_rounds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    played_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    played_date DATE NOT NULL,
    play_mode TEXT NOT NULL CHECK (play_mode IN ('spell', 'haystack')),
    selection_mode TEXT NOT NULL CHECK (selection_mode IN ('smart', 'random')),
    day_index SMALLINT NOT NULL CHECK (day_index BETWEEN 0 AND 6),
    word_count INTEGER NOT NULL,
    total_duration_seconds INTEGER NOT NULL,
    total_score NUMERIC NOT NULL,
    accuracy_rate NUMERIC NOT NULL,
    speed_score NUMERIC NOT NULL,
    no_hint_score NUMERIC NOT NULL,
    time_used_seconds INTEGER NOT NULL,
    seconds_remaining INTEGER NOT NULL,
    hints_used INTEGER NOT NULL,
    words_total INTEGER NOT NULL,
    words_correct INTEGER NOT NULL,
    solved_without_hint INTEGER NOT NULL,
    scene_asset_id UUID REFERENCES public.scene_assets(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.scene_game_rounds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view scene rounds" ON public.scene_game_rounds;
CREATE POLICY "Users can view scene rounds"
    ON public.scene_game_rounds FOR SELECT
    USING (true);

DROP POLICY IF EXISTS "Users can insert own scene rounds" ON public.scene_game_rounds;
CREATE POLICY "Users can insert own scene rounds"
    ON public.scene_game_rounds FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS scene_game_rounds_user_date_idx
    ON public.scene_game_rounds (user_id, played_date DESC);
CREATE INDEX IF NOT EXISTS scene_game_rounds_daily_score_idx
    ON public.scene_game_rounds (play_mode, played_date, total_score DESC);
CREATE INDEX IF NOT EXISTS scene_game_rounds_alltime_score_idx
    ON public.scene_game_rounds (play_mode, total_score DESC);

-- ----------------------------------------------------------------
-- 3. record_scene_game_round
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_scene_game_round(
    p_play_mode TEXT,
    p_selection_mode TEXT,
    p_day_index INTEGER,
    p_word_count INTEGER,
    p_total_duration_seconds INTEGER,
    p_total_score NUMERIC,
    p_accuracy_rate NUMERIC,
    p_speed_score NUMERIC,
    p_no_hint_score NUMERIC,
    p_time_used_seconds INTEGER,
    p_seconds_remaining INTEGER,
    p_hints_used INTEGER,
    p_words_total INTEGER,
    p_words_correct INTEGER,
    p_solved_without_hint INTEGER,
    p_scene_asset_id UUID DEFAULT NULL,
    p_client_date DATE DEFAULT NULL
)
RETURNS TABLE(
    round_id UUID,
    played_date DATE,
    total_score NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_today DATE;
    v_played_date DATE;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'User not authenticated';
    END IF;

    v_today := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::DATE;
    v_played_date := LEAST(COALESCE(p_client_date, v_today), v_today);

    RETURN QUERY
    INSERT INTO public.scene_game_rounds AS rounds (
        user_id,
        played_date,
        play_mode,
        selection_mode,
        day_index,
        word_count,
        total_duration_seconds,
        total_score,
        accuracy_rate,
        speed_score,
        no_hint_score,
        time_used_seconds,
        seconds_remaining,
        hints_used,
        words_total,
        words_correct,
        solved_without_hint,
        scene_asset_id
    )
    VALUES (
        v_user_id,
        v_played_date,
        p_play_mode,
        p_selection_mode,
        p_day_index,
        p_word_count,
        p_total_duration_seconds,
        p_total_score,
        p_accuracy_rate,
        p_speed_score,
        p_no_hint_score,
        p_time_used_seconds,
        p_seconds_remaining,
        p_hints_used,
        p_words_total,
        p_words_correct,
        p_solved_without_hint,
        p_scene_asset_id
    )
    RETURNING rounds.id AS round_id, rounds.played_date, rounds.total_score;
END;
$$;

-- ----------------------------------------------------------------
-- 4. get_scene_game_leaderboard
--    metric: total_score | accuracy_rate | speed_score
--    speed_score requires accuracy_rate >= 0.85 (parity with puzzle).
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_scene_game_leaderboard(
    p_scope TEXT DEFAULT 'all_time',
    p_metric TEXT DEFAULT 'total_score',
    p_play_mode TEXT DEFAULT NULL,
    p_date DATE DEFAULT NULL,
    p_limit INTEGER DEFAULT 8
)
RETURNS TABLE(
    user_id UUID,
    rank_position INTEGER,
    metric_value NUMERIC,
    total_score NUMERIC,
    accuracy_rate NUMERIC,
    speed_score NUMERIC,
    play_mode TEXT,
    words_total INTEGER,
    words_correct INTEGER,
    time_used_seconds INTEGER,
    played_date DATE,
    display_name TEXT,
    email_masked TEXT,
    is_current_user BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_scope TEXT;
    v_metric TEXT;
    v_play_mode TEXT;
    v_today DATE;
    v_date DATE;
BEGIN
    v_scope := CASE WHEN p_scope IN ('daily', 'all_time') THEN p_scope ELSE 'all_time' END;
    v_metric := CASE WHEN p_metric IN ('total_score', 'accuracy_rate', 'speed_score') THEN p_metric ELSE 'total_score' END;
    v_play_mode := CASE WHEN p_play_mode IN ('spell', 'haystack') THEN p_play_mode ELSE NULL END;
    v_today := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::DATE;
    v_date := LEAST(COALESCE(p_date, v_today), v_today);

    RETURN QUERY
    WITH candidate_rounds AS (
        SELECT
            r.*,
            CASE v_metric
                WHEN 'accuracy_rate' THEN r.accuracy_rate * 1000
                WHEN 'speed_score' THEN r.speed_score
                ELSE r.total_score
            END AS metric_value
        FROM public.scene_game_rounds r
        WHERE (
            (v_scope = 'daily' AND r.played_date = v_date)
            OR v_scope = 'all_time'
        )
        AND (v_play_mode IS NULL OR r.play_mode = v_play_mode)
        AND (
            CASE
                WHEN v_metric = 'speed_score' THEN r.accuracy_rate >= 0.85
                ELSE true
            END
        )
    ),
    best_per_user AS (
        SELECT DISTINCT ON (c.user_id)
            c.*
        FROM candidate_rounds c
        ORDER BY c.user_id, c.metric_value DESC, c.total_score DESC, c.accuracy_rate DESC, c.time_used_seconds ASC, c.played_at ASC
    ),
    ranked AS (
        SELECT
            b.*,
            ROW_NUMBER() OVER (
                ORDER BY b.metric_value DESC, b.total_score DESC, b.accuracy_rate DESC, b.time_used_seconds ASC, b.played_at ASC
            )::INTEGER AS rank_position
        FROM best_per_user b
    )
    SELECT
        r.user_id,
        r.rank_position,
        r.metric_value,
        r.total_score,
        r.accuracy_rate,
        r.speed_score,
        r.play_mode,
        r.words_total,
        r.words_correct,
        r.time_used_seconds,
        r.played_date,
        COALESCE(
            NULLIF(TRIM(COALESCE(p.username, '')), ''),
            CASE
                WHEN POSITION('@' IN u.email) > 0
                    THEN SUBSTRING(u.email FROM 1 FOR 3) || '****' || SUBSTRING(u.email FROM POSITION('@' IN u.email))
                ELSE LEFT(u.email, 3) || '****'
            END
        ) AS display_name,
        CASE
            WHEN POSITION('@' IN u.email) > 0
                THEN SUBSTRING(u.email FROM 1 FOR 3) || '****' || SUBSTRING(u.email FROM POSITION('@' IN u.email))
            ELSE LEFT(u.email, 3) || '****'
        END AS email_masked,
        (r.user_id = auth.uid())::BOOLEAN AS is_current_user
    FROM ranked r
    JOIN auth.users u ON r.user_id = u.id
    LEFT JOIN public.user_profiles p ON r.user_id = p.user_id
    WHERE r.rank_position <= GREATEST(p_limit, 1)
    ORDER BY r.rank_position;
END;
$$;

GRANT SELECT ON public.scene_assets TO authenticated;
GRANT SELECT ON public.scene_game_rounds TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_scene_game_round TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_scene_game_leaderboard TO authenticated;
