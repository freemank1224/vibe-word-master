-- ================================================================
-- Migration: Add Coin Currency System
-- Date: 2026-07-12
--
-- Adds three tables (user_wallets, coin_transactions, daily_check_ins)
-- and seven SECURITY DEFINER RPCs that form the complete coin economy.
--
-- All money mutations go through SECURITY DEFINER functions that take
-- a row-level lock (SELECT ... FOR UPDATE) on user_wallets, so concurrent
-- requests are serialized and the ledger stays consistent.
-- ================================================================

-- ========== 1. user_wallets ==========
CREATE TABLE IF NOT EXISTS public.user_wallets (
    user_id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    balance         INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
    lifetime_earned INTEGER NOT NULL DEFAULT 0,
    lifetime_spent  INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_wallets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_wallets_select_self ON public.user_wallets;
CREATE POLICY user_wallets_select_self ON public.user_wallets
    FOR SELECT USING (auth.uid() = user_id);
-- No INSERT/UPDATE/DELETE policies: mutations only via SECURITY DEFINER RPCs.

-- ========== 2. coin_transactions (ledger) ==========
CREATE TABLE IF NOT EXISTS public.coin_transactions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    delta         INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    type          TEXT NOT NULL CHECK (type IN (
        'daily_login',
        'daily_login_7_bonus',
        'daily_login_30_bonus',
        'quiz_score',
        'puzzle_score',
        'achievement_unlock',
        'all_achievements_bonus',
        'scene_game_spend',
        'scene_game_refund',
        'admin_adjust'
    )),
    reference     TEXT,
    note          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, type, reference)
);

CREATE INDEX IF NOT EXISTS idx_coin_transactions_user_created
    ON public.coin_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coin_transactions_user_type
    ON public.coin_transactions (user_id, type);

ALTER TABLE public.coin_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS coin_transactions_select_self ON public.coin_transactions;
CREATE POLICY coin_transactions_select_self ON public.coin_transactions
    FOR SELECT USING (auth.uid() = user_id);

-- ========== 3. daily_check_ins ==========
CREATE TABLE IF NOT EXISTS public.daily_check_ins (
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    check_in_date   DATE NOT NULL,
    streak_7_paid   BOOLEAN NOT NULL DEFAULT FALSE,
    streak_30_paid  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, check_in_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_check_ins_user_date
    ON public.daily_check_ins (user_id, check_in_date DESC);

ALTER TABLE public.daily_check_ins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS daily_check_ins_select_self ON public.daily_check_ins;
CREATE POLICY daily_check_ins_select_self ON public.daily_check_ins
    FOR SELECT USING (auth.uid() = user_id);


-- ================================================================
-- RPC 1: claim_daily_login_reward()
--
-- Called once per day on app open. Awards +1 base; if the new streak
-- is a multiple of 7 or 30, awards +7 / +30 respectively (independent
-- cycles). Idempotent: re-calling on the same Beijing-day returns
-- already_claimed_today=TRUE with no side effects.
-- ================================================================
CREATE OR REPLACE FUNCTION public.claim_daily_login_reward()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id              UUID;
    v_today                DATE;
    v_today_str            TEXT;
    v_streak               INTEGER := 1;
    v_check_day            DATE;
    v_streak_7_bonus_today BOOLEAN;
    v_streak_30_bonus_today BOOLEAN;
    v_old_balance          INTEGER;
    v_running_balance      INTEGER;
    v_inserted             UUID;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('error', 'not_authenticated');
    END IF;

    v_today     := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::DATE;
    v_today_str := to_char(v_today, 'YYYY-MM-DD');

    -- Ensure wallet exists (auto-create for first-time users)
    INSERT INTO user_wallets (user_id) VALUES (v_user_id)
    ON CONFLICT (user_id) DO NOTHING;

    -- Lock the wallet row for the duration of this transaction
    SELECT balance INTO v_old_balance FROM user_wallets
    WHERE user_id = v_user_id FOR UPDATE;

    -- Compute consecutive-day streak by scanning backward from yesterday.
    -- NOTE: For very long streaks this loops N times (one indexed lookup each);
    -- acceptable for v1 since most streaks are < 30 days.
    v_check_day := v_today - 1;
    LOOP
        EXIT WHEN NOT EXISTS (
            SELECT 1 FROM daily_check_ins
            WHERE user_id = v_user_id AND check_in_date = v_check_day
        );
        v_streak   := v_streak + 1;
        v_check_day := v_check_day - 1;
    END LOOP;

    v_streak_7_bonus_today  := (v_streak % 7  = 0);
    v_streak_30_bonus_today := (v_streak % 30 = 0);

    -- Insert the check-in row; PK conflict means already claimed today.
    INSERT INTO daily_check_ins (user_id, check_in_date, streak_7_paid, streak_30_paid)
    VALUES (v_user_id, v_today, v_streak_7_bonus_today, v_streak_30_bonus_today)
    ON CONFLICT (user_id, check_in_date) DO NOTHING
    RETURNING user_id INTO v_inserted;

    IF v_inserted IS NULL THEN
        -- Already claimed today — return current state without re-awarding.
        RETURN jsonb_build_object(
            'already_claimed_today',  TRUE,
            'current_streak',         v_streak,
            'base_award',             0,
            'streak_7_bonus',         0,
            'streak_30_bonus',        0,
            'total_awarded',          0,
            'streak_7_bonus_today',   FALSE,
            'streak_30_bonus_today',  FALSE,
            'streak_7_progress',      v_streak % 7,
            'streak_30_progress',     v_streak % 30,
            'new_balance',            v_old_balance
        );
    END IF;

    -- Award base +1
    v_running_balance := v_old_balance + 1;
    INSERT INTO coin_transactions (user_id, delta, balance_after, type, reference, note)
    VALUES (v_user_id, 1, v_running_balance, 'daily_login', v_today_str, 'Daily login reward')
    ON CONFLICT (user_id, type, reference) DO NOTHING;

    -- Award 7-day cycle bonus
    IF v_streak_7_bonus_today THEN
        v_running_balance := v_running_balance + 7;
        INSERT INTO coin_transactions (user_id, delta, balance_after, type, reference, note)
        VALUES (v_user_id, 7, v_running_balance, 'daily_login_7_bonus', v_today_str, '7-day streak bonus')
        ON CONFLICT (user_id, type, reference) DO NOTHING;
    END IF;

    -- Award 30-day cycle bonus
    IF v_streak_30_bonus_today THEN
        v_running_balance := v_running_balance + 30;
        INSERT INTO coin_transactions (user_id, delta, balance_after, type, reference, note)
        VALUES (v_user_id, 30, v_running_balance, 'daily_login_30_bonus', v_today_str, '30-day streak bonus')
        ON CONFLICT (user_id, type, reference) DO NOTHING;
    END IF;

    -- Update wallet balance + lifetime_earned in a single write
    UPDATE user_wallets
    SET balance         = v_running_balance,
        lifetime_earned = lifetime_earned + (v_running_balance - v_old_balance),
        updated_at      = now()
    WHERE user_id = v_user_id;

    RETURN jsonb_build_object(
        'already_claimed_today',  FALSE,
        'current_streak',         v_streak,
        'base_award',             1,
        'streak_7_bonus',         CASE WHEN v_streak_7_bonus_today THEN 7 ELSE 0 END,
        'streak_30_bonus',        CASE WHEN v_streak_30_bonus_today THEN 30 ELSE 0 END,
        'total_awarded',          v_running_balance - v_old_balance,
        'streak_7_bonus_today',   v_streak_7_bonus_today,
        'streak_30_bonus_today',  v_streak_30_bonus_today,
        'streak_7_progress',      v_streak % 7,
        'streak_30_progress',     v_streak % 30,
        'new_balance',            v_running_balance
    );
END;
$$;


-- ================================================================
-- RPC 2: award_game_coins(p_type, p_reference, p_delta)
--
-- Awards coins for a completed CLASSIC or PUZZLE round. Idempotent via
-- the (user_id, type, reference) unique constraint — calling twice with
-- the same round reference returns already_awarded=TRUE.
-- ================================================================
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

    IF p_type NOT IN ('quiz_score', 'puzzle_score') THEN
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
        CASE WHEN p_type = 'quiz_score' THEN 'Quiz score reward' ELSE 'Puzzle score reward' END
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
-- RPC 3: award_achievement_coins(p_achievement_id)
--
-- Fixed +10 per achievement unlock. Idempotent via reference=achievement_id.
-- ================================================================
CREATE OR REPLACE FUNCTION public.award_achievement_coins(
    p_achievement_id TEXT
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
    v_delta         INTEGER := 10;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('error', 'not_authenticated');
    END IF;

    INSERT INTO user_wallets (user_id) VALUES (v_user_id)
    ON CONFLICT (user_id) DO NOTHING;

    SELECT balance INTO v_old_balance FROM user_wallets
    WHERE user_id = v_user_id FOR UPDATE;

    INSERT INTO coin_transactions (user_id, delta, balance_after, type, reference, note)
    VALUES (v_user_id, v_delta, v_old_balance + v_delta, 'achievement_unlock', p_achievement_id, 'Achievement unlocked')
    ON CONFLICT (user_id, type, reference) DO NOTHING
    RETURNING id INTO v_inserted;

    IF v_inserted IS NULL THEN
        RETURN jsonb_build_object(
            'awarded',         FALSE,
            'already_awarded', TRUE,
            'new_balance',     v_old_balance
        );
    END IF;

    v_new_balance := v_old_balance + v_delta;
    UPDATE user_wallets
    SET balance         = v_new_balance,
        lifetime_earned = lifetime_earned + v_delta,
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
-- RPC 4: award_all_achievements_bonus()
--
-- One-time +100 when all 10 achievements are unlocked. Idempotent via
-- reference='all_10'.
-- ================================================================
CREATE OR REPLACE FUNCTION public.award_all_achievements_bonus()
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
    v_ach_count     INTEGER;
    v_delta         INTEGER := 100;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('error', 'not_authenticated');
    END IF;

    -- Must have all 10 achievements
    SELECT COUNT(*) INTO v_ach_count
    FROM user_achievements
    WHERE user_id = v_user_id;

    IF v_ach_count < 10 THEN
        RETURN jsonb_build_object(
            'awarded',         FALSE,
            'already_awarded', FALSE,
            'reason',          'not_all_10',
            'achievement_count', v_ach_count,
            'new_balance',     NULL
        );
    END IF;

    INSERT INTO user_wallets (user_id) VALUES (v_user_id)
    ON CONFLICT (user_id) DO NOTHING;

    SELECT balance INTO v_old_balance FROM user_wallets
    WHERE user_id = v_user_id FOR UPDATE;

    INSERT INTO coin_transactions (user_id, delta, balance_after, type, reference, note)
    VALUES (v_user_id, v_delta, v_old_balance + v_delta, 'all_achievements_bonus', 'all_10', 'All achievements bonus')
    ON CONFLICT (user_id, type, reference) DO NOTHING
    RETURNING id INTO v_inserted;

    IF v_inserted IS NULL THEN
        RETURN jsonb_build_object(
            'awarded',         FALSE,
            'already_awarded', TRUE,
            'new_balance',     v_old_balance
        );
    END IF;

    v_new_balance := v_old_balance + v_delta;
    UPDATE user_wallets
    SET balance         = v_new_balance,
        lifetime_earned = lifetime_earned + v_delta,
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
-- RPC 5: spend_scene_game_coins(p_user_id, p_round_ref, p_amount)
--
-- Called by the scene-generate edge function (service role). Deducts
-- p_amount (default 25). Returns success=false on insufficient balance
-- or duplicate round_ref. Does NOT auto-create a wallet — no wallet
-- means zero balance, which means insufficient_balance.
-- ================================================================
CREATE OR REPLACE FUNCTION public.spend_scene_game_coins(
    p_user_id   UUID,
    p_round_ref TEXT,
    p_amount    INTEGER DEFAULT 25
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_balance     INTEGER;
    v_new_balance INTEGER;
    v_inserted    UUID;
BEGIN
    IF p_user_id IS NULL OR p_round_ref IS NULL THEN
        RETURN jsonb_build_object('success', FALSE, 'reason', 'invalid_params');
    END IF;

    -- Lock wallet (no auto-create — no wallet = insufficient)
    SELECT balance INTO v_balance FROM user_wallets
    WHERE user_id = p_user_id FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', FALSE, 'reason', 'insufficient_balance', 'new_balance', 0);
    END IF;

    IF v_balance < p_amount THEN
        RETURN jsonb_build_object('success', FALSE, 'reason', 'insufficient_balance', 'new_balance', v_balance);
    END IF;

    -- Idempotent: reject duplicate round
    INSERT INTO coin_transactions (user_id, delta, balance_after, type, reference, note)
    VALUES (p_user_id, -p_amount, v_balance - p_amount, 'scene_game_spend', p_round_ref, 'Scene game')
    ON CONFLICT (user_id, type, reference) DO NOTHING
    RETURNING id INTO v_inserted;

    IF v_inserted IS NULL THEN
        RETURN jsonb_build_object('success', FALSE, 'reason', 'duplicate_round', 'new_balance', v_balance);
    END IF;

    v_new_balance := v_balance - p_amount;
    UPDATE user_wallets
    SET balance        = v_new_balance,
        lifetime_spent = lifetime_spent + p_amount,
        updated_at     = now()
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
        'success',     TRUE,
        'new_balance', v_new_balance
    );
END;
$$;


-- ================================================================
-- RPC 6: refund_scene_game_coins(p_user_id, p_round_ref, p_amount)
--
-- Called by the edge function when generation fails AFTER coins were
-- deducted. Refuses if no matching spend exists (security: prevents
-- direct-call abuse). Idempotent.
-- ================================================================
CREATE OR REPLACE FUNCTION public.refund_scene_game_coins(
    p_user_id   UUID,
    p_round_ref TEXT,
    p_amount    INTEGER DEFAULT 25
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_balance     INTEGER;
    v_new_balance INTEGER;
    v_inserted    UUID;
BEGIN
    IF p_user_id IS NULL OR p_round_ref IS NULL THEN
        RETURN jsonb_build_object('refunded', FALSE, 'reason', 'invalid_params');
    END IF;

    -- Security: a matching spend must exist
    IF NOT EXISTS (
        SELECT 1 FROM coin_transactions
        WHERE user_id = p_user_id AND type = 'scene_game_spend' AND reference = p_round_ref
    ) THEN
        RETURN jsonb_build_object('refunded', FALSE, 'reason', 'no_matching_spend');
    END IF;

    -- Lock wallet
    SELECT balance INTO v_balance FROM user_wallets
    WHERE user_id = p_user_id FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('refunded', FALSE, 'reason', 'no_wallet');
    END IF;

    -- Idempotent: only refund once per round
    INSERT INTO coin_transactions (user_id, delta, balance_after, type, reference, note)
    VALUES (p_user_id, p_amount, v_balance + p_amount, 'scene_game_refund', p_round_ref, 'Scene game refund')
    ON CONFLICT (user_id, type, reference) DO NOTHING
    RETURNING id INTO v_inserted;

    IF v_inserted IS NULL THEN
        RETURN jsonb_build_object('refunded', FALSE, 'already_refunded', TRUE, 'new_balance', v_balance);
    END IF;

    v_new_balance := v_balance + p_amount;
    -- Refund restores balance and reverses lifetime_spent so stats stay accurate
    UPDATE user_wallets
    SET balance        = v_new_balance,
        lifetime_spent = GREATEST(lifetime_spent - p_amount, 0),
        updated_at     = now()
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
        'refunded',    TRUE,
        'new_balance', v_new_balance
    );
END;
$$;


-- ================================================================
-- RPC 7: get_wallet_state(p_transaction_limit)
--
-- Lightweight read for the header counter and transaction list.
-- ================================================================
CREATE OR REPLACE FUNCTION public.get_wallet_state(
    p_transaction_limit INTEGER DEFAULT 20
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id      UUID;
    v_wallet       RECORD;
    v_transactions JSONB;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('error', 'not_authenticated');
    END IF;

    SELECT * INTO v_wallet FROM user_wallets WHERE user_id = v_user_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'balance',         0,
            'lifetime_earned', 0,
            'lifetime_spent',  0,
            'transactions',    '[]'::jsonb
        );
    END IF;

    SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO v_transactions
    FROM (
        SELECT id, delta, balance_after, type, reference, note, created_at
        FROM coin_transactions
        WHERE user_id = v_user_id
        ORDER BY created_at DESC
        LIMIT LEAST(GREATEST(p_transaction_limit, 1), 100)
    ) t;

    RETURN jsonb_build_object(
        'balance',         v_wallet.balance,
        'lifetime_earned', v_wallet.lifetime_earned,
        'lifetime_spent',  v_wallet.lifetime_spent,
        'transactions',    v_transactions
    );
END;
$$;


-- ========== Grants ==========
-- User-facing functions: callable by authenticated users
GRANT EXECUTE ON FUNCTION public.claim_daily_login_reward() TO authenticated;
GRANT EXECUTE ON FUNCTION public.award_game_coins(TEXT, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.award_achievement_coins(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.award_all_achievements_bonus() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_wallet_state(INTEGER) TO authenticated;

-- Service-only functions: intentionally NOT granted to authenticated/anon.
-- These are called from the scene-generate edge function using the service
-- role key, which bypasses all permission checks anyway. We REVOKE from
-- PUBLIC so anon/authenticated keys cannot call them directly.
REVOKE EXECUTE ON FUNCTION public.spend_scene_game_coins(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refund_scene_game_coins(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;

-- Table reads (guarded by RLS)
GRANT SELECT ON public.user_wallets TO authenticated;
GRANT SELECT ON public.coin_transactions TO authenticated;
GRANT SELECT ON public.daily_check_ins TO authenticated;
