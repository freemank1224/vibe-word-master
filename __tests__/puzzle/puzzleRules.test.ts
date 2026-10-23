import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PuzzleCardResult, WordEntry } from '../../types.ts';
import {
  applyPuzzleAnswer, calculatePuzzlePracticeSummary, getPuzzleBoardScore, getPuzzleCardResult,
  getPuzzleMismatchPositions, PUZZLE_LINES, PUZZLE_RULES_VERSION, type PuzzlePracticeCard,
} from '../../utils/puzzleRules.ts';

const card = (): PuzzlePracticeCard => ({
  word: { id: 'w1', text: 'bridge' } as WordEntry, imageUrl: null, attemptsUsed: 0,
  hintUsed: false, inputValue: '', isInputOpen: true, isSolved: false, isLocked: false,
  activatedAtMs: 0, solvedAtMs: null, lastWrongInput: null, skipped: false,
});
const result = (correct = true, hintUsed = false): PuzzleCardResult => ({
  wordId: 'word', wordText: 'word', correct, hintUsed, attemptsUsed: correct ? 1 : 0,
  solvedAtMs: correct ? 1000 : null, activatedAtMs: 0,
});

test('empty and whitespace submissions preserve the card and all three attempts', () => {
  const original = card();
  assert.equal(applyPuzzleAnswer(original, '  ', 50), original);
  assert.equal(getPuzzleCardResult(original).status, 'unattempted');
});
test('wrong submissions keep the text and card available; third mismatch locks it', () => {
  let current = applyPuzzleAnswer(card(), 'brigde', 1000);
  assert.equal(current.inputValue, 'brigde');
  assert.equal(current.lastWrongInput, 'brigde');
  assert.equal(current.isLocked, false);
  current = applyPuzzleAnswer(current, 'brige', 2000);
  current = applyPuzzleAnswer(current, 'bridg', 3000);
  assert.equal(current.attemptsUsed, 3);
  assert.equal(current.isLocked, true);
  assert.equal(getPuzzleCardResult(current).status, 'incorrect');
  assert.equal(applyPuzzleAnswer(current, 'bridge', 4000), current);
});
test('correction succeeds, preserves mistake evidence, and duplicate submit is inert', () => {
  const wrong = applyPuzzleAnswer(card(), 'brigde', 1000);
  const correct = applyPuzzleAnswer(wrong, ' BRIDGE ', 2000);
  assert.equal(correct.isSolved, true);
  assert.equal(correct.attemptsUsed, 2);
  assert.equal(correct.lastWrongInput, 'brigde');
  assert.equal(getPuzzleCardResult(correct).status, 'correct');
  assert.equal(applyPuzzleAnswer(correct, 'bridge', 2500), correct);
});
test('unsubmitted text, explicit skip, and actual mistake have different learning outcomes', () => {
  assert.equal(getPuzzleCardResult({ ...card(), inputValue: 'bri' }).status, 'unattempted');
  assert.equal(getPuzzleCardResult({ ...card(), skipped: true }).status, 'skipped');
  assert.equal(getPuzzleCardResult({ ...applyPuzzleAnswer(card(), 'wrong', 100), skipped: true }).status, 'incorrect');
});
test('mismatch feedback includes incorrect, missing, and extra letter positions', () => {
  assert.deepEqual(getPuzzleMismatchPositions('brigde', 'bridge'), [3, 4]);
  assert.deepEqual(getPuzzleMismatchPositions('bridg', 'bridge'), [5]);
  assert.deepEqual(getPuzzleMismatchPositions('bridges', 'bridge'), [6]);
  assert.deepEqual(getPuzzleMismatchPositions(' ＢＲＩＤＧＥ ', 'bridge'), []);
});
test('all eight lines are unique and each completed line awards exactly 80', () => {
  assert.equal(new Set(PUZZLE_LINES.map((line) => line.join(','))).size, 8);
  for (const line of PUZZLE_LINES) {
    const board = Array.from({ length: 9 }, (_, index) => result((line as readonly number[]).includes(index)));
    const score = getPuzzleBoardScore(board);
    assert.equal(score.completedLineIds.length, 1);
    assert.equal(score.lineBonus, 80);
    assert.equal(score.totalScore, 380);
    assert.deepEqual(getPuzzleBoardScore(board), score);
  }
});
test('center completion can finish two lines simultaneously without extra rewards', () => {
  const board = Array.from({ length: 9 }, (_, index) => result([0, 2, 4, 6, 8].includes(index)));
  const score = getPuzzleBoardScore(board);
  assert.equal(score.completedLineIds.length, 2);
  assert.equal(score.totalScore, 660);
});
test('perfect board is 900 + 640 + 200; hint changes only its own word reward', () => {
  const perfect = Array.from({ length: 9 }, () => result());
  assert.equal(getPuzzleBoardScore(perfect).totalScore, 1740);
  perfect[4] = result(true, true);
  assert.equal(getPuzzleBoardScore(perfect).totalScore, 1710);
  assert.equal(getPuzzleBoardScore(perfect).completionBonus, 200);
});
test('corrected answers earn 70 without reducing line or full-board rewards', () => {
  const corrected = getPuzzleCardResult(applyPuzzleAnswer(applyPuzzleAnswer(card(), 'brigde', 1000), 'bridge', 2000));
  assert.equal(getPuzzleBoardScore([corrected]).wordScore, 70);
  const board = Array.from({ length: 9 }, () => result());
  board[4] = corrected;
  const score = getPuzzleBoardScore(board);
  assert.equal(score.totalScore, 1710);
  assert.equal(score.lineBonus, 640);
  assert.equal(score.completionBonus, 200);
});
test('practice summary excludes unattempted words from accuracy and never enters old rankings', () => {
  const results = [result(), { ...result(false), attemptsUsed: 2, status: 'incorrect' as const }, result(false)];
  const summary = calculatePuzzlePracticeSummary(results, 94000, 'smart', .9);
  assert.equal(summary.accuracyRate, .5);
  assert.equal(summary.wordsTotal, 3);
  assert.equal(summary.rulesVersion, PUZZLE_RULES_VERSION);
  assert.equal(summary.rankingEligible, false);
  assert.equal(summary.rankingIneligibleReason, 'practice_rules_v2');
  assert.equal(summary.timeUsedSeconds, 90);
  assert.equal(summary.secondsRemaining, 0);
  assert.equal(summary.speedScore, 0);
});
test('empty result has no score or invented words', () => {
  const summary = calculatePuzzlePracticeSummary([], -100, 'random');
  assert.equal(summary.totalScore, 0);
  assert.equal(summary.wordsTotal, 0);
  assert.equal(summary.accuracyRate, 0);
  assert.equal(summary.timeUsedSeconds, 0);
});
