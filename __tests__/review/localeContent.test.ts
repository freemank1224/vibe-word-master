import assert from 'node:assert/strict';
import test from 'node:test';
import { leaderboardCategoryLabel, leaderboardScoreLabel } from '../../utils/leaderboardLocale.ts';
import { wordMeaningForLanguage } from '../../utils/wordMeaningLocale.ts';
import type { WordEntry } from '../../types.ts';

const word = (patch: Partial<WordEntry> = {}): WordEntry => ({
  id: 'bank', text: 'bank', timestamp: 0, sessionId: 'session', correct: false,
  tested: false, error_count: 0, best_time_ms: null, last_tested: null,
  phonetic: null, audio_url: null, definition_cn: '银行', definition_en: 'A financial institution',
  ...patch,
});

test('Chinese meaning follows the selected sense in either interface language', () => {
  const entry = word({ selected_meaning_key: 'river', meaning_options: [
    { key: 'money', meaningZh: '银行', definitionEn: 'A financial institution' },
    { key: 'river', meaningZh: '河岸', definitionEn: 'The side of a river' },
  ] });
  assert.equal(wordMeaningForLanguage(entry, false), '河岸');
  assert.equal(wordMeaningForLanguage(entry, true), '河岸');
  assert.equal(entry.selected_meaning_key, 'river');
});

test('missing or mislabeled English definitions do not hide an existing Chinese meaning', () => {
  for (const definition_en of [null, '', '银行']) {
    const cue = wordMeaningForLanguage(word({ definition_en }), false);
    assert.equal(cue, '银行');
  }
});

test('an untranslated selected sense does not fall back to a different default sense', () => {
  const entry = word({ selected_meaning_key: 'river', meaning_options: [
    { key: 'river', meaningZh: '河岸', definitionEn: null },
  ] });
  assert.equal(wordMeaningForLanguage(entry, false), '河岸');
  assert.equal(wordMeaningForLanguage(entry, true), '河岸');
});

test('missing or placeholder Chinese meanings use a localized instruction', () => {
  for (const definition_cn of [null, '', '暂无中文释义', 'sabertooth', 'A type of large cat']) {
    const entry = word({ definition_cn });
    assert.match(wordMeaningForLanguage(entry, false), /pronunciation/);
    assert.match(wordMeaningForLanguage(entry, true), /发音/);
  }
});

test('an English fallback option cannot hide an existing Chinese meaning', () => {
  const entry = word({ definition_cn: '剑齿虎', selected_meaning_key: 'fallback', meaning_options: [
    { key: 'fallback', meaningZh: 'sabertooth', definitionEn: 'sabertooth', sourceProvider: 'input-fallback' },
  ] });
  assert.equal(wordMeaningForLanguage(entry, false), '剑齿虎');
  assert.equal(wordMeaningForLanguage(entry, true), '剑齿虎');
  assert.match(wordMeaningForLanguage({ ...entry, definition_cn: 'sabertooth' }, false), /pronunciation/);
});

test('all database leaderboard categories render English units independently of server labels', () => {
  for (const category of ['daily_total', 'achievements', 'game_total', 'word_mastery', 'coins'] as const) {
    assert.doesNotMatch(leaderboardCategoryLabel(category, false), /\p{Script=Han}/u);
    assert.doesNotMatch(leaderboardScoreLabel(category, 1234, false), /\p{Script=Han}/u);
    assert.match(leaderboardScoreLabel(category, 1234, true), /\p{Script=Han}/u);
  }
  assert.equal(leaderboardScoreLabel('coins', 1, false), '1 coin');
  assert.equal(leaderboardScoreLabel('daily_total', 1234, false), '1,234 points');
});
