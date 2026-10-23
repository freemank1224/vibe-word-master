import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveWordSelector } from '../../services/adaptiveWordSelector.ts';
import { DAY_MS, type ReviewState } from '../../services/reviewScheduler.ts';
import type { WordEntry } from '../../types.ts';

const NOW = Date.UTC(2026, 9, 22, 12);
const selector = new AdaptiveWordSelector({ now: () => NOW });
const state = (overrides: Partial<ReviewState> = {}): ReviewState => ({
  version: 1, phase: 'review', dueAt: NOW, stabilityDays: 1, difficulty: 5,
  lastReviewedAt: NOW - DAY_MS, lastIndependentReviewAt: NOW - DAY_MS,
  lapses: 0, repetitions: 2, learningStep: 1, lastOutcome: 'independent', ...overrides,
});
const word = (id: string, overrides: Partial<WordEntry> = {}): WordEntry => ({
  id, text: id, timestamp: NOW - DAY_MS, sessionId: 'session', correct: true,
  tested: false, error_count: 0, best_time_ms: null, last_tested: null,
  phonetic: null, audio_url: null, definition_cn: null, definition_en: null,
  language: 'en', ...overrides,
});
const ids = (words: WordEntry[]) => words.map(item => item.id);

test('due relearning outranks overdue review, new words, and future reviews', () => {
  const pool = [
    word('new'),
    word('future', { review_state: state({ dueAt: NOW + DAY_MS }) }),
    word('overdue', { review_state: state({ dueAt: NOW - 10 * DAY_MS, lastReviewedAt: NOW - 11 * DAY_MS }) }),
    word('relearning', { review_state: state({ phase: 'relearning', lastOutcome: 'incorrect' }) }),
  ];
  assert.deepEqual(ids(selector.calculateQueue(pool, pool, 2)), ['relearning', 'overdue']);
  const detail = selector.calculateQueueWithSummary(pool, pool, 1);
  assert.equal(detail.summary.dueRelearningCount, 1);
  assert.equal(detail.summary.remainingDueCount, 1);
  assert.equal(detail.summary.nextDueAt, NOW + DAY_MS);
  assert.equal(detail.selected[0].reason, '提示或失误后的重学已到期');
});

test('longer relative overdue and difficulty decide order within due-review band', () => {
  const pool = [
    word('due', { review_state: state() }),
    word('overdue', { review_state: state({ dueAt: NOW - DAY_MS, lastReviewedAt: NOW - 2 * DAY_MS }) }),
    word('hard', { review_state: state({ difficulty: 9 }) }),
  ];
  assert.deepEqual(ids(selector.calculateQueue(pool, pool, 3)), ['overdue', 'hard', 'due']);
});

test('new-word soft budget applies only after all fitting due words', () => {
  const due = [word('due', { review_state: state() })];
  const fresh = Array.from({ length: 8 }, (_, i) => word(`new-${i}`));
  const future = Array.from({ length: 8 }, (_, i) => word(`future-${i}`, { review_state: state({ dueAt: NOW + (i + 1) * DAY_MS }) }));
  const pool = [...fresh, ...future, ...due];
  const result = selector.calculateQueueWithSummary(pool, pool, 8);
  assert.equal(result.summary.dueReviewCount, 1);
  assert.equal(result.summary.newCount, 2);
  assert.equal(result.summary.upcomingCount, 5);
  assert.equal(result.words[0].id, 'due');
  assert.equal(result.selected.find(item => item.category === 'upcoming')?.reason, '到期词已优先安排，未到期词补位');
});

test('overdue backlog consumes the entire budget before new words', () => {
  const pool = [...Array.from({ length: 20 }, (_, i) => word(`due-${i}`, { review_state: state() })), word('new')];
  const result = selector.calculateQueueWithSummary(pool, pool, 8);
  assert.equal(result.summary.dueReviewCount, 8);
  assert.equal(result.summary.newCount, 0);
  assert.equal(result.summary.remainingDueCount, 12);
});

test('new-only and small pools fill requested practice without duplicates', () => {
  const pool = Array.from({ length: 6 }, (_, i) => word(`new-${i}`));
  assert.equal(selector.calculateQueue(pool, pool, 4).length, 4);
  assert.equal(selector.calculateQueue(pool, pool, 100).length, 6);
});

test('dedup keeps urgent copy and does not merge different languages', () => {
  const pool = [
    word('fresh-copy', { text: ' Apple ' }),
    word('urgent-copy', { text: 'APPLE', review_state: state() }),
    word('urgent-copy', { text: 'different-text' }),
    word('other-language', { text: 'apple', language: 'fr' }),
    word('deleted', { deleted: true }),
    word('blank', { text: ' ' }),
  ];
  assert.deepEqual(ids(selector.calculateQueue(pool, pool, 20)), ['urgent-copy', 'other-language']);
});

test('chosen scope is respected even when outside words are more urgent', () => {
  const chosen = word('chosen');
  const outside = word('outside', { review_state: state({ phase: 'relearning' }) });
  assert.deepEqual(ids(selector.calculateQueue([outside, chosen], [chosen], 5)), ['chosen']);
});

test('invalid target sizes are empty; fractions are floored', () => {
  const pool = [word('one'), word('two')];
  for (const count of [-1, 0, NaN, Infinity]) assert.deepEqual(selector.calculateQueue(pool, pool, count), []);
  assert.equal(selector.calculateQueue(pool, pool, 1.9).length, 1);
  assert.equal(selector.calculateQueueWithSummary([], [], 10).summary.candidateCount, 0);
});

test('selection is deterministic under input permutation and never mutates pool', () => {
  const pool = [word('z'), word('a'), word('m')];
  const snapshot = structuredClone(pool);
  assert.deepEqual(ids(selector.calculateQueue(pool, pool, 3)), ['a', 'm', 'z']);
  assert.deepEqual(ids(selector.calculateQueue(pool, [...pool].reverse(), 3)), ['a', 'm', 'z']);
  assert.deepEqual(pool, snapshot);
});

test('corrupt legacy numerics never produce NaN rankings', () => {
  const pool = [word('corrupt', { tested: true, error_count: NaN, last_tested: NaN, timestamp: NaN }), word('normal')];
  const ranked = selector.rankCandidates(pool);
  assert.ok(ranked.every(item => Number.isFinite(item.priority) && Number.isFinite(item.overdueDays)));
  assert.equal(ranked[0].word.id, 'corrupt');
  assert.equal(ranked[0].category, 'due_review');
});

test('unknown last-test date is due; stored state overrides legacy counters', () => {
  const pool = [
    word('unknown', { tested: true }),
    word('state-first', { tested: true, last_tested: NOW - 90 * DAY_MS, error_count: 90, review_state: state({ dueAt: NOW + DAY_MS }) }),
  ];
  const ranked = selector.rankCandidates(pool);
  assert.equal(ranked[0].word.id, 'unknown');
  assert.equal(ranked[1].category, 'upcoming');
});
