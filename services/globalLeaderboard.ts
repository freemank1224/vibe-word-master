import { supabase } from '../lib/supabaseClient.ts';
import { getWalletRefreshRevision } from './walletUpdates.ts';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------
export type ChampionCategory =
  | 'daily_total'
  | 'achievements'
  | 'game_total'
  | 'word_mastery'
  | 'coins';

export interface ChampionInfo {
  category: ChampionCategory;
  categoryLabel: string;
  categoryIcon: string;
  championUserId: string;
  championName: string;
  championAvatar: string | null;
  scoreValue: number;
  scoreLabel: string;
}

export interface LeaderboardRow {
  rankPosition: number;
  userId: string;
  displayName: string;
  emailMasked: string;
  avatarUrl: string | null;
  scoreValue: number;
  scoreLabel: string;
  isCurrentUser: boolean;
}

// ------------------------------------------------------------------
// Champions (banner) — 5-minute client cache
// ------------------------------------------------------------------
const CHAMPIONS_CACHE_TTL_MS = 5 * 60 * 1000;

interface ChampionsCache {
  data: ChampionInfo[];
  fetchedAt: number;
}

let championsCache: ChampionsCache | null = null;
let championsInFlight: Promise<ChampionInfo[]> | null = null;
let coinRowsVersion = 0;
let latestCoinRows: LeaderboardRow[] = [];

const normalizeChampion = (row: any): ChampionInfo => ({
  category: row.category as ChampionCategory,
  categoryLabel: row.category_label ?? '',
  categoryIcon: row.category_icon ?? '',
  championUserId: row.champion_user_id ?? '',
  championName: row.champion_name ?? '',
  championAvatar: row.champion_avatar ?? null,
  scoreValue: Number(row.score_value ?? 0),
  scoreLabel: row.score_label ?? '',
});

/**
 * Fetch all 5 champion summaries for the rotating banner.
 * Cached in-module for 5 minutes; concurrent callers share a single in-flight
 * request. Pass `forceRefresh` to bypass the cache (used by the modal).
 */
export const fetchGlobalChampions = async (
  forceRefresh = false,
): Promise<ChampionInfo[]> => {
  const now = Date.now();
  if (
    !forceRefresh &&
    championsCache &&
    now - championsCache.fetchedAt < CHAMPIONS_CACHE_TTL_MS
  ) {
    return championsCache.data;
  }

  // De-dup concurrent calls.
  if (championsInFlight) {
    return championsInFlight;
  }

  championsInFlight = (async () => {
    const coinsAtRequestStart = coinRowsVersion;
    const { data, error } = await supabase.rpc('get_global_champions');
    if (error) {
      console.error(
        '[fetchGlobalChampions] RPC failed:',
        error.message,
      );
      // Keep stale cache (if any) on transient errors so the banner stays stable.
      championsInFlight = null;
      throw error;
    }
    const initial = (Array.isArray(data) ? data : []).map(normalizeChampion);
    const champions = coinsAtRequestStart === coinRowsVersion ? initial : withCoinChampion(initial, latestCoinRows);
    championsCache = { data: champions, fetchedAt: Date.now() };
    championsInFlight = null;
    return champions;
  })();

  return championsInFlight;
};

// ------------------------------------------------------------------
// Leaderboard (modal) — always fresh
// ------------------------------------------------------------------
const normalizeRow = (row: any): LeaderboardRow => ({
  rankPosition: Number(row.rank_position ?? 0),
  userId: row.user_id ?? '',
  displayName: row.display_name ?? '',
  emailMasked: row.email_masked ?? '',
  avatarUrl: row.avatar_url ?? null,
  scoreValue: Number(row.score_value ?? 0),
  scoreLabel: row.score_label ?? '',
  isCurrentUser: Boolean(row.is_current_user),
});

const leaderboardRequests = new Map<string, Promise<LeaderboardRow[]>>();

/** Replace only the wealth slide; learning and game scores stay untouched. */
export function withCoinChampion(champions: ChampionInfo[], rows: LeaderboardRow[]): ChampionInfo[] {
  const leader = rows.find(row => row.rankPosition === 1);
  const previous = champions.find(champion => champion.category === 'coins');
  const next: ChampionInfo | null = leader ? {
    category: 'coins', categoryLabel: previous?.categoryLabel ?? 'Coins', categoryIcon: previous?.categoryIcon ?? 'monetization_on',
    championUserId: leader.userId, championName: leader.displayName || leader.emailMasked,
    championAvatar: leader.avatarUrl, scoreValue: leader.scoreValue, scoreLabel: leader.scoreLabel,
  } : null;
  if (!next) return champions.filter(champion => champion.category !== 'coins');
  return previous ? champions.map(champion => champion.category === 'coins' ? next : champion) : [...champions, next];
}

/**
 * Fetch the ranked leaderboard for a single category. Always hits the
 * network (the modal is opened on user intent → fresh data expected).
 * Returns top-`limit` rows plus the current user's row if they're outside
 * the top N.
 */
export const fetchGlobalLeaderboard = async (
  category: ChampionCategory,
  limit = 10,
): Promise<LeaderboardRow[]> => {
  const { data: { session } } = await supabase.auth.getSession();
  // The response includes is_current_user; never share an in-flight response across accounts.
  const revision = category === 'coins' ? getWalletRefreshRevision() : 0;
  const key = `${session?.user.id ?? 'anonymous'}:${category}:${limit}:${revision}`;
  const pending = leaderboardRequests.get(key);
  if (pending) return pending;
  const request = (async () => {
    const { data, error } = await supabase.rpc('get_global_leaderboard', {
      p_category: category,
      p_limit: limit,
    });
    if (error) {
      console.error(`[fetchGlobalLeaderboard] RPC failed for ${category}:`, error.message);
      throw error;
    }
    const rows = (Array.isArray(data) ? data : []).map(normalizeRow);
    if (category === 'coins' && revision === getWalletRefreshRevision()) {
      coinRowsVersion++;
      latestCoinRows = rows;
      if (championsCache) championsCache = { ...championsCache, data: withCoinChampion(championsCache.data, rows) };
    }
    return rows;
  })();
  leaderboardRequests.set(key, request);
  try { return await request; }
  finally { if (leaderboardRequests.get(key) === request) leaderboardRequests.delete(key); }
};

// ------------------------------------------------------------------
// Convenience: clear the in-memory cache (e.g. after logout)
// ------------------------------------------------------------------
export const clearGlobalChampionsCache = () => {
  championsCache = null;
  championsInFlight = null;
};
