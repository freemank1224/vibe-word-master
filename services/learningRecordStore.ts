import type { WordEntry } from '../types.ts';
import { emptyLearningPatch, normalizeLearningEvent, normalizeLearningPatch, projectLearningEvents, sameLearningEvent } from './learningReplay.ts';
import type { LearningEvent, LearningPatch, LearningReplayWord } from './learningReplay.ts';
export type { LearningPatch } from './learningReplay.ts';

export interface LearningResult {
  wordId: string;
  status: 'correct' | 'incorrect' | 'skipped' | 'unattempted';
  hintUsed: boolean;
  hadMistake: boolean;
  durationMs?: number | null;
  /** Preserve classic-mode fractional scoring while sharing the recall scheduler. */
  score?: number;
  errorDelta?: number;
}
export interface StoredLearningWord { patch: LearningPatch; eventId: string; pending: boolean; revision: number; }
export interface StoredLearningEvent { event: LearningEvent; pending: boolean; }
export interface LearningJournal {
  version: 2;
  words: Record<string, StoredLearningWord>;
  bases: Record<string, LearningPatch>;
  /** A newer fetched projection can seed immediate feedback before replay sync. */
  checkpoints: Record<string, LearningPatch>;
  events: Record<string, StoredLearningEvent>;
  rounds: Record<string, number>;
}
export type LearningStorage = Pick<Storage, 'getItem' | 'setItem'>;
// Keep the existing account-scoped key so upgrades cannot orphan pending V1 records.
const key = (userId: string) => `vibe_learning_v1:${userId}`;
const empty = (): LearningJournal => ({ version: 2, words: {}, bases: {}, checkpoints: {}, events: {}, rounds: {} });
const dictionary = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const own = (value: object, name: string) => Object.hasOwn(value, name);
const set = <T>(value: Record<string, T>, name: string, item: T) => Object.defineProperty(value, name, { value: item, writable: true, configurable: true, enumerable: true });

export function readLearningJournal(userId: string, storage: LearningStorage = localStorage): LearningJournal {
  if (!userId) throw new Error('需要登录后读取学习记录。');
  const raw = storage.getItem(key(userId));
  if (!raw) return empty();
  const value = JSON.parse(raw);
  if (!dictionary(value) || !dictionary(value.words) || !dictionary(value.rounds) || ![1, 2].includes(Number(value.version))) throw new Error('学习记录格式异常，请保留本机数据后重试。');
  const journal = empty();
  for (const [roundId, at] of Object.entries(value.rounds)) {
    if (!validTime(at)) throw new Error('学习局记录时间异常。');
    set(journal.rounds, roundId, at);
  }
  for (const [wordId, stored] of Object.entries(value.words)) {
    if (!dictionary(stored) || typeof stored.eventId !== 'string' || !stored.eventId || typeof stored.pending !== 'boolean') throw new Error('本地学习进度格式异常。');
    const patch = normalizeLearningPatch(stored.patch);
    const revision = stored.revision ?? 0;
    if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw new Error('本地学习版本异常。');
    set(journal.words, wordId, { patch, eventId: stored.eventId, pending: stored.pending, revision: revision as number });
    if (value.version === 1) {
      set(journal.bases, wordId, stored.pending ? emptyLearningPatch() : patch);
      if (stored.pending) {
        if (!validTime(patch.last_tested)) throw new Error('旧学习记录缺少时间，不能安全同步。');
        const event = normalizeLearningEvent({ event_id: stored.eventId, word_id: wordId, occurred_at: patch.last_tested,
          kind: 'legacy_snapshot', outcome: patch.review_state?.lastOutcome ?? (patch.correct ? 'independent' : 'incorrect'), duration_ms: null, snapshot: patch });
        set(journal.events, event.event_id, { event, pending: true });
      }
    }
  }
  if (value.version === 2) {
    if (!dictionary(value.bases) || !dictionary(value.events)) throw new Error('学习事件日志格式异常。');
    for (const [wordId, base] of Object.entries(value.bases)) set(journal.bases, wordId, normalizeLearningPatch(base));
    if (value.checkpoints != null && !dictionary(value.checkpoints)) throw new Error('本地学习检查点格式异常。');
    for (const [wordId, patch] of Object.entries(value.checkpoints ?? {})) set(journal.checkpoints, wordId, normalizeLearningPatch(patch));
    for (const [eventId, stored] of Object.entries(value.events)) {
      if (!dictionary(stored) || typeof stored.pending !== 'boolean') throw new Error('本地学习事件状态异常。');
      const event = normalizeLearningEvent(stored.event);
      if (event.event_id !== eventId || !own(journal.bases, event.word_id)) throw new Error('本地学习事件归属异常。');
      set(journal.events, eventId, { event, pending: stored.pending });
    }
    for (const wordId of Object.keys(journal.words)) {
      if (!own(journal.bases, wordId)) throw new Error('本地学习记录缺少重放基线。');
    }
  }
  return journal;
}

function write(userId: string, journal: LearningJournal, storage: LearningStorage) {
  // One atomic write; quota/corruption errors must reach the caller before leaving a question.
  storage.setItem(key(userId), JSON.stringify(journal));
}
function eventsFor(journal: LearningJournal, wordId: string) {
  return Object.values(journal.events).filter(stored => stored.event.word_id === wordId);
}
function rebuild(journal: LearningJournal, wordId: string, revision?: number) {
  const entries = eventsFor(journal, wordId);
  if (!entries.length) return;
  const ordered = entries.map(value => value.event).sort((a, b) => a.occurred_at - b.occurred_at || (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0));
  set(journal.words, wordId, {
    patch: own(journal.checkpoints, wordId)
      ? projectLearningEvents(journal.checkpoints[wordId], entries.filter(value => value.pending).map(value => value.event))
      : projectLearningEvents(journal.bases[wordId], ordered),
    eventId: ordered[ordered.length - 1].event_id, pending: entries.some(value => value.pending),
    revision: revision ?? journal.words[wordId]?.revision ?? 0,
  });
}
function append(journal: LearningJournal, word: WordEntry, event: LearningEvent) {
  const existing = own(journal.events, event.event_id) ? journal.events[event.event_id] : undefined;
  if (existing) {
    if (!sameLearningEvent(existing.event, event)) throw new Error('同一学习事件编号对应了不同内容。');
    return;
  }
  if (!own(journal.bases, word.id)) set(journal.bases, word.id, normalizeLearningPatch(word));
  const previous = journal.words[word.id];
  if (previous && (word.learning_revision || 0) > previous.revision && !eventsFor(journal, word.id).some(value => value.pending)) {
    // All older local events were acknowledged, so the newer cloud projection
    // already contains them. Apply only subsequent local answers for the UI.
    set(journal.checkpoints, word.id, normalizeLearningPatch(word));
    previous.revision = word.learning_revision!;
  }
  set(journal.events, event.event_id, { event, pending: true });
  rebuild(journal, word.id);
}
function resultEvent(result: LearningResult, eventId: string, occurredAt: number): LearningEvent | null {
  if (result.status === 'skipped' || result.status === 'unattempted') return null;
  if (!['correct', 'incorrect'].includes(result.status)) throw new Error('学习作答状态无效。');
  return normalizeLearningEvent({
    event_id: eventId, word_id: result.wordId, occurred_at: occurredAt, kind: 'answer',
    outcome: result.status === 'incorrect' ? 'incorrect' : result.hintUsed || result.hadMistake ? 'assisted' : 'independent',
    duration_ms: result.durationMs ?? null, score: result.score, error_delta: result.errorDelta,
  });
}

export function overlayLearningProgress(userId: string, words: WordEntry[], storage: LearningStorage = localStorage): WordEntry[] {
  const journal = readLearningJournal(userId, storage);
  return words.map(word => {
    const local = journal.words[word.id];
    if (!local) return word;
    const cloudRevision = word.learning_revision || 0;
    // Pending events stay visible until the server merges them. An acknowledged older
    // projection must not hide a newer revision fetched from a second device.
    const useLocal = local.pending || local.revision > cloudRevision ||
      (local.revision === cloudRevision && (local.patch.last_tested || 0) >= (word.last_tested || 0));
    return useLocal ? { ...word, ...local.patch, learning_revision: Math.max(cloudRevision, local.revision) } : word;
  });
}

/** Persist the actual resolved answer, not a guessed delta from a final snapshot. */
export function persistLearningAttempt(userId: string, word: WordEntry, result: LearningResult, eventId: string, occurredAt: number, storage: LearningStorage = localStorage): WordEntry {
  if (word.id !== result.wordId || word.deleted) throw new Error('学习事件与单词不匹配。');
  const event = resultEvent(result, eventId, occurredAt);
  if (!event) return word;
  const journal = readLearningJournal(userId, storage);
  append(journal, word, event);
  write(userId, journal, storage);
  return overlayLearningProgress(userId, [word], storage)[0];
}

/** Compatibility for callers/V1 data that only possess a final snapshot. */
export function persistLearningPatch(userId: string, wordId: string, patch: LearningPatch, eventId: string, storage: LearningStorage = localStorage): void {
  const normalized = normalizeLearningPatch(patch);
  const event = normalizeLearningEvent({ event_id: eventId, word_id: wordId, occurred_at: normalized.last_tested,
    kind: 'legacy_snapshot', outcome: normalized.review_state?.lastOutcome ?? (normalized.correct ? 'independent' : 'incorrect'), duration_ms: null, snapshot: normalized });
  const journal = readLearningJournal(userId, storage);
  append(journal, { id: wordId, ...emptyLearningPatch() } as WordEntry, event);
  write(userId, journal, storage);
}

export function recordLearningRound(userId: string, roundId: string, occurredAt: number, results: LearningResult[], words: WordEntry[], storage: LearningStorage = localStorage): WordEntry[] {
  if (!userId || !roundId || !validTime(occurredAt)) throw new Error('学习记录缺少用户、局编号或有效时间。');
  const journal = readLearningJournal(userId, storage);
  if (own(journal.rounds, roundId)) return overlayLearningProgress(userId, words, storage);
  const source = new Map(words.map(word => [word.id, word]));
  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.wordId)) continue;
    seen.add(result.wordId);
    const word = source.get(result.wordId);
    if (!word || word.deleted) continue;
    const event = resultEvent(result, `${roundId}:${word.id}`, occurredAt);
    if (event) append(journal, word, event);
  }
  set(journal.rounds, roundId, occurredAt);
  write(userId, journal, storage);
  return overlayLearningProgress(userId, words, storage);
}

/** Accept only a committed server revision. New local events arriving mid-upload remain pending. */
export function acknowledgeLearningReplay(userId: string, replay: LearningReplayWord, storage: LearningStorage = localStorage): LearningPatch {
  const journal = readLearningJournal(userId, storage);
  const currentRevision = journal.words[replay.word_id]?.revision ?? 0;
  if (replay.revision < currentRevision) return journal.words[replay.word_id].patch;
  set(journal.bases, replay.word_id, normalizeLearningPatch(replay.base));
  delete journal.checkpoints[replay.word_id];
  for (const event of replay.events) {
    const existing = journal.events[event.event_id];
    if (existing && !sameLearningEvent(existing.event, event)) throw new Error('云端事件与本机记录不一致，记录已保留。');
    set(journal.events, event.event_id, { event, pending: false });
  }
  rebuild(journal, replay.word_id, replay.revision);
  write(userId, journal, storage);
  return journal.words[replay.word_id].patch;
}

/** Legacy acknowledgement API; acknowledges that event only, never a newer answer. */
export function markLearningWordSynced(userId: string, wordId: string, eventId: string, storage: LearningStorage = localStorage): void {
  const journal = readLearningJournal(userId, storage);
  const stored = journal.events[eventId];
  if (!stored || stored.event.word_id !== wordId) return;
  stored.pending = false;
  rebuild(journal, wordId);
  write(userId, journal, storage);
}
