import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, getReviewSchedule, normalizeReviewState, updateReviewState, type ReviewState } from '../../services/reviewScheduler.ts';
import { WORD_LEARNING_CONFIG } from '../../config/wordLearningConfig.ts';

const NOW = Date.UTC(2026, 9, 22, 12);
const MINUTE = 60_000;
const fresh = { tested: false, last_tested: null, error_count: 0 };
const mature = (overrides: Partial<ReviewState> = {}): ReviewState => ({
  version: 1, phase: 'review', dueAt: NOW, stabilityDays: 4, difficulty: 5,
  lastReviewedAt: NOW - 4 * DAY_MS, lastIndependentReviewAt: NOW - 4 * DAY_MS,
  lapses: 0, repetitions: 4, learningStep: 1, lastOutcome: 'independent', ...overrides,
});

test('a new word starts with a short check; a spaced clean answer graduates', () => {
  assert.equal(getReviewSchedule(fresh, NOW).isNew, true);
  const first = updateReviewState(fresh, 'independent', NOW);
  assert.equal(first.phase, 'learning');
  assert.equal(first.dueAt, NOW + 10 * MINUTE);
  assert.equal(first.repetitions, 1);
  const next = updateReviewState({ review_state: first }, 'independent', first.dueAt);
  assert.equal(next.phase, 'review');
  assert.equal(next.dueAt, first.dueAt + DAY_MS);
  assert.equal(next.repetitions, 2);
});

test('rapid clean repeats do not advance learning or inflate due/stability', () => {
  let state = updateReviewState(fresh, 'independent', NOW);
  const original = { ...state };
  for (let seconds = 1; seconds < 600; seconds++) {
    state = updateReviewState({ review_state: state }, 'independent', NOW + seconds * 1000);
  }
  assert.deepEqual(state, original);
  const early = mature({ dueAt: NOW + 4 * DAY_MS, lastReviewedAt: NOW, lastIndependentReviewAt: NOW });
  assert.deepEqual(updateReviewState({ review_state: early }, 'independent', NOW + 60 * MINUTE), early);
});

test('a spaced clean recall grows interval using elapsed time and difficulty', () => {
  const original = mature();
  const onTime = updateReviewState({ review_state: original }, 'independent', NOW);
  const overdue = updateReviewState({ review_state: original }, 'independent', NOW + 4 * DAY_MS);
  const difficult = updateReviewState({ review_state: mature({ difficulty: 9 }) }, 'independent', NOW);
  assert.ok(onTime.stabilityDays > original.stabilityDays);
  assert.ok(overdue.stabilityDays > onTime.stabilityDays);
  assert.ok(difficult.stabilityDays < onTime.stabilityDays);
  assert.equal(onTime.dueAt, NOW + onTime.stabilityDays * DAY_MS);
  assert.equal(onTime.repetitions, 5);
});

test('failure schedules short relearning and needs spaced recovery before graduation', () => {
  const failed = updateReviewState({ review_state: mature() }, 'incorrect', NOW);
  assert.equal(failed.phase, 'relearning');
  assert.equal(failed.dueAt, NOW + 5 * MINUTE);
  assert.equal(failed.lapses, 1);
  assert.ok(failed.stabilityDays < 4);
  const corrected = updateReviewState({ review_state: failed }, 'independent', NOW + MINUTE);
  assert.deepEqual(corrected, failed);
  const checkpoint = updateReviewState({ review_state: failed }, 'independent', failed.dueAt);
  assert.equal(checkpoint.phase, 'relearning');
  assert.equal(checkpoint.learningStep, 1);
  assert.equal(checkpoint.dueAt, failed.dueAt + 10 * MINUTE);
  const recovered = updateReviewState({ review_state: checkpoint }, 'independent', checkpoint.dueAt);
  assert.equal(recovered.phase, 'review');
  assert.equal(recovered.stabilityDays, failed.stabilityDays);
});

test('assisted/corrected answers are not independent mastery', () => {
  const previous = mature();
  const assisted = updateReviewState({ review_state: previous }, 'assisted', NOW);
  assert.equal(assisted.phase, 'relearning');
  assert.equal(assisted.dueAt, NOW + 10 * MINUTE);
  assert.equal(assisted.repetitions, previous.repetitions);
  assert.equal(assisted.lastIndependentReviewAt, previous.lastIndependentReviewAt);
  assert.equal(assisted.lapses, 0);
  assert.ok(assisted.difficulty > previous.difficulty);
  assert.ok(assisted.stabilityDays < previous.stabilityDays);
});

test('repeat failures within a relearning step do not compound stability damage', () => {
  const failed = updateReviewState(fresh, 'incorrect', NOW);
  const repeat = updateReviewState({ review_state: failed }, 'incorrect', NOW + MINUTE);
  assert.equal(repeat.lapses, failed.lapses);
  assert.equal(repeat.stabilityDays, failed.stabilityDays);
  assert.equal(repeat.difficulty, failed.difficulty);
});

test('due boundary is inclusive and heuristic retention declines monotonically', () => {
  const word = { review_state: mature() };
  const before = getReviewSchedule(word, NOW - 1);
  const at = getReviewSchedule(word, NOW);
  const after = getReviewSchedule(word, NOW + DAY_MS);
  assert.equal(before.isDue, false);
  assert.equal(at.isDue, true);
  assert.equal(at.estimatedRetention, WORD_LEARNING_CONFIG.reviewScheduler.targetRetention);
  assert.ok(after.estimatedRetention! < at.estimatedRetention!);
  assert.equal(after.overdueDays, 1);
});

test('legacy records use last_tested and conservative existing streak/error evidence', () => {
  const good = getReviewSchedule({ tested: true, correct: true, last_tested: NOW - 2 * DAY_MS, consecutive_correct: 2, error_count: 0 }, NOW);
  const weak = getReviewSchedule({ tested: true, correct: true, last_tested: NOW - 2 * DAY_MS, consecutive_correct: 0, error_count: 4 }, NOW);
  assert.equal(good.source, 'legacy');
  assert.equal(good.isDue, false);
  assert.equal(weak.isDue, true);
  assert.ok(good.state!.stabilityDays > weak.state!.stabilityDays);
  const failed = getReviewSchedule({ tested: true, correct: false, last_tested: new Date(NOW - 10 * MINUTE).toISOString() }, NOW);
  assert.equal(failed.phase, 'relearning');
  assert.equal(failed.isDue, true);
});

test('unknown legacy timestamp is due now and first observed result starts learning', () => {
  const legacy = { tested: true, last_tested: null, error_count: 2 };
  assert.equal(getReviewSchedule(legacy, NOW).dueAt, NOW);
  const result = updateReviewState(legacy, 'independent', NOW);
  assert.equal(result.phase, 'learning');
  assert.equal(result.dueAt, NOW + 10 * MINUTE);
});

test('malformed numeric state falls back safely; bounded state never leaks NaN', () => {
  assert.equal(normalizeReviewState({ ...mature(), stabilityDays: NaN }), null);
  assert.equal(normalizeReviewState({ ...mature(), version: 2 }), null);
  const schedule = getReviewSchedule({ tested: true, last_tested: NaN, error_count: NaN, consecutive_correct: Infinity, review_state: { ...mature(), dueAt: Infinity } }, NOW);
  assert.equal(schedule.source, 'legacy');
  assert.equal(schedule.isDue, true);
  assert.ok(Number.isFinite(schedule.estimatedRetention));
  const bounded = normalizeReviewState(mature({ stabilityDays: 9999, difficulty: -4, lapses: -3 }))!;
  assert.equal(bounded.stabilityDays, 365);
  assert.equal(bounded.difficulty, 1);
  assert.equal(bounded.lapses, 0);
});

test('stale event and future clock skew do not undo a newer review', () => {
  const state = mature({ lastReviewedAt: NOW + DAY_MS, dueAt: NOW + 2 * DAY_MS, lastIndependentReviewAt: NOW + DAY_MS });
  assert.deepEqual(updateReviewState({ review_state: state }, 'incorrect', NOW), state);
  const schedule = getReviewSchedule({ review_state: state }, NOW);
  assert.equal(schedule.elapsedDays, 0);
  assert.equal(schedule.estimatedRetention, 1);
});

test('many spaced successes remain bounded and inputs stay immutable', () => {
  const word = { review_state: mature() };
  const snapshot = structuredClone(word);
  let state = word.review_state;
  for (let i = 0; i < 50; i++) state = updateReviewState({ review_state: state }, 'independent', state.dueAt);
  assert.equal(state.stabilityDays, 365);
  assert.ok(state.difficulty >= 1);
  assert.deepEqual(word, snapshot);
});
