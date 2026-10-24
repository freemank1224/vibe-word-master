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

test('definition language follows the selected sense without resetting learning data', () => {
  const entry = word({ selected_meaning_key: 'river', meaning_options: [
    { key: 'money', meaningZh: '银行', definitionEn: 'A financial institution' },
    { key: 'river', meaningZh: '河岸', definitionEn: 'The side of a river' },
  ] });
  assert.equal(wordMeaningForLanguage(entry, false), 'The side of a river');
  assert.equal(wordMeaningForLanguage(entry, true), '河岸');
  assert.equal(entry.selected_meaning_key, 'river');
});

test('missing or mislabeled English definitions use a useful English audio cue', () => {
  for (const definition_en of [null, '', '银行']) {
    const cue = wordMeaningForLanguage(word({ definition_en }), false);
    assert.match(cue, /pronunciation/);
    assert.doesNotMatch(cue, /\p{Script=Han}/u);
  }
});

test('an untranslated selected sense does not fall back to a different default sense', () => {
  const entry = word({ selected_meaning_key: 'river', meaning_options: [
    { key: 'river', meaningZh: '河岸', definitionEn: null },
  ] });
  assert.match(wordMeaningForLanguage(entry, false), /pronunciation/);
  assert.equal(wordMeaningForLanguage(entry, true), '河岸');
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
