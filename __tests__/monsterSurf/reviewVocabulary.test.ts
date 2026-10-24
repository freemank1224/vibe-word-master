import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSurfReviewVocabulary, toSurfReviewWord, SURF_REVIEW_LIMIT } from '../../features/monster-surf/reviewVocabulary.ts';
import { DAY_MS, type ReviewState } from '../../services/reviewScheduler.ts';
import type { WordEntry } from '../../types.ts';

const NOW = Date.UTC(2026, 9, 24, 12);
const review = (overrides: Partial<ReviewState> = {}): ReviewState => ({
  version: 1, phase: 'review', dueAt: NOW, stabilityDays: 1, difficulty: 5,
  lastReviewedAt: NOW - DAY_MS, lastIndependentReviewAt: NOW - DAY_MS,
  lapses: 0, repetitions: 2, learningStep: 1, lastOutcome: 'independent', ...overrides,
});
const word = (id: string, overrides: Partial<WordEntry> = {}): WordEntry => ({
  id, text: id, timestamp: NOW - DAY_MS, sessionId: 'session', correct: true,
  tested: false, error_count: 0, best_time_ms: null, last_tested: null,
  phonetic: null, audio_url: null, definition_cn: '真实中文词义', definition_en: 'A meaning.',
  language: 'en', ...overrides,
});
const select = (words: WordEntry[], limit = SURF_REVIEW_LIMIT) => selectSurfReviewVocabulary(words, { now: NOW, limit });

test('Surf reuses forgetting-curve urgency: due relearning, overdue/weak reviews, new, upcoming', () => {
  const pool = [
    word('newer', { timestamp: NOW - 5 }),
    word('future', { review_state: review({ dueAt: NOW + DAY_MS }) }),
    word('due', { review_state: review() }),
    word('weak', { review_state: review({ difficulty: 9, lapses: 3 }) }),
    word('overdue', { review_state: review({ dueAt: NOW - 10 * DAY_MS, lastReviewedAt: NOW - 11 * DAY_MS }) }),
    word('relearn', { review_state: review({ phase: 'relearning', lastOutcome: 'incorrect' }) }),
    word('older', { timestamp: NOW - 2 * DAY_MS }),
  ];
  const result = select(pool);
  assert.equal(result.strategy, 'spaced-review');
  assert.deepEqual(result.entries.map(item => item.id), ['relearn', 'overdue', 'weak', 'due', 'older', 'newer', 'future']);
  assert.deepEqual(result.deck.map(item => item.wordId), result.entries.map(item => item.id));
  assert.deepEqual(result.deck.map(item => item.reviewCategory), ['due_relearning', 'due_review', 'due_review', 'due_review', 'new', 'new', 'upcoming']);
  assert.deepEqual(result.summary, {
    candidateCount: 7, selectedCount: 7, dueRelearningCount: 1, dueReviewCount: 3,
    newCount: 2, upcomingCount: 1, remainingDueCount: 0, nextDueAt: NOW + DAY_MS,
    excludedCount: 0, duplicateCount: 0,
  });
});

test('a due backlog uses the entire round before any new or not-yet-due filler', () => {
  const pool = [word('fresh'), word('late', { review_state: review() }), word('later', { review_state: review() })];
  const result = select(pool, 1);
  assert.equal(result.summary.newCount, 0);
  assert.equal(result.summary.dueReviewCount, 1);
  assert.equal(result.summary.remainingDueCount, 1);
});

test('urgent copies win before spelling and language-variant deduplication', () => {
  const pool = [
    word('fresh-copy', { text: '  APPLE ' }),
    word('urgent-copy', { text: 'apple', language: 'en-US', review_state: review({ phase: 'relearning' }) }),
    word('third-copy', { text: 'ＡＰＰＬＥ', language: 'en-GB', review_state: review() }),
    word('pear-copy', { text: 'pear' }),
    word('pear-copy', { text: 'banana' }),
  ];
  const result = select(pool);
  assert.equal(result.deck.length, 2);
  assert.equal(result.deck[0].wordId, 'urgent-copy');
  assert.equal(result.deck[0].answer, 'apple');
  assert.equal(result.summary.duplicateCount, 3);
});

test('invalid spelling, deleted words, non-English words and missing or leaking Chinese clues are excluded', () => {
  const pool = [
    word('valid'),
    word('deleted', { deleted: true }),
    word('phrase', { text: 'ice cream' }),
    word('short', { text: 'a' }),
    word('long', { text: 'a'.repeat(25) }),
    word('digits', { text: 'word2' }),
    word('accent', { text: 'café' }),
    word('foreign', { text: 'bonjour', language: 'fr' }),
    word('missing', { definition_cn: null }),
    word('notchinese', { definition_cn: 'An English definition' }),
    word('leaking', { text: 'apple', definition_cn: '苹果；英文 apple' }),
    word('huge', { definition_cn: '词'.repeat(241) }),
  ];
  const result = select(pool);
  assert.deepEqual(result.deck.map(item => item.answer), ['valid']);
  assert.equal(result.summary.excludedCount, 11);
  assert.equal(result.summary.duplicateCount, 0);
});

test('chosen word sense and real Chinese meaning survive while English clue answers are masked', () => {
  const source = word('bank', {
    definition_cn: '银行', definition_en: 'A bank that stores money.', selected_meaning_key: 'river',
    meaning_options: [{ key: 'river', meaningZh: '  河岸\n ', definitionEn: 'The bank of a river.' }],
  });
  assert.deepEqual(toSurfReviewWord(source), { wordId: 'bank', answer: 'bank', meaningZh: '河岸', meaningEn: 'The ____ of a river.', audioUrl: null });
  assert.equal(toSurfReviewWord(word('sun', { definition_en: '太阳 is bright' }))?.meaningEn, '');
  assert.equal(toSurfReviewWord(word('sun', { definition_en: null }))?.meaningEn, '');
});

test('account pronunciation URLs travel with the selected word for the audio safety gate', () => {
  const audioUrl = 'https://example.supabase.co/storage/v1/object/public/audio/river.m4a';
  assert.equal(select([word('river', { audio_url: audioUrl })]).deck[0].audioUrl, audioUrl);
});

test('supported typographic spellings normalize to the same game answer', () => {
  assert.equal(toSurfReviewWord(word('one', { text: ' ＤＯＮ’Ｔ ' }))?.answer, "don't");
  assert.equal(toSurfReviewWord(word('two', { text: 'well‑being' }))?.answer, 'well-being');
  assert.equal(toSurfReviewWord(word('three', { text: '-leading' })), null);
});

test('fixed round sizes are floored and never refill by repeating words; Endless includes the whole library', () => {
  const pool = Array.from({ length: 120 }, (_, index) => word(`id-${index}`, { text: `word${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}` }));
  assert.equal(select(pool).deck.length, 20);
  assert.equal(select(pool, 50).deck.length, 50);
  assert.equal(select(pool, 1000).deck.length, 120);
  assert.equal(select(pool, Infinity).deck.length, 120);
  assert.equal(new Set(select(pool, Infinity).deck.map(word => word.wordId)).size, 120);
  assert.equal(select(pool, 1.9).deck.length, 1);
  for (const limit of [0, -1, NaN, -Infinity]) assert.equal(select(pool, limit).deck.length, 0);
  assert.equal(select([word('only')]).deck.length, 1);
});

test('an entire-library pass keeps all late words after the former100-word boundary and deduplicates variants', () => {
  const pool = Array.from({ length: 1300 }, (_, index) => word(`id-${index}`, {
    text: `word${String.fromCharCode(97 + Math.floor(index / 676))}${String.fromCharCode(97 + Math.floor(index / 26) % 26)}${String.fromCharCode(97 + index % 26)}`,
  }));
  pool.push(word('urgent-copy', { text: pool[1250].text.toUpperCase(), review_state: review({ phase: 'relearning' }) }));
  const result = select(pool, Infinity);
  assert.equal(result.deck.length, 1300);
  assert.equal(result.deck[0].wordId, 'urgent-copy');
  assert.equal(result.summary.duplicateCount, 1);
  assert.equal(result.summary.remainingDueCount, 0);
  assert.equal(new Set(result.deck.map(word => word.answer)).size, 1300);
});

test('selection is deterministic across permutations and does not mutate account records', () => {
  const pool = [word('zebra'), word('apple'), word('pear')];
  const before = structuredClone(pool);
  const forward = select(pool);
  assert.deepEqual(select([...pool].reverse()), forward);
  assert.deepEqual(pool, before);
  assert.ok(Object.isFrozen(forward.deck) && Object.isFrozen(forward.deck[0]));
});
