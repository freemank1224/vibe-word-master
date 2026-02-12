/**
 * SM-2 (SuperMemo 2) Algorithm Implementation
 *
 * A spaced repetition algorithm for calculating review intervals
 * when AI optimization is unavailable.
 *
 * Reference: https://www.supermemo.com/en/blog/application-of-a-computer-to-improve-the-results-obtained-in-working-with-the-supermemo-method
 */

export interface SM2State {
  interval: number;      // Days until next review
  repetitions: number;   // Number of successful repetitions
  easeFactor: number;    // Easiness factor (1.3 - 2.5+)
}

/**
 * Calculate the next review parameters based on user performance
 *
 * @param state - Current SM2 state
 * @param quality - Quality rating (0-5):
 *   5 - Perfect response
 *   4 - Correct response after a hesitation
 *   3 - Correct response recalled with serious difficulty
 *   2 - Incorrect response; where the correct one seemed easy to recall
 *   1 - Incorrect response; the correct one remembered
 *   0 - Complete blackout
 *
 * @returns Next SM2 state
 */
export function calculateNextReview(
  state: SM2State,
  quality: number
): SM2State {
  let { interval, repetitions, easeFactor } = state;

  // Quality < 3 means the user failed to recall
  // Reset repetitions and interval
  if (quality < 3) {
    repetitions = 0;
    interval = 1;
  } else {
    // Quality >= 3 means successful recall
    repetitions += 1;

    // Calculate interval based on repetitions
    if (repetitions === 1) {
      interval = 1;
    } else if (repetitions === 2) {
      interval = 6;
    } else {
      interval = Math.round(interval * easeFactor);
    }
  }

  // Update ease factor
  // EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
  easeFactor = easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));

  // Clamp ease factor to minimum of 1.3
  if (easeFactor < 1.3) {
    easeFactor = 1.3;
  }

  return {
    interval,
    repetitions,
    easeFactor
  };
}

/**
 * Create a new SM2 state for a first-time word
 *
 * @returns Initial SM2 state
 */
export function createNewSM2State(): SM2State {
  return {
    interval: 0,
    repetitions: 0,
    easeFactor: 2.5  // Default easiness factor
  };
}

/**
 * Calculate next review date from a base date
 *
 * @param baseDate - Base date (timestamp or Date)
 * @param intervalDays - Interval in days
 * @returns Next review date as Date object
 */
export function calculateNextReviewDate(
  baseDate: number | Date,
  intervalDays: number
): Date {
  const base = baseDate instanceof Date ? baseDate.getTime() : baseDate;
  return new Date(base + intervalDays * 24 * 60 * 60 * 1000);
}

/**
 * Convert WordEntry error rate to quality rating
 * Higher error count = lower quality
 *
 * @param errorCount - Number of errors for this word
 * @param success - Whether the word was spelled correctly this time
 * @returns Quality rating (0-5)
 */
export function errorRateToQuality(errorCount: number, success: boolean): number {
  if (!success) {
    // Failed: quality based on how many errors they've had
    return Math.max(0, 3 - errorCount * 0.5);
  }

  // Success: base quality on error count
  // 0 errors = 5 (perfect)
  // 1 error = 4 (slight hesitation)
  // 2+ errors = 3 (difficult but correct)
  return Math.max(3, 5 - errorCount);
}
