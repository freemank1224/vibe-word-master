-- ================================================================
-- Migration: Add Word Strike Rounds + Rankings + coin type extension
-- Date: 2026-09-07
--
-- WORD STRIKE — physics typing-shooter. Mirrors the puzzle rankings
-- migration (20260527000000) 1:1 plus:
--   • strike-specific columns (lives / combo / letters)
--   • combo_score leaderboard metric (gated on accuracy ≥ 0.85 like speed)
--   • extends the coin ledger CHECK constraint and the award_game_coins
--     whitelist with 'word_strike_score' (both were hardcoded in
--     20260712000000_add_coin_currency_system.sql)
--
-- NOTE: production DB migrations are applied MANUALLY (repo file ≠ applied).
-- Run this file via `supabase db query --linked -f` or the Dashboard editor
-- before coins/leaderboard for Word Strike go live.
-- ================================================================

-- ================================================================
-- A. Table
-- ================================================================

CREATE TABLE IF NOT EXISTS public.word_strike_rounds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    played_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    played_date DATE NOT NULL,
    total_score NUMERIC NOT NULL,
    accuracy_rate NUMERIC NOT NULL,
    speed_score NUMERIC NOT NULL,
    combo_score NUMERIC NOT NULL,
    time_used_seconds INTEGER NOT NULL,
    lives_lost INTEGER NOT NULL,
    lives_remaining INTEGER NOT NULL,
    max_combo INTEGER NOT NULL,
    letters_hit INTEGER NOT NULL,
    letters_fired INTEGER NOT NULL,
    words_total INTEGER NOT NULL,
    words_correct INTEGER NOT NULL,
    selection_mode TEXT NOT NULL CHECK (selection_mode IN ('smart', 'random')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.word_strike_rounds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view word strike rounds" ON public.word_strike_rounds;
CREATE POLICY "Users can view word strike rounds"
    ON public.word_strike_rounds FOR SELECT
    USING (true);

DROP POLICY IF EXISTS "Users can insert own word strike rounds" ON public.word_strike_rounds;
CREATE POLICY "Users can insert own word strike rounds"
    ON public.word_strike_rounds FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS word_strike_rounds_played_date_idx ON public.word_strike_rounds(played_date);
CREATE INDEX IF NOT EXISTS word_strike_rounds_total_score_idx ON public.word_strike_rounds(total_score DESC);
CREATE INDEX IF NOT EXISTS word_strike_rounds_user_id_idx ON public.word_strike_rounds(user_id);

-- ================================================================
-- B. record_word_strike_round
-- ================================================================

CREATE OR REPLACE FUNCTION public.record_word_strike_round(
    p_total_score NUMERIC,
    p_accuracy_rate NUMERIC,
    p_speed_score NUMERIC,
    p_combo_score NUMERIC,
    p_time_used_seconds INTEGER,
    p_lives_lost INTEGER,
    p_lives_remaining INTEGER,
    p_max_combo INTEGER,
    p_letters_hit INTEGER,
    p_letters_fired INTEGER,
    p_words_total INTEGER,
    p_words_correct INTEGER,
    p_selection_mode TEXT,
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
    INSERT INTO public.word_strike_rounds AS rounds (
        user_id,
        played_date,
        total_score,
        accuracy_rate,
        speed_score,
        combo_score,
        time_used_seconds,
        lives_lost,
        lives_remaining,
        max_combo,
        letters_hit,
        letters_fired,
        words_total,
        words_correct,
        selection_mode
    )
    VALUES (
        v_user_id,
        v_played_date,
        p_total_score,
        p_accuracy_rate,
        p_speed_score,
        p_combo_score,
        p_time_used_seconds,
        p_lives_lost,
        p_lives_remaining,
        p_max_combo,
        p_letters_hit,
        p_letters_fired,
        p_words_total,
        p_words_correct,
        p_selection_mode
    )
    RETURNING rounds.id AS round_id, rounds.played_date, rounds.total_score;
END;
$$;

-- ================================================================
-- C. get_word_strike_leaderboard
-- ================================================================

CREATE OR REPLACE FUNCTION public.get_word_strike_leaderboard(
    p_scope TEXT DEFAULT 'all_time',
    p_metric TEXT DEFAULT 'total_score',
    p_date DATE DEFAULT NULL,
    p_limit INTEGER DEFAULT 3
)
RETURNS TABLE(
    user_id UUID,
    rank_position INTEGER,
    metric_value NUMERIC,
    total_score NUMERIC,
    accuracy_rate NUMERIC,
    speed_score NUMERIC,
    combo_score NUMERIC,
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
    v_today DATE;
    v_date DATE;
BEGIN
    v_scope := CASE WHEN p_scope IN ('daily', 'all_time') THEN p_scope ELSE 'all_time' END;
    v_metric := CASE WHEN p_metric IN ('total_score', 'accuracy_rate', 'speed_score', 'combo_score') THEN p_metric ELSE 'total_score' END;
    v_today := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::DATE;
    v_date := LEAST(COALESCE(p_date, v_today), v_today);

    RETURN QUERY
    WITH candidate_rounds AS (
        SELECT
            r.*,
            CASE v_metric
                WHEN 'accuracy_rate' THEN r.accuracy_rate * 1000
                WHEN 'speed_score' THEN r.speed_score
                WHEN 'combo_score' THEN r.combo_score
                ELSE r.total_score
            END AS metric_value
        FROM public.word_strike_rounds r
        WHERE (
            (v_scope = 'daily' AND r.played_date = v_date)
            OR v_scope = 'all_time'
        )
        AND (
            CASE
                WHEN v_metric IN ('speed_score', 'combo_score') THEN r.accuracy_rate >= 0.85
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
        r.combo_score,
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

-- ================================================================
-- D. Coin type extension — TWO places constrain the ledger type:
--    D1: the inline CHECK on coin_transactions.type
--    D2: the award_game_coins whitelist guard
-- ================================================================

-- D1. Rebuild the inline CHECK on coin_transactions.type. The constraint
-- name is auto-generated (coin_transactions_type_check / _chk_N variants), so
-- discover-and-drop instead of hardcoding a name.
DO $$
DECLARE
    c RECORD;
BEGIN
    FOR c IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'public.coin_transactions'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%type = ANY%'
    LOOP
        EXECUTE format('ALTER TABLE public.coin_transactions DROP CONSTRAINT %I', c.conname);
    END LOOP;
END $$;

ALTER TABLE public.coin_transactions
    ADD CONSTRAINT coin_transactions_type_check CHECK (type IN (
        'daily_login',
        'daily_login_7_bonus',
        'daily_login_30_bonus',
        'quiz_score',
        'puzzle_score',
        'word_strike_score',
        'achievement_unlock',
        'all_achievements_bonus',
        'scene_game_spend',
        'scene_game_refund',
        'admin_adjust'
    ));

-- D2. Replace award_game_coins: identical body to 20260712000000, only the
-- type whitelist gains 'word_strike_score' and the note CASE gains a branch.
CREATE OR REPLACE FUNCTION public.award_game_coins(
    p_type      TEXT,
    p_reference TEXT,
    p_delta     INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id       UUID;
    v_old_balance   INTEGER;
    v_new_balance   INTEGER;
    v_inserted      UUID;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('error', 'not_authenticated');
    END IF;

    IF p_type NOT IN ('quiz_score', 'puzzle_score', 'word_strike_score') THEN
        RETURN jsonb_build_object('error', 'invalid_type');
    END IF;
    IF p_delta IS NULL OR p_delta <= 0 THEN
        RETURN jsonb_build_object('error', 'invalid_delta');
    END IF;

    -- Ensure wallet + lock
    INSERT INTO user_wallets (user_id) VALUES (v_user_id)
    ON CONFLICT (user_id) DO NOTHING;

    SELECT balance INTO v_old_balance FROM user_wallets
    WHERE user_id = v_user_id FOR UPDATE;

    -- Idempotent insert
    INSERT INTO coin_transactions (user_id, delta, balance_after, type, reference, note)
    VALUES (
        v_user_id, p_delta, v_old_balance + p_delta, p_type, p_reference,
        CASE p_type
            WHEN 'quiz_score' THEN 'Quiz score reward'
            WHEN 'word_strike_score' THEN 'Word Strike score reward'
            ELSE 'Puzzle score reward'
        END
    )
    ON CONFLICT (user_id, type, reference) DO NOTHING
    RETURNING id INTO v_inserted;

    IF v_inserted IS NULL THEN
        RETURN jsonb_build_object(
            'awarded',         FALSE,
            'already_awarded', TRUE,
            'new_balance',     v_old_balance
        );
    END IF;

    v_new_balance := v_old_balance + p_delta;
    UPDATE user_wallets
    SET balance         = v_new_balance,
        lifetime_earned = lifetime_earned + p_delta,
        updated_at      = now()
    WHERE user_id = v_user_id;

    RETURN jsonb_build_object(
        'awarded',         TRUE,
        'already_awarded', FALSE,
        'new_balance',     v_new_balance
    );
END;
$$;

-- ================================================================
-- Grants
-- ================================================================
GRANT SELECT ON public.word_strike_rounds TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_word_strike_round TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_word_strike_leaderboard TO authenticated;
GRANT EXECUTE ON FUNCTION public.award_game_coins(TEXT, TEXT, INTEGER) TO authenticated;
