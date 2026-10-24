import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSurfRunReview } from '../../features/monster-surf/runReview.ts';
import type { SavedSurfAttempt } from '../../features/monster-surf/sessionJournal.ts';
import type { SurfWord } from '../../features/monster-surf/types.ts';

const word = (answer: string): SurfWord => ({ wordId: answer, answer, meaningZh: '释义', meaningEn: 'Definition' });
const attempt = (wordId: string, answer: string): SavedSurfAttempt => ({ wordId, answer });

test('review distinguishes first success, correction, unresolved mistakes and untouched vocabulary', () => {
  const deck = ['apple', 'beach', 'crystal', 'dolphin', 'eagle'].map(word);
  const result = buildSurfRunReview(deck, [attempt('apple', 'apple'), attempt('beach', 'beech'),
    attempt('beach', 'beah'), attempt('beach', 'beach'), attempt('crystal', 'cristal')], 3);
  assert.deepEqual(result.rows.map(row => row.status), ['first-try-correct', 'corrected', 'incorrect', 'unanswered', 'not-reached']);
  assert.equal(result.totalCount, 5);
  assert.equal(result.attemptedCount, 3);
  assert.equal(result.firstTryCorrectCount, 1);
  assert.equal(result.correctedCount, 1);
  assert.equal(result.incorrectCount, 1);
  assert.equal(result.wrongWordCount, 2);
  assert.equal(result.completedCount, 2);
  assert.equal(result.unansweredCount, 1);
  assert.equal(result.notReachedCount, 1);
  assert.equal(result.attemptCount, 5);
  assert.equal(result.correctAttemptCount, 2);
  assert.equal(result.incorrectAttemptCount, 3);
  assert.equal(result.firstAnswerAccuracy, 100 / 3);
  assert.equal(result.attemptAccuracy, 40);
  assert.deepEqual(result.rows[1].wrongAnswers, ['beech', 'beah']);
  assert.equal(result.rows[1].mistakeCount, 2);
  assert.equal(result.rows[1].completed, true);
});

test('an island collision or quitting without submission does not fabricate a wrong answer', () => {
  const result = buildSurfRunReview(['apple', 'beach'].map(word), [], 0);
  assert.equal(result.firstAnswerAccuracy, null);
  assert.equal(result.attemptAccuracy, null);
  assert.equal(result.attemptedCount, 0);
  assert.equal(result.wrongWordCount, 0);
  assert.equal(result.incorrectAttemptCount, 0);
  assert.deepEqual(result.rows.map(row => row.status), ['unanswered', 'not-reached']);
});

test('correcting an answer never improves first-answer accuracy or hides that word from mistakes', () => {
  const deck = ['apple', 'beach'].map(word);
  const wrong = [attempt('apple', 'aple')];
  const corrected = buildSurfRunReview(deck, [...wrong, attempt('apple', 'apple')], 1);
  assert.equal(buildSurfRunReview(deck, wrong, 0).firstAnswerAccuracy, 0);
  assert.equal(corrected.firstAnswerAccuracy, 0);
  assert.equal(corrected.attemptAccuracy, 50);
  assert.equal(corrected.wrongWordCount, 1);
  assert.equal(corrected.rows[0].status, 'corrected');
  assert.equal(corrected.incorrectCount, 0);
});

test('canonical spelling handles case, compatibility letters, smart apostrophes and hyphens', () => {
  const deck = [word('apple'), word("it's"), word('ice-cream')];
  const result = buildSurfRunReview(deck, [attempt('apple', ' ＡＰＰＬＥ '), attempt("it's", 'IT’S'),
    attempt('ice-cream', 'ice‑cream')], 2);
  assert.equal(result.firstAnswerAccuracy, 100);
  assert.equal(result.completedCount, 3);
  assert.equal(result.rows[0].attempts[0].answer, ' ＡＰＰＬＥ ');
});

test('empty and unrelated submissions never change the denominator', () => {
  const result = buildSurfRunReview([word('apple')], [attempt('apple', '　 '), attempt('missing', 'value')], 0);
  assert.equal(result.attemptedCount, 0);
  assert.equal(result.attemptCount, 0);
  assert.equal(result.firstAnswerAccuracy, null);
});

test('durable event replay is idempotent while distinct repeated wrong submissions remain visible', () => {
  const first: SavedSurfAttempt = { ...attempt('apple', 'aple'), learning: {
    eventId: 'wrong-1', occurredAt: 123, correct: false, hadMistake: false,
  } };
  const second: SavedSurfAttempt = { ...first, learning: { ...first.learning!, eventId: 'wrong-2', occurredAt: 124, hadMistake: true } };
  const result = buildSurfRunReview([word('apple')], [first, first, second, attempt('apple', 'apple')], 0);
  assert.equal(result.attemptCount, 3);
  assert.equal(result.rows[0].mistakeCount, 2);
  assert.deepEqual(result.rows[0].wrongAnswers, ['aple', 'aple']);
  assert.equal(result.wrongWordCount, 1);
});

test('demo words use positional identities without conflating them with an account vocabulary ID', () => {
  const deck = [word('apple'), word('beach')].map(({ wordId, ...entry }) => entry);
  const result = buildSurfRunReview(deck, [attempt('practice:0', 'apple'), attempt('practice:1', 'beech')], 1);
  assert.deepEqual(result.rows.map(row => row.key), ['practice:0', 'practice:1']);
  assert.equal(result.firstAnswerAccuracy, 50);
  assert.equal(result.wrongWordCount, 1);
});

test('empty deck and an unknown checkpoint stay well-defined', () => {
  const empty = buildSurfRunReview([], [], 0);
  assert.equal(empty.totalCount, 0);
  assert.equal(empty.firstAnswerAccuracy, null);
  const unknown = buildSurfRunReview([word('apple')], [], Number.NaN);
  assert.equal(unknown.rows[0].status, 'not-reached');
});

test('review does not mutate the frozen deck, answer log or learning metadata', () => {
  const deck = Object.freeze([Object.freeze(word('apple'))]);
  const saved = Object.freeze({ ...attempt('apple', 'apple'), learning: Object.freeze({
    eventId: 'correct', occurredAt: 123, correct: true, hadMistake: false,
  }) });
  const answers = Object.freeze([saved]);
  const before = JSON.stringify({ deck, answers });
  const result = buildSurfRunReview(deck, answers, 0);
  result.rows[0].word.meaningZh = 'edited review';
  result.rows[0].attempts[0].answer = 'edited review';
  assert.equal(JSON.stringify({ deck, answers }), before);
});
