import type { WordEntry } from '../../types.ts';
import { persistLearningAttempt, readLearningJournal, type LearningStorage } from '../../services/learningRecordStore.ts';
import { currentSurfWord } from './game.ts';
import type { SurfState } from './types.ts';

export interface SavedSurfAttempt {
  wordId: string; answer: string;
  /** Missing only for V1 attempts written by the old learning-first path. */
  learning?: {
    eventId: string; occurredAt: number; correct: boolean; hadMistake: boolean;
    /** Active time on this word. Missing on older rides; never infer it on replay. */
    durationMs?: number | null;
  };
}
export interface SavedRide {
  version: 1; runId: string; attempts: SavedSurfAttempt[]; snapshot: SurfState | null;
  receiptConfirmed: boolean;
}
export class SurfJournalError extends Error {}
const key = (userId: string) => `vocab_monster_surf_v1:${userId}`;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function readSurfRide(userId: string, storage: LearningStorage = localStorage): SavedRide | null {
  try {
    const raw = storage.getItem(key(userId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!object(value) || value.version !== 1 || typeof value.runId !== 'string' || !value.runId
      || !Array.isArray(value.attempts) || !(value.snapshot === null || object(value.snapshot))
      || (value.receiptConfirmed !== undefined && typeof value.receiptConfirmed !== 'boolean')) throw new Error('Invalid ride');
    for (const attempt of value.attempts) {
      if (!object(attempt) || typeof attempt.wordId !== 'string' || typeof attempt.answer !== 'string') throw new Error('Invalid attempt');
      if (attempt.learning !== undefined) {
        const learning = attempt.learning;
        if (!object(learning) || typeof learning.eventId !== 'string' || !learning.eventId
          || typeof learning.occurredAt !== 'number' || !Number.isFinite(learning.occurredAt) || learning.occurredAt <= 0
          || typeof learning.correct !== 'boolean' || typeof learning.hadMistake !== 'boolean') throw new Error('Invalid learning event');
        if (learning.durationMs != null && (typeof learning.durationMs !== 'number'
          || !Number.isFinite(learning.durationMs) || learning.durationMs < 0
          || learning.durationMs > 3_600_000)) throw new Error('Invalid answer duration');
      }
    }
    return { ...value, receiptConfirmed: value.receiptConfirmed === true } as unknown as SavedRide;
  } catch { throw new SurfJournalError('The saved ride could not be read.'); }
}

export function writeSurfRide(userId: string, ride: SavedRide, storage: LearningStorage = localStorage): void {
  try { storage.setItem(key(userId), JSON.stringify(ride)); }
  catch { throw new SurfJournalError('The ride could not be saved.'); }
}

/** One durable write contains both the resolved answer and its exact learning event. */
export function appendSurfAttempt(ride: SavedRide, before: SurfState, next: SurfState, occurredAt: number, eventId: string): SavedRide {
  const wordId = currentSurfWord(before).wordId;
  if (!wordId) throw new SurfJournalError('An account word ID is required.');
  const attempt: SavedSurfAttempt = { wordId, answer: before.input, learning: {
    eventId, occurredAt, correct: next.correct > before.correct,
    hadMistake: ride.attempts.some(attempt => attempt.wordId === wordId),
    durationMs: typeof before.wordElapsedMs === 'number' && Number.isFinite(before.wordElapsedMs)
      && before.wordElapsedMs > 0 && before.wordElapsedMs <= 3_600_000 ? Math.round(before.wordElapsedMs) : null,
  } };
  return { ...ride, attempts: [...ride.attempts, attempt], snapshot: next };
}

/** Retry from the WAL using immutable IDs/timestamps; never fabricate a new answer. */
export function replaySurfLearning(userId: string, ride: SavedRide | null, words: WordEntry[], storage: LearningStorage = localStorage): { words: WordEntry[]; missingWordIds: string[] } {
  if (!ride) return { words, missingWordIds: [] };
  const byId = new Map(words.map(word => [word.id, word]));
  const stored = readLearningJournal(userId, storage);
  const missing = new Set<string>();
  for (const attempt of ride.attempts) {
    // Legacy attempts were only saved after their learning write succeeded.
    if (!attempt.learning) continue;
    const entry = byId.get(attempt.wordId);
    if (!entry) {
      if (!stored.events[attempt.learning.eventId]) missing.add(attempt.wordId);
      continue;
    }
    const updated = persistLearningAttempt(userId, entry, {
      wordId: entry.id, status: attempt.learning.correct ? 'correct' : 'incorrect', hintUsed: false,
      hadMistake: attempt.learning.hadMistake, durationMs: attempt.learning.durationMs ?? null,
    }, attempt.learning.eventId, attempt.learning.occurredAt, storage);
    byId.set(entry.id, updated);
  }
  return { words: words.map(word => byId.get(word.id)!), missingWordIds: [...missing] };
}

export const hasUnconfirmedSurfReceipt = (ride: SavedRide | null): ride is SavedRide & { snapshot: SurfState & { phase: 'over' }; receiptConfirmed: false } =>
  Boolean(ride?.snapshot?.phase === 'over' && !ride.receiptConfirmed);
