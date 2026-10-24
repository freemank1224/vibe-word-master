import type { SavedSurfAttempt } from './sessionJournal.ts';
import type { SurfWord } from './types.ts';

export type SurfReviewWordStatus = 'first-try-correct' | 'corrected' | 'incorrect' | 'unanswered' | 'not-reached';
export interface SurfReviewAttempt { answer: string; correct: boolean; }
export interface SurfRunReviewWord {
  key: string;
  /** Zero-based position in the frozen round queue. */
  index: number;
  word: SurfWord;
  status: SurfReviewWordStatus;
  attempts: SurfReviewAttempt[];
  wrongAnswers: string[];
  mistakeCount: number;
  firstTryCorrect: boolean;
  completed: boolean;
}
export interface SurfRunReview {
  rows: SurfRunReviewWord[];
  totalCount: number;
  attemptedCount: number;
  firstTryCorrectCount: number;
  correctedCount: number;
  incorrectCount: number;
  /** Includes words corrected after one or more wrong submissions. */
  wrongWordCount: number;
  completedCount: number;
  unansweredCount: number;
  notReachedCount: number;
  attemptCount: number;
  correctAttemptCount: number;
  incorrectAttemptCount: number;
  /** Percentages, or null when no answer was submitted. */
  firstAnswerAccuracy: number | null;
  attemptAccuracy: number | null;
}

// Keep spelling equivalence identical to the game and server settlement rules.
const normalizeAnswer = (value: string) => value.normalize('NFKC').trim().toLowerCase()
  .replace(/[’‘]/g, "'").replace(/[‐‑]/g, '-');

/** A read-only projection: opening or filtering a review never creates learning events. */
export function buildSurfRunReview(
  deck: readonly SurfWord[], attempts: readonly SavedSurfAttempt[], checkpoint: number,
): SurfRunReview {
  const byWord = new Map<string, SurfReviewAttempt[]>();
  const answers = new Map(deck.map((word, index) => [word.wordId ?? `practice:${index}`, normalizeAnswer(word.answer)]));
  const seenEvents = new Set<string>();
  for (const attempt of attempts) {
    const expected = answers.get(attempt.wordId);
    const answer = normalizeAnswer(attempt.answer);
    // Empty submissions and unrelated history do not represent a tested word.
    if (expected === undefined || !answer) continue;
    if (attempt.learning?.eventId) {
      if (seenEvents.has(attempt.learning.eventId)) continue;
      seenEvents.add(attempt.learning.eventId);
    }
    const wordAttempts = byWord.get(attempt.wordId) ?? [];
    wordAttempts.push({ answer: attempt.answer, correct: answer === expected });
    byWord.set(attempt.wordId, wordAttempts);
  }
  const lastReached = Number.isFinite(checkpoint) ? Math.floor(checkpoint) : -1;
  const rows: SurfRunReviewWord[] = deck.map((word, index) => {
    const key = word.wordId ?? `practice:${index}`;
    const wordAttempts = byWord.get(key) ?? [];
    const wrongAnswers = wordAttempts.filter(attempt => !attempt.correct).map(attempt => attempt.answer);
    const firstTryCorrect = wordAttempts[0]?.correct === true;
    const completed = wordAttempts.some(attempt => attempt.correct);
    const status: SurfReviewWordStatus = firstTryCorrect ? 'first-try-correct'
      : completed ? 'corrected'
        : wordAttempts.length > 0 ? 'incorrect'
          : index <= lastReached ? 'unanswered' : 'not-reached';
    return { key, index, word: { ...word }, status, attempts: wordAttempts, wrongAnswers,
      mistakeCount: wrongAnswers.length, firstTryCorrect, completed };
  });
  const attemptedCount = rows.filter(row => row.attempts.length > 0).length;
  const firstTryCorrectCount = rows.filter(row => row.firstTryCorrect).length;
  const attemptCount = rows.reduce((sum, row) => sum + row.attempts.length, 0);
  const incorrectAttemptCount = rows.reduce((sum, row) => sum + row.mistakeCount, 0);
  const correctAttemptCount = attemptCount - incorrectAttemptCount;
  return {
    rows, totalCount: rows.length, attemptedCount, firstTryCorrectCount,
    correctedCount: rows.filter(row => row.status === 'corrected').length,
    incorrectCount: rows.filter(row => row.status === 'incorrect').length,
    wrongWordCount: rows.filter(row => row.mistakeCount > 0).length,
    completedCount: rows.filter(row => row.completed).length,
    unansweredCount: rows.filter(row => row.status === 'unanswered').length,
    notReachedCount: rows.filter(row => row.status === 'not-reached').length,
    attemptCount, correctAttemptCount, incorrectAttemptCount,
    firstAnswerAccuracy: attemptedCount ? 100 * firstTryCorrectCount / attemptedCount : null,
    attemptAccuracy: attemptCount ? 100 * correctAttemptCount / attemptCount : null,
  };
}
