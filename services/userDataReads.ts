import { supabase } from '../lib/supabaseClient.ts';
import type { WordEntry } from '../types.ts';

let identityEpoch = 0;

/** Called by the existing auth listener on every account identity transition. */
export function invalidateUserDataReads(): void { identityEpoch++; }

export interface UserReadContext { assertCurrent(): void; }

/** Every call starts a fresh read while rejecting work from a superseded identity. */
export function readForCurrentIdentity<T>(load: (context: UserReadContext) => Promise<T>): Promise<T> {
  const epoch = identityEpoch;
  const assertCurrent = () => {
    if (identityEpoch !== epoch) throw new Error('Account changed while reading cloud data. Please retry for the current account.');
  };
  return Promise.resolve().then(() => {
    assertCurrent();
    return load({ assertCurrent });
  }).then(result => { assertCurrent(); return result; });
}

/** Share only concurrent reads. Completed or failed reads never become a cache. */
export function coalesceUserReads<T>(load: (userId: string, context: UserReadContext) => Promise<T>): (userId: string) => Promise<T> {
  const pending = new Map<string, { epoch: number; work: Promise<T> }>();
  return userId => {
    const active = pending.get(userId);
    if (active?.epoch === identityEpoch) return active.work;
    const epoch = identityEpoch;
    const work = readForCurrentIdentity(context => load(userId, context)).finally(() => {
      // A superseded request must not remove the replacement account generation.
      if (pending.get(userId)?.work === work) pending.delete(userId);
    });
    pending.set(userId, { epoch, work });
    return work;
  };
}

export type WordLearningProgress = Pick<WordEntry,
  'id' | 'correct' | 'tested' | 'score' | 'error_count' | 'consecutive_correct' |
  'last_tested' | 'best_time_ms' | 'review_state' | 'learning_revision'>;

// These columns are the public.words projection maintained by learning_event_sync_v1.
const LEARNING_FIELDS = 'id,correct,tested,score,error_count,consecutive_correct,last_tested,best_time_ms,review_state,learning_revision';
const LEARNING_PAGE_SIZE = 500;

export function mapWordLearningProgress(row: Record<string, any>): WordLearningProgress {
  return {
    id: row.id,
    correct: row.correct,
    tested: row.tested,
    score: row.score ?? 0,
    error_count: row.error_count ?? 0,
    consecutive_correct: row.consecutive_correct ?? 0,
    last_tested: row.last_tested ? new Date(row.last_tested).getTime() : null,
    best_time_ms: row.best_time_ms ?? null,
    review_state: row.review_state ?? null,
    learning_revision: row.learning_revision ?? 0,
  };
}

/** Periodic progress reads never fetch sessions, media metadata, or run image repairs. */
export const fetchUserLearningProgress = coalesceUserReads(async (userId: string, { assertCurrent }): Promise<WordLearningProgress[]> => {
  const words: WordLearningProgress[] = [];
  let after: string | null = null;
  while (true) {
    assertCurrent();
    let query = supabase.from('words').select(LEARNING_FIELDS)
      .eq('user_id', userId).or('deleted.eq.false,deleted.is.null')
      .order('id', { ascending: true }).limit(LEARNING_PAGE_SIZE);
    if (after !== null) query = query.gt('id', after);
    const { data, error } = await query;
    assertCurrent();
    if (error) throw new Error(`Failed to refresh learning progress: ${error.message}`);
    const rows = data ?? [];
    words.push(...rows.map(mapWordLearningProgress));
    if (rows.length < LEARNING_PAGE_SIZE) return words;
    const next = rows[rows.length - 1].id;
    if (typeof next !== 'string' || next === after) throw new Error('Learning progress pagination did not advance.');
    after = next;
  }
});
