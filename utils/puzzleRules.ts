import type { PuzzleCardResult, PuzzleGameCardState, PuzzleGameSummary, PuzzleGameSelectionMode } from '../types.ts';

export const PUZZLE_RULES_VERSION = 'nine-lines-v2-practice';
export const PUZZLE_DURATION_SECONDS = 90;
export const PUZZLE_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
] as const;

export interface PuzzlePracticeCard extends PuzzleGameCardState {
  skipped: boolean;
}

export const normalizePuzzleAnswer = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');

/** Only submitted mismatches are displayed; typing itself is never graded. */
export const getPuzzleMismatchPositions = (submitted: string, answer: string): number[] => {
  const input = Array.from(normalizePuzzleAnswer(submitted));
  const expected = Array.from(normalizePuzzleAnswer(answer));
  return Array.from({ length: Math.max(input.length, expected.length) }, (_, index) => index)
    .filter((index) => input[index] !== expected[index]);
};

export const applyPuzzleAnswer = (card: PuzzlePracticeCard, input: string, elapsedMs: number): PuzzlePracticeCard => {
  const normalizedInput = normalizePuzzleAnswer(input);
  if (card.isSolved || card.isLocked || card.skipped || !normalizedInput) return card;
  const correct = normalizedInput === normalizePuzzleAnswer(card.word.text);
  const attemptsUsed = card.attemptsUsed + 1;
  return {
    ...card,
    inputValue: input,
    attemptsUsed,
    isSolved: correct,
    isLocked: correct || attemptsUsed >= 3,
    solvedAtMs: correct ? Math.max(0, elapsedMs) : null,
    lastWrongInput: correct ? card.lastWrongInput : input,
  };
};

export const getPuzzleCardResult = (card: PuzzlePracticeCard): PuzzleCardResult => ({
  wordId: card.word.id,
  wordText: card.word.text,
  correct: card.isSolved,
  status: card.isSolved ? 'correct' : card.attemptsUsed > 0 ? 'incorrect' : card.skipped ? 'skipped' : 'unattempted',
  attemptsUsed: card.attemptsUsed,
  hintUsed: card.hintUsed,
  solvedAtMs: card.solvedAtMs,
  activatedAtMs: card.activatedAtMs,
});

/** Recompute from the board, so repeated renders/submissions cannot award a line twice. */
export const getPuzzleBoardScore = (results: Pick<PuzzleCardResult, 'correct' | 'hintUsed' | 'attemptsUsed'>[]) => {
  const completedLineIds = PUZZLE_LINES.flatMap((line, index) =>
    line.every((position) => results[position]?.correct) ? [index] : []);
  const wordScore = results.reduce((score, result) => score + (result.correct ? result.hintUsed || result.attemptsUsed > 1 ? 70 : 100 : 0), 0);
  const lineBonus = completedLineIds.length * 80;
  const completionBonus = results.length === 9 && results.every((result) => result.correct) ? 200 : 0;
  return { wordScore, completedLineIds, lineBonus, completionBonus, totalScore: wordScore + lineBonus + completionBonus };
};

export const calculatePuzzlePracticeSummary = (
  results: PuzzleCardResult[],
  elapsedMs: number,
  selectionMode: PuzzleGameSelectionMode,
  overlapRate = 0,
): PuzzleGameSummary => {
  const wordsCorrect = results.filter((result) => result.correct).length;
  const attempted = results.filter((result) => result.correct || result.attemptsUsed > 0).length;
  const solvedWithoutHint = results.filter((result) => result.correct && !result.hintUsed).length;
  const timeUsedSeconds = Math.min(PUZZLE_DURATION_SECONDS, Math.max(0, Math.ceil(elapsedMs / 1000)));
  const score = getPuzzleBoardScore(results);
  return {
    totalScore: score.totalScore,
    accuracyRate: attempted ? Number((wordsCorrect / attempted).toFixed(4)) : 0,
    speedScore: 0,
    noHintScore: 0,
    wordsCorrect,
    wordsTotal: results.length,
    hintsUsed: results.filter((result) => result.hintUsed).length,
    solvedWithoutHint,
    timeUsedSeconds,
    secondsRemaining: PUZZLE_DURATION_SECONDS - timeUsedSeconds,
    selectionMode,
    overlapRate,
    rankingEligible: false,
    rankingIneligibleReason: 'practice_rules_v2',
    rulesVersion: PUZZLE_RULES_VERSION,
    completedLines: score.completedLineIds.length,
    lineBonus: score.lineBonus,
    completionBonus: score.completionBonus,
    results,
  };
};
