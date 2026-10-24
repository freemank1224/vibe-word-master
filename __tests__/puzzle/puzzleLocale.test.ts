import test from 'node:test';
import assert from 'node:assert/strict';
import type { WordEntry } from '../../types.ts';
import { getPuzzleDefinition } from '../../utils/puzzleLocale.ts';

const word = {
  definition_cn: '河岸',
  definition_en: 'The land beside a river.',
} as WordEntry;

test('puzzle clues use the selected interface language', () => {
  assert.equal(getPuzzleDefinition(word, 'en'), 'The land beside a river.');
  assert.equal(getPuzzleDefinition(word, 'zh'), '河岸');
});

test('an explicitly selected meaning supplies the English clue', () => {
  assert.equal(getPuzzleDefinition({
    ...word,
    selected_meaning_key: 'finance',
    meaning_options: [{ key: 'finance', meaningZh: '银行', definitionEn: 'A business that keeps money.' }],
  }, 'en'), 'A business that keeps money.');
});

test('missing or mixed English definitions never fall back to Chinese', () => {
  for (const definition_en of [null, '', '河岸', 'The river bank（河岸）']) {
    assert.equal(getPuzzleDefinition({ ...word, definition_en }, 'en'), '');
  }
});

test('a missing selected translation never substitutes a different word sense', () => {
  assert.equal(getPuzzleDefinition({
    ...word,
    selected_meaning_key: 'river',
    meaning_options: [{ key: 'river', meaningZh: '河岸', definitionEn: '河流边缘' }],
  }, 'en'), '');
});

test('missing Chinese definition leaves the localized image fallback to the UI', () => {
  assert.equal(getPuzzleDefinition({ ...word, definition_cn: null }, 'zh'), '');
});
