import { supabase } from '../lib/supabaseClient';

// ─── Constants ───────────────────────────────────────────────────────────────
export const SCENE_GAME_COST = 25;

// ─── Types ───────────────────────────────────────────────────────────────────
export interface DailyLoginReward {
  already_claimed_today: boolean;
  current_streak: number;
  base_award: number;
  streak_7_bonus: number;
  streak_30_bonus: number;
  total_awarded: number;
  streak_7_bonus_today: boolean;
  streak_30_bonus_today: boolean;
  streak_7_progress: number;
  streak_30_progress: number;
  new_balance: number;
}

export interface CoinTransaction {
  id: string;
  delta: number;
  balance_after: number;
  type: string;
  reference: string | null;
  note: string | null;
  created_at: string;
}

export interface WalletState {
  balance: number;
  lifetime_earned: number;
  lifetime_spent: number;
  transactions: CoinTransaction[];
}

// ─── Functions ───────────────────────────────────────────────────────────────

/**
 * Claim the daily login reward. Server-side computes the streak, 7-day and
 * 30-day bonuses, and returns the full breakdown. Idempotent: calling again
 * on the same day returns already_claimed_today=true with zero awards.
 */
export const claimDailyLoginReward = async (): Promise<DailyLoginReward | null> => {
  try {
    const { data, error } = await supabase.rpc('claim_daily_login_reward');
    if (error) {
      console.error('[coinService] claimDailyLoginReward error:', error.message);
      return null;
    }
    return (data as DailyLoginReward) ?? null;
  } catch (e) {
    console.error('[coinService] claimDailyLoginReward exception:', e);
    return null;
  }
};

/**
 * Award coins for a CLASSIC quiz round. Internally computes Math.round(score/100).
 * Idempotent: calling twice with the same roundId returns 0 (already awarded).
 * @returns number of coins actually awarded (0 if already awarded or error)
 */
export const awardQuizCoins = async (roundId: string, score: number): Promise<number> => {
  const delta = Math.round(score / 100);
  if (delta <= 0) return 0;
  try {
    const { data, error } = await supabase.rpc('award_game_coins', {
      p_type: 'quiz_score',
      p_reference: roundId,
      p_delta: delta,
    });
    if (error) {
      console.error('[coinService] awardQuizCoins error:', error.message);
      return 0;
    }
    return data?.awarded ? delta : 0;
  } catch (e) {
    console.error('[coinService] awardQuizCoins exception:', e);
    return 0;
  }
};

/**
 * Award coins for a PUZZLE round. Internally computes Math.round(score/100).
 * Idempotent via roundId.
 */
export const awardPuzzleCoins = async (roundId: string, score: number): Promise<number> => {
  const delta = Math.round(score / 100);
  if (delta <= 0) return 0;
  try {
    const { data, error } = await supabase.rpc('award_game_coins', {
      p_type: 'puzzle_score',
      p_reference: roundId,
      p_delta: delta,
    });
    if (error) {
      console.error('[coinService] awardPuzzleCoins error:', error.message);
      return 0;
    }
    return data?.awarded ? delta : 0;
  } catch (e) {
    console.error('[coinService] awardPuzzleCoins exception:', e);
    return 0;
  }
};

/**
 * Award +10 for unlocking an achievement. Idempotent via achievementId.
 * Safe to call for pre-existing achievements (backfill path).
 */
export const awardAchievementCoins = async (achievementId: string): Promise<number> => {
  try {
    const { data, error } = await supabase.rpc('award_achievement_coins', {
      p_achievement_id: achievementId,
    });
    if (error) {
      console.error('[coinService] awardAchievementCoins error:', error.message);
      return 0;
    }
    return data?.awarded ? 10 : 0;
  } catch (e) {
    console.error('[coinService] awardAchievementCoins exception:', e);
    return 0;
  }
};

/**
 * One-time +100 bonus for unlocking all 10 achievements. Returns 0 if not all
 * 10 are unlocked yet or if already awarded.
 */
export const awardAllAchievementsBonus = async (): Promise<number> => {
  try {
    const { data, error } = await supabase.rpc('award_all_achievements_bonus');
    if (error) {
      console.error('[coinService] awardAllAchievementsBonus error:', error.message);
      return 0;
    }
    return data?.awarded ? 100 : 0;
  } catch (e) {
    console.error('[coinService] awardAllAchievementsBonus exception:', e);
    return 0;
  }
};

/**
 * Lightweight read of just the current balance. Used by the header counter
 * and post-transaction refreshes.
 */
export const getCoinBalance = async (): Promise<number> => {
  try {
    const { data, error } = await supabase.rpc('get_wallet_state', { p_transaction_limit: 1 });
    if (error) {
      console.error('[coinService] getCoinBalance error:', error.message);
      return 0;
    }
    return data?.balance ?? 0;
  } catch (e) {
    console.error('[coinService] getCoinBalance exception:', e);
    return 0;
  }
};

/**
 * Full wallet state including recent transaction history.
 */
export const getWalletState = async (transactionLimit = 20): Promise<WalletState | null> => {
  try {
    const { data, error } = await supabase.rpc('get_wallet_state', {
      p_transaction_limit: transactionLimit,
    });
    if (error) {
      console.error('[coinService] getWalletState error:', error.message);
      return null;
    }
    return (data as WalletState) ?? null;
  } catch (e) {
    console.error('[coinService] getWalletState exception:', e);
    return null;
  }
};
