import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordLearningRound, readLearningJournal, overlayLearningProgress, markLearningWordSynced, persistLearningPatch } from '../../services/learningRecordStore.ts';
import type { LearningResult } from '../../services/learningRecordStore.ts';
import type { WordEntry } from '../../types.ts';

const now = Date.UTC(2026, 9, 22, 12);
const word = (id = 'a'): WordEntry => ({ id, text: id === 'a' ? 'apple' : 'bridge', timestamp: now - 86400000, sessionId: 's', correct: false, tested: false, error_count: 0, best_time_ms: null, last_tested: null, phonetic: null, audio_url: null, definition_cn: '词义', definition_en: null });
const result = (status: LearningResult['status'], extra: Partial<LearningResult> = {}): LearningResult => ({ wordId: 'a', status, hintUsed: false, hadMistake: false, ...extra });
const memory = () => { const map = new Map<string, string>(); return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } }; };

test('a retry of the same round does not increment mistakes twice', () => {
  const storage = memory();
  const once = recordLearningRound('user-a', 'round-a', now, [result('incorrect')], [word()], storage);
  const twice = recordLearningRound('user-a', 'round-a', now + 100, [result('incorrect')], once, storage);
  assert.equal(twice[0].error_count, 1);
  assert.equal(twice[0].review_state?.lapses, once[0].review_state?.lapses);
  assert.equal(twice[0].last_tested, now);
});

test('skipped and unattempted words receive no false learning record', () => {
  const storage = memory();
  const updated = recordLearningRound('u', 'r', now, [result('skipped'), result('unattempted', { wordId: 'b' })], [word(), word('b')], storage);
  assert.deepEqual(updated, [word(), word('b')]);
  assert.equal(Object.keys(readLearningJournal('u', storage).words).length, 0);
});

test('corrected and hinted answers are assisted and cannot become independent mastery', () => {
  for (const extra of [{ hintUsed: true }, { hadMistake: true }]) {
    const updated = recordLearningRound('u', 'r', now, [result('correct', extra)], [word()], memory());
    assert.equal(updated[0].review_state?.lastOutcome, 'assisted');
    assert.equal(updated[0].consecutive_correct, 0);
  }
});

test('pending local answers remain visible until merged and accounts stay isolated', () => {
  const storage = memory();
  recordLearningRound('user-a', 'r', now, [result('incorrect')], [word()], storage);
  assert.equal(overlayLearningProgress('user-b', [word()], storage)[0].tested, false);
  const remote = { ...word(), last_tested: now + 5000, correct: true, error_count: 0 };
  assert.equal(overlayLearningProgress('user-a', [remote], storage)[0].error_count, 1);
  markLearningWordSynced('user-a', 'a', 'r:a', storage);
  assert.deepEqual(overlayLearningProgress('user-a', [remote], storage)[0], remote);
});

test('upload acknowledgement cannot remove a newer pending attempt', () => {
  const storage = memory();
  recordLearningRound('u', 'old', now, [result('incorrect')], [word()], storage);
  recordLearningRound('u', 'new', now + 2000, [result('correct')], [word()], storage);
  markLearningWordSynced('u', 'a', 'old:a', storage);
  assert.equal(readLearningJournal('u', storage).words.a.pending, true);
  markLearningWordSynced('u', 'a', 'new:a', storage);
  assert.equal(readLearningJournal('u', storage).words.a.pending, false);
});

test('corrupt storage and quota errors surface without replacing the journal', () => {
  const storage = memory(); storage.setItem('vibe_learning_v1:u', 'corrupt');
  assert.throws(() => recordLearningRound('u', 'r', now, [result('incorrect')], [word()], storage));
  assert.equal(storage.getItem('vibe_learning_v1:u'), 'corrupt');
  const full = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  assert.throws(() => recordLearningRound('u', 'r', now, [result('incorrect')], [word()], full), /quota/);
});

test('classic patch survives reload with its original practice time', () => {
  const storage = memory();
  const updated = recordLearningRound('u', 'r', now, [result('correct')], [word()], memory())[0];
  persistLearningPatch('u', 'a', updated, 'classic:a', storage);
  assert.equal(overlayLearningProgress('u', [word()], storage)[0].review_state?.dueAt, updated.review_state?.dueAt);
  assert.equal(overlayLearningProgress('u', [word()], storage)[0].last_tested, now);
});

test('rapid repeat rounds cannot decay the legacy error counter without spaced recall', () => {
  const storage = memory();
  let words = [{ ...word(), error_count: 3 }];
  for (let index = 0; index < 3; index++) {
    words = recordLearningRound('u', `r-${index}`, now + index * 1000, [result('correct')], words, storage);
  }
  assert.equal(words[0].error_count, 3);
  assert.equal(words[0].consecutive_correct, 1);
  assert.equal(words[0].review_state?.repetitions, 1);
});
