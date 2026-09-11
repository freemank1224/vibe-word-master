/**
 * Unit tests for the pure WORD STRIKE game logic (services/wordStrike.ts).
 *
 * Covers:
 *   - matchTypedWord: per-position hit/miss, normalization, length edges
 *   - candidate filter: deleted / non a-z / length bounds / dedup
 *   - selection: random truncation, undersized pool, smart mode shape
 *   - difficulty curve: monotonic gravity ramp + unit-size clamps
 *   - summary: perfect/zero scores, clamping, leaderboard gates
 *
 * Pure module: no matter-js / DOM APIs, runs under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORD_STRIKE_BATCH_SIZE,
  WORD_STRIKE_MAX_WORD_LENGTH,
  applyWordStrikeScope,
  getWordStrikeCandidateWords,
  getWordStrikeGravityScale,
  getWordStrikeUnitSize,
  calculateWordStrikeGameSummary,
  matchTypedWord,
  normalizeWordStrikeInput,
  selectWordStrikeWords,
} from '../../services/wordStrike.ts';
import type { InputSession, WordEntry, WordStrikeCardResult } from '../../types.ts';

// ----------------------------------------------------------------
// helpers
// ----------------------------------------------------------------

let idCounter = 0;
const makeWord = (overrides: Partial<WordEntry> = {}): WordEntry => ({
  id: `w-${idCounter++}`,
  text: 'apple',
  timestamp: Date.now(),
  sessionId: 's1',
  correct: true,
  tested: true,
  image_path: null,
  image_url: null,
  image_asset_id: null,
  error_count: 0,
  best_time_ms: null,
  last_tested: null,
  phonetic: null,
  audio_url: null,
  language: 'en',
  definition_cn: '苹果',
  definition_en: 'a fruit',
  ...overrides,
});

const makeResult = (overrides: Partial<WordStrikeCardResult> = {}): WordStrikeCardResult => ({
  wordId: 'w-x',
  wordText: 'apple',
  correct: true,
  attemptsUsed: 1,
  lettersHit: 5,
  lettersMissed: 0,
  hintUsed: false,
  solvedAtMs: 3000,
  activatedAtMs: 0,
  ...overrides,
});

// ----------------------------------------------------------------
// matchTypedWord
// ----------------------------------------------------------------

test('matchTypedWord: all letters correct → full match', () => {
  const match = matchTypedWord('branch', 'branch');
  assert.deepEqual(match.hits, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(match.misses, []);
  assert.equal(match.hitCount, 6);
  assert.equal(match.missCount, 0);
  assert.equal(match.isFullMatch, true);
});

test('matchTypedWord: mixed word (planet vs plaent transposition) → hits [0,1,2,5]', () => {
  const match = matchTypedWord('planet', 'plaent');
  assert.deepEqual(match.hits, [0, 1, 2, 5]);
  assert.deepEqual(match.misses, [3, 4]);
  assert.equal(match.isFullMatch, false);
});

test('matchTypedWord: single-char diff (branch vs brunch) → only position 2 misses', () => {
  const match = matchTypedWord('branch', 'brunch');
  assert.deepEqual(match.hits, [0, 1, 3, 4, 5]);
  assert.deepEqual(match.misses, [2]);
  assert.equal(match.isFullMatch, false);
});

test('matchTypedWord: case-insensitive and whitespace-stripped', () => {
  assert.equal(matchTypedWord('Branch', 'BRANCH').isFullMatch, true);
  assert.equal(normalizeWordStrikeInput('  A p p l e '), 'apple');
});

test('matchTypedWord: shorter typed → missing tail counts as miss', () => {
  const match = matchTypedWord('branch', 'br');
  assert.deepEqual(match.hits, [0, 1]);
  assert.deepEqual(match.misses, [2, 3, 4, 5]);
  assert.equal(match.isFullMatch, false);
});

test('matchTypedWord: longer typed → extras ignored but not a full match', () => {
  const match = matchTypedWord('cat', 'cattt');
  assert.deepEqual(match.hits, [0, 1, 2]);
  assert.deepEqual(match.misses, []);
  assert.equal(match.isFullMatch, false);
});

test('matchTypedWord: empty typed → all misses', () => {
  const match = matchTypedWord('cat', '');
  assert.deepEqual(match.hits, []);
  assert.deepEqual(match.misses, [0, 1, 2]);
  assert.equal(match.isFullMatch, false);
});

// ----------------------------------------------------------------
// candidate filter
// ----------------------------------------------------------------

test('getWordStrikeCandidateWords: drops deleted, non a-z, out-of-bounds lengths', () => {
  const words = [
    makeWord({ id: 'keep-1', text: 'apple' }),
    makeWord({ id: 'drop-deleted', text: 'banana', deleted: true }),
    makeWord({ id: 'drop-accent', text: 'café' }),
    makeWord({ id: 'drop-space', text: 'give up' }),
    makeWord({ id: 'drop-digit', text: 'abc1' }),
    makeWord({ id: 'drop-single', text: 'a' }),
    makeWord({ id: 'drop-long', text: 'a'.repeat(WORD_STRIKE_MAX_WORD_LENGTH + 1) }),
    makeWord({ id: 'keep-max', text: 'a'.repeat(WORD_STRIKE_MAX_WORD_LENGTH) }),
  ];

  const candidates = getWordStrikeCandidateWords(words);
  assert.deepEqual(candidates.map((w) => w.id).sort(), ['keep-1', 'keep-max']);
});

test('getWordStrikeCandidateWords: dedupes case/whitespace variants, keeps first', () => {
  const first = makeWord({ id: 'first', text: 'Hello' });
  const second = makeWord({ id: 'second', text: 'hello' });
  const third = makeWord({ id: 'third', text: '  HELLO  ' });

  const candidates = getWordStrikeCandidateWords([first, second, third]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, 'first');
});

// ----------------------------------------------------------------
// selection
// ----------------------------------------------------------------

/** Builds `count` unique all-letter word texts: 'aq'..'zq', then 'ar'..'dr', … */
const letterPoolTexts = (count: number): string[] =>
  Array.from({ length: count }, (_, i) =>
    `${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}q`
  );

// ----------------------------------------------------------------
// sampling scope
// ----------------------------------------------------------------

const makeSession = (id: string, timestamp: number, deleted = false): InputSession => ({
  id,
  timestamp,
  wordCount: 5,
  targetCount: 5,
  deleted,
});

test('applyWordStrikeScope: recent3 keeps only words from the 3 newest sessions', () => {
  const sessions = [
    makeSession('s1', 100),
    makeSession('s2', 300),
    makeSession('s3', 200),
    makeSession('s4', 400),
  ];
  const words = [
    makeWord({ id: 'w1', sessionId: 's1', text: 'aaa' }),
    makeWord({ id: 'w2', sessionId: 's4', text: 'bbb' }),
    makeWord({ id: 'w3', sessionId: 's2', text: 'ccc' }),
    makeWord({ id: 'w4', sessionId: 's3', text: 'ddd' }),
    makeWord({ id: 'w5', sessionId: 's9', text: 'eee' }), // unknown session
  ];

  const scoped = applyWordStrikeScope(words, sessions, 'recent3');
  // 3 newest = s4(400), s2(300), s3(200) → w2, w3, w4 stay
  assert.deepEqual(scoped.map((w) => w.id).sort(), ['w2', 'w3', 'w4']);
});

test('applyWordStrikeScope: deleted sessions never count toward recency', () => {
  const sessions = [makeSession('new', 500, true), makeSession('old', 100)];
  const words = [
    makeWord({ id: 'a', sessionId: 'new', text: 'aaa' }),
    makeWord({ id: 'b', sessionId: 'old', text: 'bbb' }),
  ];

  const scoped = applyWordStrikeScope(words, sessions, 'recent3');
  assert.deepEqual(scoped.map((w) => w.id), ['b']);
});

test('applyWordStrikeScope: falls back to all words when no sessions exist', () => {
  const words = [makeWord({ text: 'aaa' }), makeWord({ text: 'bbb' })];
  assert.equal(applyWordStrikeScope(words, [], 'recent5').length, 2);
});

test('applyWordStrikeScope: falls back to all when the scoped pool is empty', () => {
  const sessions = [makeSession('s1', 100)];
  const words = [makeWord({ sessionId: 'unknown', text: 'aaa' })];
  assert.equal(applyWordStrikeScope(words, sessions, 'recent3').length, 1);
});

test('applyWordStrikeScope: all scope returns words untouched', () => {
  const words = [makeWord({ sessionId: 'x', text: 'aaa' })];
  assert.equal(applyWordStrikeScope(words, [], 'all').length, 1);
});

test('selectWordStrikeWords: random mode truncates to batch size', async () => {
  const pool = letterPoolTexts(30).map((text, i) => makeWord({ id: `p-${i}`, text }));
  const selection = await selectWordStrikeWords(pool, [], false, WORD_STRIKE_BATCH_SIZE);

  assert.equal(selection.words.length, WORD_STRIKE_BATCH_SIZE);
  assert.equal(selection.selectionMode, 'random');
  assert.equal(selection.rankingEligible, true);
});

test('selectWordStrikeWords: pool smaller than request returns whole pool', async () => {
  const pool = [makeWord({ text: 'cat' }), makeWord({ text: 'dog' }), makeWord({ text: 'sun' })];
  const selection = await selectWordStrikeWords(pool, [], false, WORD_STRIKE_BATCH_SIZE);

  assert.equal(selection.words.length, 3);
});

test('selectWordStrikeWords: no candidates → empty, still eligible', async () => {
  const selection = await selectWordStrikeWords([makeWord({ text: 'café' })], [], true, 12);
  assert.equal(selection.words.length, 0);
  assert.equal(selection.rankingEligible, true);
});

test('selectWordStrikeWords: smart mode returns requested count on large pool', async () => {
  // Stub localStorage so the smart path can persist its daily history.
  const store = new Map<string, string>();
  (globalThis as any).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };

  try {
    const pool = letterPoolTexts(40).map((text, i) => makeWord({ id: `s-${i}`, text }));
    const selection = await selectWordStrikeWords(pool, [], true, WORD_STRIKE_BATCH_SIZE);

    // Under node the adaptive selector's `@/types` alias cannot resolve, so the
    // smart path degrades to shuffled candidates — the shape contract still holds.
    assert.equal(selection.words.length, WORD_STRIKE_BATCH_SIZE);
    assert.equal(selection.selectionMode, 'smart');
    assert.ok(store.has('vibe_word_strike_daily_selection_history'));
  } finally {
    delete (globalThis as any).window;
  }
});

// ----------------------------------------------------------------
// difficulty curve
// ----------------------------------------------------------------

test('getWordStrikeGravityScale: monotonic ramp, clamped at both ends', () => {
  assert.equal(getWordStrikeGravityScale(0), 0.05);
  assert.equal(getWordStrikeGravityScale(-5), 0.05);
  assert.ok(getWordStrikeGravityScale(1) > getWordStrikeGravityScale(0));
  assert.ok(getWordStrikeGravityScale(10) > getWordStrikeGravityScale(5));
  assert.equal(getWordStrikeGravityScale(100), 0.18);
});

test('getWordStrikeUnitSize: shrinks with length, clamped to [26, 52]', () => {
  assert.equal(getWordStrikeUnitSize(4, 900), 52); // floor(900*0.62/4)=139 → 52
  assert.equal(getWordStrikeUnitSize(10, 900), 52); // floor(558/10)=55 → 52
  assert.equal(getWordStrikeUnitSize(14, 900), 39); // floor(558/14)
  assert.equal(getWordStrikeUnitSize(30, 900), 26); // 18 → 26 floor clamp
  assert.equal(getWordStrikeUnitSize(0, 900), 26); // degenerate guard
});

// ----------------------------------------------------------------
// summary
// ----------------------------------------------------------------

test('calculateWordStrikeGameSummary: perfect fast run scores 1000', () => {
  const results = Array.from({ length: 12 }, (_, i) =>
    makeResult({ wordId: `w-${i}`, lettersHit: 5, lettersMissed: 0, solvedAtMs: 4000, activatedAtMs: 0 })
  );
  const summary = calculateWordStrikeGameSummary(results, {
    lettersHit: 60,
    lettersFired: 60,
    maxCombo: 12,
    livesLost: 0,
    livesRemaining: 3,
    elapsedMs: 40_000,
    selectionMode: 'smart',
    overlapRate: 0,
    rankingEligible: true,
    rankingIneligibleReason: null,
  });

  assert.equal(summary.totalScore, 1000);
  assert.equal(summary.accuracyRate, 1);
  assert.equal(summary.wordsCorrect, 12);
  assert.equal(summary.speedScore, 1000); // fast tier, accuracy gate open
  assert.equal(summary.comboScore, 1000);
});

test('calculateWordStrikeGameSummary: zero letters hit scores near zero', () => {
  const results = [makeResult({ correct: false, lettersHit: 0, lettersMissed: 5, solvedAtMs: null, activatedAtMs: 0 })];
  const summary = calculateWordStrikeGameSummary(results, {
    lettersHit: 0,
    lettersFired: 10,
    maxCombo: 0,
    livesLost: 3,
    livesRemaining: 0,
    elapsedMs: 30_000,
    selectionMode: 'random',
    overlapRate: 0,
    rankingEligible: true,
    rankingIneligibleReason: null,
  });

  assert.equal(summary.totalScore, 0);
  assert.equal(summary.speedScore, 0); // accuracy 0 < 0.85 gate
  assert.equal(summary.livesRemaining, 0);
});

test('calculateWordStrikeGameSummary: score clamped to [0, 1000]', () => {
  const results = [makeResult({ lettersHit: 100, lettersMissed: 0, solvedAtMs: 1000, activatedAtMs: 0 })];
  const summary = calculateWordStrikeGameSummary(results, {
    lettersHit: 9999,
    lettersFired: 1,
    maxCombo: 99,
    livesLost: 0,
    livesRemaining: 3,
    elapsedMs: 1000,
    selectionMode: 'random',
    overlapRate: 0,
    rankingEligible: true,
    rankingIneligibleReason: null,
  });

  assert.ok(summary.totalScore <= 1000 && summary.totalScore >= 0);
  assert.equal(summary.lettersFired, 1); // clamped input: hit > fired is impossible in real play
});

test('calculateWordStrikeGameSummary: ineligible ranking propagates with reason', () => {
  const summary = calculateWordStrikeGameSummary([makeResult()], {
    lettersHit: 5,
    lettersFired: 5,
    maxCombo: 1,
    livesLost: 0,
    livesRemaining: 3,
    elapsedMs: 5000,
    selectionMode: 'smart',
    overlapRate: 0.9,
    rankingEligible: false,
    rankingIneligibleReason: 'overlap_too_high',
  });

  assert.equal(summary.rankingEligible, false);
  assert.equal(summary.rankingIneligibleReason, 'overlap_too_high');
  assert.equal(summary.overlapRate, 0.9);
});
