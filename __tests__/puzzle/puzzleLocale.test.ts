import test from 'node:test';
import assert from 'node:assert/strict';
import type { WordEntry } from '../../types.ts';
import { getPuzzleDefinition } from '../../utils/puzzleLocale.ts';

const word = {
  definition_cn: '河岸',
  definition_en: 'The land beside a river.',
} as WordEntry;

test('puzzle clues keep Chinese in both interface languages', () => {
  assert.equal(getPuzzleDefinition(word, 'en'), '河岸');
  assert.equal(getPuzzleDefinition(word, 'zh'), '河岸');
});

test('the selected Chinese meaning takes precedence over another default sense', () => {
  const selected = {
    ...word,
    selected_meaning_key: 'finance',
    meaning_options: [{ key: 'finance', meaningZh: '银行', definitionEn: 'A business that keeps money.' }],
  };
  assert.equal(getPuzzleDefinition(selected, 'en'), '银行');
  assert.equal(getPuzzleDefinition(selected, 'zh'), '银行');
});

test('missing Chinese meaning leaves the localized image fallback to the UI', () => {
  for (const definition_cn of [null, '', '暂无中文释义']) {
    assert.equal(getPuzzleDefinition({ ...word, definition_cn }, 'en'), '');
    assert.equal(getPuzzleDefinition({ ...word, definition_cn }, 'zh'), '');
  }
});
