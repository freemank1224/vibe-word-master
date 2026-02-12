/**
 * Phrase Validation Tests
 *
 * Tests for phrase validation functionality including:
 * - Word splitting and validation
 * - Error highlighting
 * - Collocation checking
 * - Edge cases (too many/few words)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LocalProvider } from '../localProvider';

describe('Phrase Validation', () => {
  let localProvider: LocalProvider;

  beforeEach(() => {
    localProvider = new LocalProvider();
  });

  describe('LocalProvider.validatePhrase', () => {
    it('should reject single word phrases', async () => {
      const result = await localProvider.validatePhrase('hello');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('TOO_FEW_WORDS');
    });

    it('should reject 4+ word phrases', async () => {
      const result = await localProvider.validatePhrase('one two three four');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('TOO_MANY_WORDS');
    });

    it('should accept 2-word phrases with correct spelling', async () => {
      const result = await localProvider.validatePhrase('go cycling');
      expect(result.isValid).toBe(true);
      expect(result.needsCollocationCheck).toBe(true);
    });

    it('should accept 3-word phrases with correct spelling', async () => {
      const result = await localProvider.validatePhrase('take part in');
      expect(result.isValid).toBe(true);
      expect(result.needsCollocationCheck).toBeUndefined();
    });

    it('should highlight misspelled words in 2-word phrase', async () => {
      const result = await localProvider.validatePhrase('go cyclling');
      expect(result.isValid).toBe(false);
      expect(result.highlightedPhrase).toContain('[cyclling]');
      expect(result.highlightedPhrase).not.toContain('[go]');
    });

    it('should highlight multiple misspelled words', async () => {
      const result = await localProvider.validatePhrase('gooo cyclling');
      expect(result.isValid).toBe(false);
      expect(result.highlightedPhrase).toBe('[gooo] [cyclling]');
    });

    it('should provide suggestions for misspelled phrases', async () => {
      const result = await localProvider.validatePhrase('go cyclling');
      expect(result.isValid).toBe(false);
      expect(result.suggestion).toBeDefined();
      expect(result.suggestion).toMatch(/go cycling/i);
    });
  });

  describe('Phrase Length Validation', () => {
    const testCases = [
      { input: 'word', expectedError: 'TOO_FEW_WORDS' },
      { input: 'one two', expectedError: undefined },
      { input: 'one two three', expectedError: undefined },
      { input: 'one two three four', expectedError: 'TOO_MANY_WORDS' },
      { input: 'one two three four five', expectedError: 'TOO_MANY_WORDS' },
    ];

    testCases.forEach(({ input, expectedError }) => {
      it(`should handle "${input}" correctly`, async () => {
        const result = await localProvider.validatePhrase(input);
        if (expectedError) {
          expect(result.isValid).toBe(false);
          expect(result.error).toBe(expectedError);
        } else {
          expect(result.isValid).not.toBe(false);
          expect(result.error).toBeUndefined();
        }
      });
    });
  });

  describe('Common Phrase Examples', () => {
    const commonPhrases = [
      'go cycling',
      'take part in',
      'look forward to',
      'New York',
      'San Francisco',
      'ice cream',
      'make sense',
    ];

    commonPhrases.forEach(phrase => {
      it(`should validate "${phrase}" as structurally valid`, async () => {
        const result = await localProvider.validatePhrase(phrase);
        expect(result.isValid).toBe(true);
      });
    });
  });
});

/**
 * SM-2 Algorithm Tests
 */

import { calculateNextReview, createNewSM2State, calculateNextReviewDate, errorRateToQuality } from '../../utils/sm2Algorithm';

describe('SM-2 Algorithm', () => {
  describe('calculateNextReview', () => {
    it('should reset on poor quality (< 3)', () => {
      const state = createNewSM2State();
      state.interval = 10;
      state.repetitions = 5;

      const newState = calculateNextReview(state, 2);
      expect(newState.repetitions).toBe(0);
      expect(newState.interval).toBe(1);
    });

    it('should set interval to 1 on first successful repetition', () => {
      const state = createNewSM2State();
      const newState = calculateNextReview(state, 5);
      expect(newState.repetitions).toBe(1);
      expect(newState.interval).toBe(1);
    });

    it('should set interval to 6 on second successful repetition', () => {
      const state = createNewSM2State();
      state.repetitions = 1;
      const newState = calculateNextReview(state, 5);
      expect(newState.repetitions).toBe(2);
      expect(newState.interval).toBe(6);
    });

    it('should scale interval by ease factor on subsequent repetitions', () => {
      const state = createNewSM2State();
      state.repetitions = 2;
      state.interval = 6;
      state.easeFactor = 2.5;

      const newState = calculateNextReview(state, 5);
      expect(newState.repetitions).toBe(3);
      expect(newState.interval).toBe(15); // 6 * 2.5
    });

    it('should adjust ease factor based on quality', () => {
      const state = createNewSM2State();
      const newState = calculateNextReview(state, 4);
      expect(newState.easeFactor).toBeGreaterThan(2.5);
    });

    it('should clamp ease factor to minimum of 1.3', () => {
      const state = createNewSM2State();
      state.easeFactor = 1.3;

      const newState = calculateNextReview(state, 0);
      expect(newState.easeFactor).toBe(1.3);
    });
  });

  describe('createNewSM2State', () => {
    it('should create initial state with default values', () => {
      const state = createNewSM2State();
      expect(state.interval).toBe(0);
      expect(state.repetitions).toBe(0);
      expect(state.easeFactor).toBe(2.5);
    });
  });

  describe('calculateNextReviewDate', () => {
    it('should calculate next review date from timestamp', () => {
      const baseDate = new Date('2025-01-01').getTime();
      const nextDate = calculateNextReviewDate(baseDate, 7);
      const expectedDate = new Date('2025-01-08');
      expect(nextDate.toDateString()).toBe(expectedDate.toDateString());
    });

    it('should calculate next review date from Date object', () => {
      const baseDate = new Date('2025-01-01');
      const nextDate = calculateNextReviewDate(baseDate, 3);
      const expectedDate = new Date('2025-01-04');
      expect(nextDate.toDateString()).toBe(expectedDate.toDateString());
    });
  });

  describe('errorRateToQuality', () => {
    it('should return high quality for success with no errors', () => {
      const quality = errorRateToQuality(0, true);
      expect(quality).toBe(5);
    });

    it('should return lower quality for success with errors', () => {
      const quality = errorRateToQuality(2, true);
      expect(quality).toBe(3);
    });

    it('should return low quality for failure', () => {
      const quality = errorRateToQuality(0, false);
      expect(quality).toBeLessThan(3);
    });

    it('should decrease quality with more errors on failure', () => {
      const q1 = errorRateToQuality(1, false);
      const q2 = errorRateToQuality(3, false);
      expect(q2).toBeLessThan(q1);
    });
  });
});
