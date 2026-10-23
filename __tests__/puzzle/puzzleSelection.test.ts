import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WordEntry } from '../../types.ts';
import { getPuzzleCandidateWords, selectPuzzleWords } from '../../services/puzzleGame.ts';

const makeWord = (id: string, reviewed = false): WordEntry => ({
  id, text: id, timestamp: Date.now(), sessionId: 'test', tested: reviewed, correct: reviewed,
  image_url: 'https://example.com/image.png', error_count: 0, best_time_ms: null,
  last_tested: reviewed ? Date.now() : null, phonetic: null, audio_url: null,
  definition_cn: null, definition_en: null,
});

test('nine-card selection budgets new words against nine rather than the full library', () => {
  const fresh = Array.from({ length: 20 }, (_, index) => makeWord(`fresh-${index}`));
  const upcoming = Array.from({ length: 20 }, (_, index) => makeWord(`review-${index}`, true));
  const words = [...fresh, ...upcoming];
  const selection = selectPuzzleWords(words, [], true, 9);
  assert.equal(selection.words.length, 9);
  assert.equal(selection.words.filter((word) => !word.tested).length, 3);
  assert.equal(new Set(selection.words.map((word) => word.id)).size, 9);
});
test('due words displace fresh words in the nine-card practice shortlist', () => {
  const overdue = Array.from({ length: 9 }, (_, index) => ({ ...makeWord(`due-${index}`, true), last_tested: Date.now() - 30 * 86400000 }));
  const fresh = Array.from({ length: 20 }, (_, index) => makeWord(`fresh-${index}`));
  assert.deepEqual(new Set(selectPuzzleWords([...fresh, ...overdue], [], true, 9).words.map((word) => word.id)), new Set(overdue.map((word) => word.id)));
});
test('candidate eligibility shares image resolution and normalized duplicate filtering', () => {
  const original = { ...makeWord('first'), text: 'Bridge' };
  const duplicate = { ...makeWord('second'), text: ' bridge ' };
  const deleted = { ...makeWord('deleted'), deleted: true };
  const noImage = { ...makeWord('missing'), image_url: null };
  const absoluteLegacy = { ...makeWord('legacy'), image_url: null, image_path: 'https://example.com/legacy.png' };
  assert.deepEqual(getPuzzleCandidateWords([original, duplicate, deleted, noImage, absoluteLegacy]).map((word) => word.id), ['first', 'legacy']);
});
test('an earlier upcoming duplicate cannot hide an overdue image-backed word', () => {
  const upcoming = { ...makeWord('upcoming-copy', true), text: 'Bridge' };
  const overdue = { ...makeWord('overdue-copy', true), text: ' bridge ', last_tested: Date.now() - 30 * 86400000 };
  const fresh = Array.from({ length: 12 }, (_, index) => makeWord(`fresh-${index}`));
  const words = [upcoming, ...fresh, overdue];
  const candidates = getPuzzleCandidateWords(words);
  assert.equal(candidates.filter((word) => word.text.trim().toLowerCase() === 'bridge').length, 1);
  assert.ok(candidates.some((word) => word.id === overdue.id));
  const selectedIds = selectPuzzleWords(words, [], true, 9).words.map((word) => word.id);
  assert.ok(selectedIds.includes(overdue.id));
  assert.ok(!selectedIds.includes(upcoming.id));
});
