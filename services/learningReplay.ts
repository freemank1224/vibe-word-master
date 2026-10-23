import type { WordEntry } from '../types.ts';
import { getReviewSchedule, normalizeReviewState, updateReviewState } from './reviewScheduler.ts';
import type { ReviewOutcome } from './reviewScheduler.ts';
import { WORD_LEARNING_CONFIG } from '../config/wordLearningConfig.ts';

export type LearningPatch = Pick<WordEntry, 'correct' | 'tested' | 'score' | 'error_count' | 'consecutive_correct' | 'last_tested' | 'review_state' | 'best_time_ms'>;
export interface LearningEvent {
  event_id: string;
  word_id: string;
  occurred_at: number;
  kind: 'answer' | 'legacy_snapshot';
  outcome: ReviewOutcome;
  duration_ms: number | null;
  score?: number;
  error_delta?: number;
  snapshot?: LearningPatch;
}
export interface LearningReplayWord {
  word_id: string;
  revision: number;
  base: LearningPatch;
  events: LearningEvent[];
}
export const emptyLearningPatch = (): LearningPatch => ({
  correct: false, tested: false, score: 0, error_count: 0, consecutive_correct: 0,
  last_tested: null, review_state: null, best_time_ms: null,
});
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const count = (value: unknown, fallback = 0): number => value == null ? fallback : finite(value) && value >= 0 ? value : (() => { throw new Error('学习数据包含无效数值。'); })();
const timestamp = (value: unknown): number | null => {
  if (value == null) return null;
  const parsed = typeof value === 'string' ? Date.parse(value) : value;
  if (!finite(parsed) || parsed < 0) throw new Error('学习记录时间无效。');
  return parsed;
};

/** Accept database timestamp strings, but never silently erase a malformed schedule. */
export function normalizeLearningPatch(value: unknown): LearningPatch {
  if (!object(value) || typeof value.correct !== 'boolean' || typeof value.tested !== 'boolean') throw new Error('学习记录格式异常。');
  const review = value.review_state == null ? null : normalizeReviewState(value.review_state);
  if (value.review_state != null && !review) throw new Error('复习日程格式异常。');
  return {
    correct: value.correct, tested: value.tested, score: count(value.score),
    error_count: count(value.error_count), consecutive_correct: count(value.consecutive_correct),
    last_tested: timestamp(value.last_tested), review_state: review,
    best_time_ms: value.best_time_ms == null ? null : count(value.best_time_ms),
  };
}

export function normalizeLearningEvent(value: unknown): LearningEvent {
  if (!object(value) || typeof value.event_id !== 'string' || !value.event_id ||
      typeof value.word_id !== 'string' || !value.word_id ||
      !finite(value.occurred_at) || value.occurred_at <= 0 ||
      !['answer', 'legacy_snapshot'].includes(String(value.kind)) ||
      !['independent', 'assisted', 'incorrect'].includes(String(value.outcome))) throw new Error('学习事件格式异常。');
  const duration = value.duration_ms == null ? null : count(value.duration_ms);
  if (duration !== null && duration > 3_600_000) throw new Error('学习事件耗时超出范围。');
  const event: LearningEvent = {
    event_id: value.event_id, word_id: value.word_id, occurred_at: value.occurred_at,
    kind: value.kind as LearningEvent['kind'], outcome: value.outcome as ReviewOutcome,
    duration_ms: duration,
  };
  for (const [input, output] of [['score', 'score'], ['error_delta', 'error_delta']] as const) {
    if (value[input] != null) {
      const number = count(value[input]);
      if (number > 100) throw new Error('学习事件分数超出范围。');
      event[output] = number;
    }
  }
  if (event.kind === 'legacy_snapshot') event.snapshot = normalizeLearningPatch(value.snapshot);
  return event;
}

export function sameLearningEvent(left: LearningEvent, right: LearningEvent): boolean {
  return JSON.stringify(normalizeLearningEvent(left)) === JSON.stringify(normalizeLearningEvent(right));
}

export function parseLearningReplay(value: unknown): LearningReplayWord[] {
  if (!object(value) || !Array.isArray(value.words)) throw new Error('云端没有返回可验证的学习事件。');
  const seen = new Set<string>();
  return value.words.map(item => {
    if (!object(item) || typeof item.word_id !== 'string' || !item.word_id || seen.has(item.word_id) ||
        !Number.isSafeInteger(item.revision) || (item.revision as number) < 0 || !Array.isArray(item.events)) throw new Error('云端学习版本格式异常。');
    seen.add(item.word_id);
    const events = item.events.map(normalizeLearningEvent);
    const ids = new Set<string>();
    for (const event of events) {
      if (event.word_id !== item.word_id || ids.has(event.event_id)) throw new Error('云端学习事件重复或归属异常。');
      ids.add(event.event_id);
    }
    return { word_id: item.word_id, revision: item.revision as number, base: normalizeLearningPatch(item.base), events };
  });
}

/** A single deterministic projection shared by immediate local feedback and cloud replay. */
export function projectLearningEvents(base: LearningPatch, source: LearningEvent[]): LearningPatch {
  let patch = normalizeLearningPatch(base);
  const unique = new Map<string, LearningEvent>();
  for (const raw of source) {
    const event = normalizeLearningEvent(raw);
    const existing = unique.get(event.event_id);
    if (existing && !sameLearningEvent(existing, event)) throw new Error('同一学习事件编号对应了不同内容。');
    unique.set(event.event_id, event);
  }
  const events = [...unique.values()].sort((a, b) => a.occurred_at - b.occurred_at || (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0));
  for (const event of events) {
    if (event.kind === 'legacy_snapshot') {
      // V1 only saved a final snapshot: retain it honestly, without inventing answer history.
      const snapshot = event.snapshot!;
      const newer = (snapshot.last_tested ?? 0) >= (patch.last_tested ?? 0);
      patch = {
        ...(newer ? snapshot : patch), error_count: Math.max(patch.error_count, snapshot.error_count),
        best_time_ms: Math.min(patch.best_time_ms || Infinity, snapshot.best_time_ms || Infinity),
      };
      if (!Number.isFinite(patch.best_time_ms)) patch.best_time_ms = null;
      continue;
    }
    const independent = event.outcome === 'independent';
    const correct = event.outcome !== 'incorrect';
    const review = updateReviewState(patch, event.outcome, event.occurred_at);
    const spacedRecall = independent && review.repetitions > (getReviewSchedule(patch, event.occurred_at).state?.repetitions || 0);
    let streak = independent ? (patch.consecutive_correct || 0) + (spacedRecall ? 1 : 0) : 0;
    let errors = patch.error_count + (event.error_delta ?? (correct ? 0 : 1));
    if (spacedRecall && streak >= WORD_LEARNING_CONFIG.errorDecay.consecutiveCorrectThreshold && errors > 0) {
      errors = Math.max(0, errors - WORD_LEARNING_CONFIG.errorDecay.decrementAmount);
      streak = 0;
    }
    const predatesBaseline = (patch.last_tested || 0) > event.occurred_at;
    patch = {
      correct: predatesBaseline ? patch.correct : correct, tested: true,
      score: predatesBaseline ? patch.score : event.score ?? (independent ? 3 : correct ? 1.5 : 0),
      error_count: errors, consecutive_correct: predatesBaseline ? Math.min(patch.consecutive_correct || 0, streak) : streak,
      last_tested: Math.max(patch.last_tested || 0, event.occurred_at), review_state: review,
      best_time_ms: independent && event.duration_ms != null && event.duration_ms > 0
        ? Math.min(patch.best_time_ms || Infinity, event.duration_ms) : patch.best_time_ms,
    };
  }
  return patch;
}
