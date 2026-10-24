import test from 'node:test';
import assert from 'node:assert/strict';
import { appendSurfAttempt, hasUnconfirmedSurfReceipt, readSurfRide, replaySurfLearning, SurfJournalError, writeSurfRide, type SavedRide } from '../../features/monster-surf/sessionJournal.ts';
import { currentSurfWord, setSurfInput, startSurf, submitSurf, tickSurf } from '../../features/monster-surf/game.ts';
import { acknowledgeLearningReplay, readLearningJournal, type LearningStorage } from '../../services/learningRecordStore.ts';
import { DAY_MS, type ReviewState } from '../../services/reviewScheduler.ts';
import type { WordEntry } from '../../types.ts';

const USER = 'account-a';
const NOW = Date.UTC(2026, 9, 24, 18);
const source = (overrides: Partial<WordEntry> = {}): WordEntry => ({
  id: 'word-apple', text: 'apple', timestamp: NOW - DAY_MS, sessionId: 'session', correct: true,
  tested: false, error_count: 0, best_time_ms: null, last_tested: null,
  phonetic: null, audio_url: null, definition_cn: '苹果', definition_en: 'A fruit.', ...overrides,
});
const state = () => startSurf(1, [{ wordId: 'word-apple', answer: 'apple', meaningZh: '苹果', meaningEn: 'A fruit.' }]);
const ride = (): SavedRide => ({ version: 1, runId: 'round-one', attempts: [], snapshot: state(), receiptConfirmed: false });
function memory() {
  const values = new Map<string, string>();
  let failLearning = false;
  const storage: LearningStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      if (failLearning && key.startsWith('vibe_learning_v1:')) throw new Error('Quota exceeded');
      values.set(key, value);
    },
  };
  return { storage, values, failLearning: (fail: boolean) => { failLearning = fail; } };
}

test('a crash between the ride write and learning write preserves one replayable answer', () => {
  const store = memory();
  const before = setSurfInput(state(), 'apple');
  const after = submitSurf(before);
  const saved = appendSurfAttempt(ride(), before, after, NOW, 'surf:round-one:event-one');
  writeSurfRide(USER, saved, store.storage);
  store.failLearning(true);
  assert.throws(() => replaySurfLearning(USER, saved, [source()], store.storage), /Quota/);
  const recovered = readSurfRide(USER, store.storage)!;
  assert.equal(recovered.snapshot?.correct, 1);
  assert.equal(recovered.attempts.length, 1);
  store.failLearning(false);
  const first = replaySurfLearning(USER, recovered, [source()], store.storage);
  const second = replaySurfLearning(USER, recovered, first.words, store.storage);
  const journal = readLearningJournal(USER, store.storage);
  assert.equal(Object.keys(journal.events).length, 1);
  assert.equal(journal.events['surf:round-one:event-one'].event.occurred_at, NOW);
  assert.equal(journal.events['surf:round-one:event-one'].event.outcome, 'independent');
  assert.deepEqual(second.words, first.words);
});

test('a failed WAL write leaves no phantom learning event or consumed answer', () => {
  const store = memory();
  const before = setSurfInput(state(), 'apple');
  const saved = appendSurfAttempt(ride(), before, submitSurf(before), NOW, 'surf:round-one:event-one');
  const failing: LearningStorage = { getItem: store.storage.getItem, setItem() { throw new Error('Quota exceeded'); } };
  assert.throws(() => writeSurfRide(USER, saved, failing), SurfJournalError);
  assert.equal(readSurfRide(USER, store.storage), null);
  assert.equal(Object.keys(readLearningJournal(USER, store.storage).events).length, 0);
  assert.equal(before.correct, 0);
});

test('wrong then corrected answers retain fixed assisted history through repeated replay', () => {
  const store = memory();
  const initial = ride();
  const wrongBefore = setSurfInput(state(), 'applx');
  const wrongAfter = submitSurf(wrongBefore);
  const failed = appendSurfAttempt(initial, wrongBefore, wrongAfter, NOW, 'surf:round-one:miss');
  const correctionBefore = setSurfInput(tickSurf(wrongAfter, 650), 'apple');
  const corrected = appendSurfAttempt(failed, correctionBefore, submitSurf(correctionBefore), NOW + 1000, 'surf:round-one:correction');
  writeSurfRide(USER, corrected, store.storage);
  const first = replaySurfLearning(USER, corrected, [source()], store.storage);
  const second = replaySurfLearning(USER, corrected, first.words, store.storage);
  const journal = readLearningJournal(USER, store.storage);
  assert.equal(Object.keys(journal.events).length, 2);
  assert.equal(journal.events['surf:round-one:miss'].event.outcome, 'incorrect');
  assert.equal(journal.events['surf:round-one:correction'].event.outcome, 'assisted');
  assert.equal(first.words[0].review_state?.phase, 'relearning');
  assert.equal(first.words[0].tested, true);
  assert.equal(first.words[0].correct, true);
  assert.equal(first.words[0].score, 1.5);
  assert.equal(first.words[0].error_count, 1);
  assert.equal(first.words[0].consecutive_correct, 0);
  assert.equal(first.words[0].last_tested, NOW + 1000);
  assert.equal(first.words[0].best_time_ms, null);
  assert.ok(first.words[0].review_state!.dueAt <= NOW + 1000 + 10 * 60_000);
  assert.deepEqual(second.words, first.words);
});

test('a clean surf answer updates the shared learning fields and its immutable best time', () => {
  const store = memory();
  const before = setSurfInput({ ...state(), wordElapsedMs: 2437.4 }, 'apple');
  const saved = appendSurfAttempt(ride(), before, submitSurf(before), NOW, 'surf:round-one:clean');
  writeSurfRide(USER, saved, store.storage);
  const recovered = readSurfRide(USER, store.storage)!;
  assert.equal(recovered.attempts[0].learning?.durationMs, 2437);
  const [updated] = replaySurfLearning(USER, recovered, [source()], store.storage).words;
  assert.equal(updated.tested, true);
  assert.equal(updated.correct, true);
  assert.equal(updated.score, 3);
  assert.equal(updated.error_count, 0);
  assert.equal(updated.consecutive_correct, 1);
  assert.equal(updated.last_tested, NOW);
  assert.equal(updated.best_time_ms, 2437);
  assert.equal(updated.review_state?.phase, 'learning');
  assert.equal(updated.review_state?.dueAt, NOW + 10 * 60_000);
  assert.equal(updated.review_state?.lastOutcome, 'independent');
  const journal = readLearningJournal(USER, store.storage);
  const event = journal.events['surf:round-one:clean'].event;
  assert.equal(event.duration_ms, 2437);
  // A server acknowledgement and a refreshed result screen must retain the same event.
  acknowledgeLearningReplay(USER, { word_id: updated.id, revision: 1,
    base: journal.bases[updated.id], events: [event] }, store.storage);
  const receipt = { ...recovered, receiptConfirmed: true, snapshot: { ...submitSurf(before), phase: 'over' as const } };
  assert.deepEqual(replaySurfLearning(USER, receipt, [{ ...updated, learning_revision: 1 }], store.storage).words,
    [{ ...updated, learning_revision: 1 }]);
  assert.equal(Object.keys(readLearningJournal(USER, store.storage).events).length, 1);
  assert.equal(readLearningJournal(USER, store.storage).events[event.event_id].pending, false);
});

test('two actual wrong submissions increment errors twice; a correction does not erase them or set a best time', () => {
  const store = memory();
  const initial = source({ error_count: 3, consecutive_correct: 2, best_time_ms: 4500 });
  const firstBefore = setSurfInput({ ...state(), wordElapsedMs: 1100 }, 'applx');
  const firstAfter = submitSurf(firstBefore);
  let saved = appendSurfAttempt(ride(), firstBefore, firstAfter, NOW, 'surf:round-one:wrong-1');
  const [first] = replaySurfLearning(USER, saved, [initial], store.storage).words;
  assert.equal(first.tested, true);
  assert.equal(first.correct, false);
  assert.equal(first.error_count, 4);
  assert.equal(first.consecutive_correct, 0);
  assert.equal(first.score, 0);
  assert.equal(first.last_tested, NOW);
  assert.equal(first.best_time_ms, 4500);
  assert.equal(first.review_state?.dueAt, NOW + 5 * 60_000);
  const secondBefore = setSurfInput({ ...tickSurf(firstAfter, 650), wordElapsedMs: 2200 }, 'appll');
  const secondAfter = submitSurf(secondBefore);
  saved = appendSurfAttempt(saved, secondBefore, secondAfter, NOW + 1500, 'surf:round-one:wrong-2');
  const [second] = replaySurfLearning(USER, saved, [first], store.storage).words;
  assert.equal(second.error_count, 5);
  assert.equal(second.correct, false);
  const correctionBefore = setSurfInput({ ...tickSurf(secondAfter, 650), wordElapsedMs: 3100 }, 'apple');
  saved = appendSurfAttempt(saved, correctionBefore, submitSurf(correctionBefore), NOW + 3000, 'surf:round-one:fixed');
  const [corrected] = replaySurfLearning(USER, saved, [second], store.storage).words;
  assert.equal(corrected.error_count, 5);
  assert.equal(corrected.correct, true);
  assert.equal(corrected.tested, true);
  assert.equal(corrected.consecutive_correct, 0);
  assert.equal(corrected.score, 1.5);
  assert.equal(corrected.last_tested, NOW + 3000);
  assert.equal(corrected.best_time_ms, 4500);
  assert.equal(corrected.review_state?.phase, 'relearning');
  assert.equal(corrected.review_state?.lastOutcome, 'assisted');
  assert.equal(corrected.review_state?.dueAt, NOW + 3000 + 10 * 60_000);
  assert.deepEqual(replaySurfLearning(USER, saved, [corrected], store.storage).words, [corrected]);
  assert.equal(Object.keys(readLearningJournal(USER, store.storage).events).length, 3);
});

test('a due independent surf recall applies the existing three-recall error decay exactly once', () => {
  const store = memory();
  const review: ReviewState = { version: 1, phase: 'review', dueAt: NOW,
    lastReviewedAt: NOW - DAY_MS, lastIndependentReviewAt: NOW - DAY_MS, stabilityDays: 1,
    difficulty: 5, lapses: 2, repetitions: 4, learningStep: 1, lastOutcome: 'independent' };
  const initial = source({ tested: true, error_count: 2, consecutive_correct: 2,
    last_tested: NOW - DAY_MS, best_time_ms: 2000, review_state: review });
  const before = setSurfInput({ ...state(), wordElapsedMs: 3000 }, 'apple');
  const saved = appendSurfAttempt(ride(), before, submitSurf(before), NOW, 'surf:round-one:due');
  const [updated] = replaySurfLearning(USER, saved, [initial], store.storage).words;
  assert.equal(updated.error_count, 1);
  assert.equal(updated.consecutive_correct, 0);
  assert.equal(updated.review_state?.repetitions, 5);
  assert.ok(updated.review_state!.dueAt > NOW + DAY_MS);
  assert.equal(updated.best_time_ms, 2000);
  assert.deepEqual(replaySurfLearning(USER, saved, [updated], store.storage).words, [updated]);
});

test('ending without an answer leaves all learning attributes unchanged, including unseen deck words', () => {
  const store = memory();
  const untouched = source({ id: 'word-banana', text: 'banana', error_count: 4,
    tested: true, consecutive_correct: 2, last_tested: NOW - DAY_MS, best_time_ms: 2000 });
  const originals = [source(), untouched];
  const noAnswers = { ...ride(), snapshot: { ...state(), phase: 'over' as const, hits: 3 } };
  assert.deepEqual(replaySurfLearning(USER, noAnswers, originals, store.storage).words, originals);
  assert.equal(Object.keys(readLearningJournal(USER, store.storage).events).length, 0);
  const before = setSurfInput(state(), 'apple');
  const saved = appendSurfAttempt(ride(), before, submitSurf(before), NOW, 'surf:round-one:only-apple');
  const result = replaySurfLearning(USER, saved, originals, store.storage);
  assert.deepEqual(result.words[1], untouched);
  assert.deepEqual(Object.keys(readLearningJournal(USER, store.storage).words), ['word-apple']);
});

test('old timed-less attempts retain null duration and their original idempotency payload', () => {
  const store = memory();
  const before = setSurfInput({ ...state(), wordElapsedMs: undefined }, 'apple');
  const saved = appendSurfAttempt(ride(), before, submitSurf(before), NOW, 'surf:round-one:old');
  assert.equal(saved.attempts[0].learning?.durationMs, null);
  delete saved.attempts[0].learning!.durationMs;
  writeSurfRide(USER, saved, store.storage);
  const recovered = readSurfRide(USER, store.storage)!;
  const [updated] = replaySurfLearning(USER, recovered, [source({ best_time_ms: 5000 })], store.storage).words;
  assert.equal(updated.best_time_ms, 5000);
  assert.equal(readLearningJournal(USER, store.storage).events['surf:round-one:old'].event.duration_ms, null);
  assert.deepEqual(replaySurfLearning(USER, recovered, [updated], store.storage).words, [updated]);
});

test('an early independent success cannot extend the existing spaced interval', () => {
  const store = memory();
  const review: ReviewState = { version: 1, phase: 'review', dueAt: NOW + DAY_MS,
    lastReviewedAt: NOW - 1000, lastIndependentReviewAt: NOW - 1000, stabilityDays: 2,
    difficulty: 5, lapses: 0, repetitions: 4, learningStep: 1, lastOutcome: 'independent' };
  const before = setSurfInput(state(), 'apple');
  const saved = appendSurfAttempt(ride(), before, submitSurf(before), NOW, 'surf:round-one:early');
  const result = replaySurfLearning(USER, saved, [source({ tested: true, review_state: review })], store.storage);
  assert.deepEqual(result.words[0].review_state, review);
});

test('settlement confirmation is durable and distinct from merely reaching game over', () => {
  const store = memory();
  const saved = { ...ride(), snapshot: { ...state(), phase: 'over' as const } };
  assert.equal(hasUnconfirmedSurfReceipt(saved), true);
  writeSurfRide(USER, saved, store.storage);
  assert.equal(hasUnconfirmedSurfReceipt(readSurfRide(USER, store.storage)), true);
  writeSurfRide(USER, { ...saved, receiptConfirmed: true }, store.storage);
  assert.equal(hasUnconfirmedSurfReceipt(readSurfRide(USER, store.storage)), false);
  assert.equal(readSurfRide('account-b', store.storage), null);
});

test('legacy learning-first attempts survive without inventing new timestamps or events', () => {
  const store = memory();
  const saved = { ...ride(), attempts: [{ wordId: currentSurfWord(state()).wordId!, answer: 'apple' }] };
  delete (saved as Partial<SavedRide>).receiptConfirmed;
  store.values.set(`vocab_monster_surf_v1:${USER}`, JSON.stringify(saved));
  const restored = readSurfRide(USER, store.storage)!;
  assert.equal(restored.receiptConfirmed, false);
  replaySurfLearning(USER, restored, [source()], store.storage);
  assert.equal(Object.keys(readLearningJournal(USER, store.storage).events).length, 0);
});

test('malformed local data reports storage failure instead of entering a paid round', () => {
  const store = memory();
  for (const invalid of ['null', '{}', '{', JSON.stringify({ ...ride(), attempts: [{ wordId: 'x', answer: 'x', learning: { eventId: 'e', occurredAt: -1 } }] })]) {
    store.values.set(`vocab_monster_surf_v1:${USER}`, invalid);
    assert.throws(() => readSurfRide(USER, store.storage), SurfJournalError);
  }
  const before = setSurfInput(state(), 'apple');
  const saved = appendSurfAttempt(ride(), before, submitSurf(before), NOW, 'surf:round-one:invalid-duration');
  for (const durationMs of [-1, 3_600_001, 'bad']) {
    store.values.set(`vocab_monster_surf_v1:${USER}`, JSON.stringify({ ...saved,
      attempts: [{ ...saved.attempts[0], learning: { ...saved.attempts[0].learning, durationMs } }] }));
    assert.throws(() => readSurfRide(USER, store.storage), SurfJournalError);
  }
});
