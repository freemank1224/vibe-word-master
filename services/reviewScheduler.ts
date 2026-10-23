/**
 * Per-word spaced review state. All timestamps are Unix milliseconds.
 * This is a configurable forgetting-curve heuristic, not FSRS and not a
 * calibrated prediction of recall. `stabilityDays` is the interval at the
 * configured target retention: R(t) = targetRetention^(t / stabilityDays).
 */
import { WORD_LEARNING_CONFIG } from '../config/wordLearningConfig.ts';

export const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const config = WORD_LEARNING_CONFIG.reviewScheduler;
export type ReviewOutcome = 'independent' | 'assisted' | 'incorrect';
export type ReviewPhase = 'learning' | 'review' | 'relearning';

export interface ReviewState {
  version: 1;
  phase: ReviewPhase;
  dueAt: number;
  stabilityDays: number;
  difficulty: number;
  lastReviewedAt: number;
  lastIndependentReviewAt: number | null;
  lapses: number;
  repetitions: number;
  learningStep: number;
  lastOutcome: ReviewOutcome;
}

/** Consume both local words and database rows without a database dependency. */
export interface ReviewWord {
  review_state?: ReviewState | null;
  tested?: boolean;
  correct?: boolean;
  last_tested?: number | string | null;
  error_count?: number;
  consecutive_correct?: number;
}

export interface ReviewSchedule {
  state: ReviewState | null;
  source: 'stored' | 'legacy' | 'new';
  phase: ReviewPhase | 'new';
  isNew: boolean;
  isDue: boolean;
  dueAt: number | null;
  elapsedDays: number;
  overdueDays: number;
  /** Heuristic signal only, not a measured recall probability. */
  estimatedRetention: number | null;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const count = (value: unknown) => finite(value) ? Math.floor(clamp(value, 0, 1_000_000)) : 0;
const validNow = (now: number) => finite(now) && now >= 0 ? now : Date.now();
const stability = (days: number) => clamp(days, config.minimumStabilityDays, config.maximumStabilityDays);
const timestamp = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Date.parse(value) : value;
  return finite(parsed) && parsed >= 0 ? parsed : null;
};

/** Reject unknown versions/incomplete records, then bound numeric fields. */
export function normalizeReviewState(value: unknown): ReviewState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Partial<ReviewState>;
  if (state.version !== 1 || !['learning', 'review', 'relearning'].includes(state.phase ?? '') ||
      !['independent', 'assisted', 'incorrect'].includes(state.lastOutcome ?? '') ||
      !finite(state.dueAt) || state.dueAt < 0 || !finite(state.lastReviewedAt) || state.lastReviewedAt < 0 ||
      !finite(state.stabilityDays) || state.stabilityDays <= 0 || !finite(state.difficulty) ||
      (state.lastIndependentReviewAt !== null && (!finite(state.lastIndependentReviewAt) || state.lastIndependentReviewAt < 0)) ||
      !finite(state.lapses) || !finite(state.repetitions) || !finite(state.learningStep)) return null;
  return {
    version: 1,
    phase: state.phase as ReviewPhase,
    dueAt: clamp(state.dueAt, state.lastReviewedAt, state.lastReviewedAt + config.maximumStabilityDays * DAY_MS),
    stabilityDays: stability(state.stabilityDays),
    difficulty: clamp(state.difficulty, 1, 10),
    lastReviewedAt: state.lastReviewedAt,
    lastIndependentReviewAt: state.lastIndependentReviewAt === null ? null : Math.min(state.lastIndependentReviewAt!, state.lastReviewedAt),
    lapses: count(state.lapses),
    repetitions: count(state.repetitions),
    learningStep: Math.min(count(state.learningStep), 1),
    lastOutcome: state.lastOutcome as ReviewOutcome,
  };
}

function legacyState(word: ReviewWord, now: number): ReviewState | null {
  const testedAt = timestamp(word.last_tested);
  if (!word.tested && testedAt === null) return null;
  const errors = finite(word.error_count) ? Math.max(0, word.error_count) : 0;
  const streak = count(word.consecutive_correct);
  const lastReviewedAt = testedAt ?? now;
  const failed = word.correct === false;
  const stabilityDays = stability(Math.min(config.legacyMaximumStabilityDays, Math.pow(1.8, Math.min(streak, 3)) / (1 + errors * 0.4)));
  return {
    version: 1,
    phase: failed ? 'relearning' : 'review',
    // A tested word without a usable timestamp is due, never postponed.
    dueAt: testedAt === null ? now : lastReviewedAt + (failed ? config.failureStepMinutes * MINUTE_MS : stabilityDays * DAY_MS),
    stabilityDays,
    difficulty: clamp(config.initialDifficulty + errors * 0.6 - streak * 0.25, 1, 10),
    lastReviewedAt,
    lastIndependentReviewAt: failed || testedAt === null ? null : testedAt,
    lapses: 0,
    repetitions: Math.max(1, streak),
    learningStep: 0,
    lastOutcome: failed ? 'incorrect' : 'independent',
  };
}

export function getReviewSchedule(word: ReviewWord, now = Date.now()): ReviewSchedule {
  now = validNow(now);
  const stored = normalizeReviewState(word.review_state);
  const state = stored ?? legacyState(word, now);
  if (!state) return { state: null, source: 'new', phase: 'new', isNew: true, isDue: false, dueAt: null, elapsedDays: 0, overdueDays: 0, estimatedRetention: null };
  const elapsedDays = Math.max(0, now - state.lastReviewedAt) / DAY_MS;
  return {
    state, source: stored ? 'stored' : 'legacy', phase: state.phase,
    isNew: false, isDue: state.dueAt <= now, dueAt: state.dueAt,
    elapsedDays, overdueDays: Math.max(0, now - state.dueAt) / DAY_MS,
    estimatedRetention: clamp(Math.pow(config.targetRetention, elapsedDays / state.stabilityDays), 0, 1),
  };
}

/**
 * Apply one resolved question, not every keystroke. `assisted` covers hints,
 * revealed answers and correction after a wrong attempt. Stale events cannot
 * undo newer state. Short-interval clean repetitions cannot grow stability,
 * advance learning steps, or push the scheduled due date.
 */
export function updateReviewState(word: ReviewWord, outcome: ReviewOutcome, now = Date.now()): ReviewState {
  now = validNow(now);
  const schedule = getReviewSchedule(word, now);
  // Unknown legacy dates provide no elapsed-time evidence. Start a short
  // learning check on the first real result instead of inventing a last date.
  const previous = schedule.source === 'legacy' && timestamp(word.last_tested) === null ? null : schedule.state;
  if (previous && now < previous.lastReviewedAt) return previous;
  const base: ReviewState = previous ?? {
    version: 1, phase: 'learning', dueAt: now,
    stabilityDays: config.initialStabilityDays, difficulty: config.initialDifficulty,
    lastReviewedAt: now, lastIndependentReviewAt: null,
    lapses: 0, repetitions: 0, learningStep: 0, lastOutcome: outcome,
  };
  if (outcome !== 'independent') {
    const incorrect = outcome === 'incorrect';
    const alreadyRelearning = Boolean(previous && previous.phase !== 'review' && previous.lastOutcome !== 'independent');
    return {
      ...base, phase: previous ? 'relearning' : 'learning',
      dueAt: now + (incorrect ? config.failureStepMinutes : config.assistedStepMinutes) * MINUTE_MS,
      // Multiple attempts inside a relearning step do not compound penalties.
      stabilityDays: stability(base.stabilityDays * (alreadyRelearning ? 1 : incorrect ? config.failureStabilityMultiplier : config.assistedStabilityMultiplier)),
      difficulty: clamp(base.difficulty + (alreadyRelearning ? 0 : incorrect ? config.failureDifficultyDelta : config.assistedDifficultyDelta), 1, 10),
      lastReviewedAt: now,
      lapses: count(base.lapses + (incorrect && (!alreadyRelearning || previous?.lastOutcome !== 'incorrect') ? 1 : 0)),
      learningStep: 0, lastOutcome: outcome,
    };
  }
  if (!previous) {
    return { ...base, dueAt: now + config.learningStepMinutes * MINUTE_MS, lastIndependentReviewAt: now, repetitions: 1, learningStep: 1, lastOutcome: outcome };
  }
  const elapsed = Math.max(0, now - previous.lastReviewedAt);
  const minimumElapsed = previous.phase === 'review'
    ? Math.max(config.minimumIndependentSpacingMinutes * MINUTE_MS, previous.stabilityDays * DAY_MS * config.minimumIntervalElapsedRatio)
    : Math.min(config.minimumIndependentSpacingMinutes * MINUTE_MS, previous.dueAt - previous.lastReviewedAt);
  if (elapsed < minimumElapsed || (previous.phase !== 'review' && now < previous.dueAt)) {
    // Keep the prior anchor too: rapid retries cannot defer the spaced check.
    return { ...previous };
  }
  const repetitions = count(previous.repetitions + 1);
  const difficulty = clamp(previous.difficulty + config.successfulDifficultyDelta, 1, 10);
  if (previous.phase !== 'review' && previous.learningStep === 0) {
    return { ...previous, dueAt: now + config.learningStepMinutes * MINUTE_MS, lastReviewedAt: now,
      lastIndependentReviewAt: now, repetitions, difficulty, learningStep: 1, lastOutcome: outcome };
  }
  const elapsedRatio = elapsed / (previous.stabilityDays * DAY_MS);
  const overdueBonus = Math.min(config.maximumOverdueGrowthBonus, Math.max(0, elapsedRatio - 1) * 0.2);
  const growth = config.baseGrowth - (difficulty - config.initialDifficulty) * config.difficultyGrowthPenalty + overdueBonus;
  const stabilityDays = previous.phase === 'review' ? stability(previous.stabilityDays * growth) : previous.stabilityDays;
  return {
    ...previous, phase: 'review', stabilityDays, difficulty,
    dueAt: now + stabilityDays * DAY_MS, lastReviewedAt: now, lastIndependentReviewAt: now,
    repetitions, learningStep: 1, lastOutcome: outcome,
  };
}
