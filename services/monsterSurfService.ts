import { supabase } from '../lib/supabaseClient.ts';
import { DEFAULT_SURF_RUN_MODE, isSurfRunMode, type SurfRunMode } from '../features/monster-surf/runMode.ts';

export const MONSTER_SURF_ENTRY_FEE = 1;
export const MONSTER_SURF_CRYSTALS_PER_COIN = 10;

export interface MonsterSurfRunWord {
  wordId: string;
  answer: string;
  meaningZh: string;
  meaningEn: string;
  audioUrl: string | null;
}
export interface MonsterSurfRun {
  id: string;
  status: 'active' | 'settled';
  /** Null only for paid runs created before mode selection was introduced. */
  mode: SurfRunMode | null;
  words: MonsterSurfRunWord[];
  startedAt: string;
  settledAt: string | null;
  entryFee: number;
  crystals: number;
  correctCount: number;
  rewardCoins: number;
  netCoins: number;
}
/** Every nonempty submitted answer, in order. Corrections retain the same word. */
export interface MonsterSurfAttempt { wordId: string; answer: string; }
export interface MonsterSurfAccount { balance: number; activeRun: MonsterSurfRun | null; }
export interface MonsterSurfStartResult { run: MonsterSurfRun; balance: number; charged: boolean; recovered: boolean; }
export interface MonsterSurfSettlement { run: MonsterSurfRun; balance: number; alreadySettled: boolean; }

export class MonsterSurfServiceError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = 'MonsterSurfServiceError';
    this.code = code;
  }
}

export interface MonsterSurfRpcTransport {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { message: string; code?: string } | null;
  }>;
}

/** A display estimate only. The database independently calculates the award. */
export function estimateMonsterSurfReward(correctWords: number, crystals: number): number {
  if (!Number.isFinite(correctWords) || !Number.isFinite(crystals)) return 0;
  return Math.min(Math.max(0, Math.floor(correctWords)), Math.floor(Math.max(0, crystals) / MONSTER_SURF_CRYSTALS_PER_COIN));
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MonsterSurfServiceError('unexpected_response');
  return value as Record<string, unknown>;
};
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new MonsterSurfServiceError('unexpected_response');
  return value as number;
};
const string = (value: unknown): string => {
  if (typeof value !== 'string') throw new MonsterSurfServiceError('unexpected_response');
  return value;
};
const boolean = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new MonsterSurfServiceError('unexpected_response');
  return value;
};
function parseRun(value: unknown): MonsterSurfRun {
  const raw = record(value);
  if (raw.status !== 'active' && raw.status !== 'settled') throw new MonsterSurfServiceError('unexpected_response');
  if (!Array.isArray(raw.words) || raw.words.length < 1) throw new MonsterSurfServiceError('unexpected_response');
  let mode: SurfRunMode | null = null;
  if (raw.mode != null) {
    if (!isSurfRunMode(raw.mode)) throw new MonsterSurfServiceError('unexpected_response');
    mode = raw.mode;
  }
  if (mode?.kind === 'fixed' && raw.words.length > mode.wordCount) throw new MonsterSurfServiceError('unexpected_response');
  const words = raw.words.map(value => {
    const word = record(value);
    return {
      wordId: string(word.word_id), answer: string(word.answer), meaningZh: string(word.meaning_zh),
      meaningEn: string(word.meaning_en), audioUrl: word.audio_url === null ? null : string(word.audio_url),
    };
  });
  const correctCount = integer(raw.correct_count, 0, words.length);
  const rewardCoins = integer(raw.reward_coins, 0, correctCount);
  const entryFee = integer(raw.entry_fee, MONSTER_SURF_ENTRY_FEE, MONSTER_SURF_ENTRY_FEE);
  const crystals = integer(raw.crystals, 0, 1000000);
  const netCoins = integer(raw.net_coins, -MONSTER_SURF_ENTRY_FEE, words.length - MONSTER_SURF_ENTRY_FEE);
  if (netCoins !== rewardCoins - entryFee || rewardCoins !== estimateMonsterSurfReward(correctCount, crystals)) {
    throw new MonsterSurfServiceError('unexpected_response');
  }
  if ((raw.status === 'active') !== (raw.settled_at === null)) throw new MonsterSurfServiceError('unexpected_response');
  return {
    id: string(raw.id), status: raw.status, mode, words, startedAt: string(raw.started_at),
    settledAt: raw.settled_at === null ? null : string(raw.settled_at),
    entryFee, crystals, correctCount, rewardCoins, netCoins,
  };
}

/** Injectable transport tests retry/error contracts without a mock database. */
export function createMonsterSurfService(transport: MonsterSurfRpcTransport) {
  const call = async (name: string, args?: Record<string, unknown>) => {
    let reply: Awaited<ReturnType<MonsterSurfRpcTransport['rpc']>>;
    try { reply = await transport.rpc(name, args); }
    catch (error) {
      throw new MonsterSurfServiceError('network_error', error instanceof Error ? error.message : 'Network request failed');
    }
    if (reply.error) {
      const missingBackend = reply.error.code === 'PGRST202' || reply.error.code === '42883';
      throw new MonsterSurfServiceError(missingBackend ? 'backend_unavailable' : 'request_failed', reply.error.message);
    }
    const body = record(reply.data);
    if (typeof body.error === 'string') throw new MonsterSurfServiceError(body.error);
    return body;
  };
  return {
    async getMonsterSurfAccount(): Promise<MonsterSurfAccount> {
      const body = await call('get_monster_surf_account_v1');
      return { balance: integer(body.balance), activeRun: body.active_run === null ? null : parseRun(body.active_run) };
    },
    /** Reuse runId after every ambiguous response; never create a new UUID on retry. */
    async startMonsterSurfRun(runId: string, wordIds: string[], mode: SurfRunMode = DEFAULT_SURF_RUN_MODE): Promise<MonsterSurfStartResult> {
      if (!isSurfRunMode(mode)) throw new MonsterSurfServiceError('invalid_mode');
      const body = await call('start_monster_surf_run_v2', { p_run_id: runId, p_word_ids: wordIds, p_mode: mode });
      return { run: parseRun(body.run), balance: integer(body.balance), charged: boolean(body.charged), recovered: boolean(body.recovered) };
    },
    /** Persist this exact payload until success. A repeated call cannot pay twice. */
    async settleMonsterSurfRun(runId: string, crystals: number, attempts: MonsterSurfAttempt[]): Promise<MonsterSurfSettlement> {
      const body = await call('settle_monster_surf_run_v1', {
        p_run_id: runId, p_crystals: crystals,
        p_attempts: attempts.map(attempt => ({ word_id: attempt.wordId, answer: attempt.answer })),
      });
      const run = parseRun(body.run);
      if (run.status !== 'settled' || run.id !== runId) throw new MonsterSurfServiceError('unexpected_response');
      return { run, balance: integer(body.balance), alreadySettled: boolean(body.already_settled) };
    },
  };
}

const service = createMonsterSurfService({ rpc: (name, args) => supabase.rpc(name, args) });
export const getMonsterSurfAccount = service.getMonsterSurfAccount;
export const startMonsterSurfRun = service.startMonsterSurfRun;
export const settleMonsterSurfRun = service.settleMonsterSurfRun;
