/**
 * Phrase Validation Tests
 *
 * Tests for phrase validation functionality including:
 * - Word splitting and validation
 * - Error highlighting
 * - Collocation checking
 * - Edge cases (too many/few words)
 */

import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalProvider } from '../localProvider.ts';

describe('Phrase Validation', () => {
  let localProvider: LocalProvider;

  before(() => {
    // Use the shipped dictionary; tests must never rely on external requests.
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const path = String(input);
      assert.ok(path === '/dictionaries/en.aff' || path === '/dictionaries/en.dic');
      const bytes = await readFile(new URL(`../../../public${path}`, import.meta.url));
      return new Response(bytes.toString('utf8'));
    });
    localProvider = new LocalProvider();
  });

  after(() => mock.restoreAll());

  describe('LocalProvider.validatePhrase', () => {
    it('should reject single word phrases', async () => {
      const result = await localProvider.validatePhrase('hello');
      assert.equal(result.isValid, false);
      assert.equal(result.error, 'TOO_FEW_WORDS');
    });

    it('should reject 4+ word phrases', async () => {
      const result = await localProvider.validatePhrase('one two three four');
      assert.equal(result.isValid, false);
      assert.equal(result.error, 'TOO_MANY_WORDS');
    });

    it('should accept 2-word phrases with correct spelling', async () => {
      const result = await localProvider.validatePhrase('go cycling');
      assert.equal(result.isValid, true);
      assert.equal(result.needsCollocationCheck, true);
    });

    it('should accept 3-word phrases with correct spelling', async () => {
      const result = await localProvider.validatePhrase('take part in');
      assert.equal(result.isValid, true);
      assert.equal(result.needsCollocationCheck, undefined);
    });

    it('should highlight misspelled words in 2-word phrase', async () => {
      const result = await localProvider.validatePhrase('go cyclling');
      assert.equal(result.isValid, false);
      assert.ok(result.highlightedPhrase?.includes('[cyclling]'));
      assert.equal(result.highlightedPhrase?.includes('[go]'), false);
    });

    it('should highlight multiple misspelled words', async () => {
      const result = await localProvider.validatePhrase('gooo cyclling');
      assert.equal(result.isValid, false);
      assert.equal(result.highlightedPhrase, '[gooo] [cyclling]');
    });

    it('should provide suggestions for misspelled phrases', async () => {
      const result = await localProvider.validatePhrase('go cyclling');
      assert.equal(result.isValid, false);
      assert.notEqual(result.suggestion, undefined);
      assert.match(result.suggestion, /go cycling/i);
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
          assert.equal(result.isValid, false);
          assert.equal(result.error, expectedError);
        } else {
          assert.notEqual(result.isValid, false);
          assert.equal(result.error, undefined);
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
        assert.equal(result.isValid, true);
      });
    });
  });
});

/**
 * SM-2 Algorithm Tests
 */

import { calculateNextReview, createNewSM2State, calculateNextReviewDate, errorRateToQuality } from '../../../utils/sm2Algorithm.ts';

describe('SM-2 Algorithm', () => {
  describe('calculateNextReview', () => {
    it('should reset on poor quality (< 3)', () => {
      const state = createNewSM2State();
      state.interval = 10;
      state.repetitions = 5;

      const newState = calculateNextReview(state, 2);
      assert.equal(newState.repetitions, 0);
      assert.equal(newState.interval, 1);
    });

    it('should set interval to 1 on first successful repetition', () => {
      const state = createNewSM2State();
      const newState = calculateNextReview(state, 5);
      assert.equal(newState.repetitions, 1);
      assert.equal(newState.interval, 1);
    });

    it('should set interval to 6 on second successful repetition', () => {
      const state = createNewSM2State();
      state.repetitions = 1;
      const newState = calculateNextReview(state, 5);
      assert.equal(newState.repetitions, 2);
      assert.equal(newState.interval, 6);
    });

    it('should scale interval by ease factor on subsequent repetitions', () => {
      const state = createNewSM2State();
      state.repetitions = 2;
      state.interval = 6;
      state.easeFactor = 2.5;

      const newState = calculateNextReview(state, 5);
      assert.equal(newState.repetitions, 3);
      assert.equal(newState.interval, 15); // 6 * 2.5
    });

    it('should preserve ease at quality 4 and increase it at quality 5', () => {
      const state = createNewSM2State();
      assert.equal(calculateNextReview(state, 4).easeFactor, 2.5);
      assert.equal(calculateNextReview(state, 5).easeFactor, 2.6);
    });

    it('should clamp ease factor to minimum of 1.3', () => {
      const state = createNewSM2State();
      state.easeFactor = 1.3;

      const newState = calculateNextReview(state, 0);
      assert.equal(newState.easeFactor, 1.3);
    });
  });

  describe('createNewSM2State', () => {
    it('should create initial state with default values', () => {
      const state = createNewSM2State();
      assert.equal(state.interval, 0);
      assert.equal(state.repetitions, 0);
      assert.equal(state.easeFactor, 2.5);
    });
  });

  describe('calculateNextReviewDate', () => {
    it('should calculate next review date from timestamp', () => {
      const baseDate = new Date('2025-01-01').getTime();
      const nextDate = calculateNextReviewDate(baseDate, 7);
      const expectedDate = new Date('2025-01-08');
      assert.equal(nextDate.toDateString(), expectedDate.toDateString());
    });

    it('should calculate next review date from Date object', () => {
      const baseDate = new Date('2025-01-01');
      const nextDate = calculateNextReviewDate(baseDate, 3);
      const expectedDate = new Date('2025-01-04');
      assert.equal(nextDate.toDateString(), expectedDate.toDateString());
    });
  });

  describe('errorRateToQuality', () => {
    it('should return high quality for success with no errors', () => {
      const quality = errorRateToQuality(0, true);
      assert.equal(quality, 5);
    });

    it('should return lower quality for success with errors', () => {
      const quality = errorRateToQuality(2, true);
      assert.equal(quality, 3);
    });

    it('should return low quality for failure', () => {
      const quality = errorRateToQuality(0, false);
      assert.ok(quality < 3);
    });

    it('should decrease quality with more errors on failure', () => {
      const q1 = errorRateToQuality(1, false);
      const q2 = errorRateToQuality(3, false);
      assert.ok(q2 < q1);
    });
  });
});
