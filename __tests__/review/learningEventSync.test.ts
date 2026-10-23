import { test } from 'node:test';
import assert from 'node:assert/strict';
import { persistLearningAttempt, readLearningJournal, overlayLearningProgress } from '../../services/learningRecordStore.ts';
import { syncLearningEvents } from '../../services/learningEventSync.ts';
import type { LearningSyncTransport } from '../../services/learningEventSync.ts';
import { emptyLearningPatch, normalizeLearningEvent, projectLearningEvents, sameLearningEvent } from '../../services/learningReplay.ts';
import type { LearningEvent, LearningPatch } from '../../services/learningReplay.ts';
import type { WordEntry } from '../../types.ts';

const now = Date.UTC(2026, 9, 22, 12);
const word = (id = 'a'): WordEntry => ({ id, text: 'apple', timestamp: now - 86400000, sessionId: 's', ...emptyLearningPatch(), phonetic: null, audio_url: null, definition_cn: '苹果', definition_en: null });
const memory = () => { const map = new Map<string, string>(); return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } }; };
const attempt = (storage: ReturnType<typeof memory>, id: string, at = now, status: 'correct' | 'incorrect' = 'incorrect', user = 'u', wordId = 'a') =>
  persistLearningAttempt(user, word(wordId), { wordId, status, hintUsed: false, hadMistake: false }, id, at, storage);
const pending = (storage: ReturnType<typeof memory>, user = 'u') => Object.values(readLearningJournal(user, storage).events).filter(value => value.pending);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function server() {
  const states = new Map<string, { base: LearningPatch; revision: number; events: LearningEvent[]; patch: LearningPatch }>();
  let user = 'u';
  let appendCalls = 0;
  const state = (id: string) => {
    if (!states.has(id)) states.set(id, { base: emptyLearningPatch(), revision: 0, events: [], patch: emptyLearningPatch() });
    return states.get(id)!;
  };
  const replay = (ids: string[]) => ({ words: ids.map(word_id => ({ word_id, base: state(word_id).base, events: state(word_id).events, revision: state(word_id).revision })) });
  const transport: LearningSyncTransport = {
    getUserId: async () => user,
    append: async events => {
      appendCalls++;
      for (const event of events) {
        const row = state(event.word_id);
        const duplicate = row.events.find(item => item.event_id === event.event_id);
        if (duplicate && !sameLearningEvent(duplicate, event)) throw new Error('event id conflict');
        if (!duplicate) { row.events.push(clone(event)); row.revision++; }
      }
      return clone(replay([...new Set(events.map(event => event.word_id))]));
    },
    getReplay: async ids => clone(replay(ids)),
    commit: async (id, revision, patch) => {
      const row = state(id);
      if (row.revision !== revision) return { word_id: id, committed: false, revision: row.revision };
      row.patch = clone(patch);
      return { word_id: id, committed: true, revision };
    },
  };
  return { transport, state, setUser: (id: string) => { user = id; }, appendCalls: () => appendCalls };
}

test('all offline answers survive reload and are replayed once, not just the final snapshot', async () => {
  const storage = memory();
  attempt(storage, 'one', now);
  attempt(storage, 'two', now + 1000);
  attempt(storage, 'three', now + 2000, 'correct');
  assert.equal(pending(storage).length, 3);
  const remote = server();
  const result = await syncLearningEvents('u', remote.transport, storage);
  assert.equal(result.synced, 3);
  assert.equal(result.pending, 0);
  assert.equal(remote.state('a').events.length, 3);
  assert.equal(remote.state('a').patch.error_count, 2);
  assert.equal(remote.state('a').patch.last_tested, now + 2000);
  assert.equal(result.projections.a.learning_revision, 3);
});

test('append success with a lost response retries the exact id without duplicating an error', async () => {
  const storage = memory(); attempt(storage, 'same-id');
  const remote = server(); const append = remote.transport.append; let lost = true;
  remote.transport.append = async events => { const result = await append(events); if (lost) { lost = false; throw new Error('response lost'); } return result; };
  await assert.rejects(syncLearningEvents('u', remote.transport, storage), /response lost/);
  assert.equal(pending(storage).length, 1);
  await syncLearningEvents('u', remote.transport, storage);
  assert.equal(remote.state('a').events.length, 1);
  assert.equal(remote.state('a').patch.error_count, 1);
  assert.equal(pending(storage).length, 0);
});

test('commit success with a lost response remains pending and safely retries', async () => {
  const storage = memory(); attempt(storage, 'same-id');
  const remote = server(); const commit = remote.transport.commit; let lost = true;
  remote.transport.commit = async (...args) => { const result = await commit(...args); if (lost) { lost = false; throw new Error('commit response lost'); } return result; };
  await assert.rejects(syncLearningEvents('u', remote.transport, storage), /response lost/);
  assert.equal(remote.state('a').patch.error_count, 1);
  assert.equal(pending(storage).length, 1);
  await syncLearningEvents('u', remote.transport, storage);
  assert.equal(remote.state('a').patch.error_count, 1);
  assert.equal(pending(storage).length, 0);
});

test('two devices racing on one word rebase through CAS without losing either mistake', async () => {
  const first = memory(); const second = memory(); const remote = server();
  attempt(first, 'device-a', now + 1000); attempt(second, 'device-b', now);
  const commit = remote.transport.commit; let interleaved = false;
  remote.transport.commit = async (...args) => {
    if (!interleaved) { interleaved = true; await syncLearningEvents('u', remote.transport, second); }
    return commit(...args);
  };
  await syncLearningEvents('u', remote.transport, first);
  assert.equal(remote.state('a').patch.error_count, 2);
  assert.equal(remote.state('a').revision, 2);
  assert.equal(pending(first).length + pending(second).length, 0);
  assert.equal(readLearningJournal('u', first).words.a.patch.error_count, 2);
});

test('a late offline error is replayed before the newer answer, not discarded by last_tested', async () => {
  const early = memory(); const late = memory(); const remote = server();
  attempt(early, 'old-offline-error', now);
  attempt(late, 'new-online-correct', now + 900_000, 'correct');
  await syncLearningEvents('u', remote.transport, late);
  await syncLearningEvents('u', remote.transport, early);
  assert.equal(remote.state('a').patch.error_count, 1);
  assert.equal(remote.state('a').patch.correct, true);
  assert.equal(remote.state('a').patch.last_tested, now + 900_000);
  const all = remote.state('a').events;
  assert.deepEqual(remote.state('a').patch, projectLearningEvents(emptyLearningPatch(), [...all].reverse()));
});

test('a new local answer while upload is in flight is not acknowledged accidentally', async () => {
  const storage = memory(); attempt(storage, 'first'); const remote = server();
  const commit = remote.transport.commit;
  remote.transport.commit = async (...args) => { attempt(storage, 'during-upload', now + 1000); return commit(...args); };
  const result = await syncLearningEvents('u', remote.transport, storage);
  assert.equal(result.synced, 1); assert.equal(result.pending, 1);
  assert.equal(pending(storage)[0].event.event_id, 'during-upload');
  assert.equal(readLearningJournal('u', storage).words.a.patch.error_count, 2);
});

test('an empty append or commit response never acknowledges local events', async () => {
  for (const mode of ['append', 'commit'] as const) {
    for (const response of [null, {}, [], { words: [] }]) {
      const storage = memory(); attempt(storage, 'first'); const remote = server();
      remote.transport[mode] = async () => response;
      await assert.rejects(syncLearningEvents('u', remote.transport, storage));
      assert.equal(pending(storage).length, 1);
    }
  }
});

test('account changes before upload or before acknowledgement retain the original account queue', async () => {
  const storage = memory(); attempt(storage, 'first'); const remote = server();
  remote.setUser('another');
  await assert.rejects(syncLearningEvents('u', remote.transport, storage), /账号/);
  assert.equal(remote.appendCalls(), 0);
  remote.setUser('u'); const commit = remote.transport.commit;
  remote.transport.commit = async (...args) => { const result = await commit(...args); remote.setUser('another'); return result; };
  await assert.rejects(syncLearningEvents('u', remote.transport, storage), /账号/);
  assert.equal(pending(storage).length, 1);
  assert.equal(pending(storage, 'another').length, 0);
});

test('repeated CAS conflicts are bounded and retain pending data for the next retry', async () => {
  const storage = memory(); attempt(storage, 'first'); const remote = server(); let calls = 0;
  remote.transport.commit = async (word_id, revision) => { calls++; return { word_id, committed: false, revision }; };
  const result = await syncLearningEvents('u', remote.transport, storage);
  assert.equal(calls, 3); assert.equal(result.synced, 0); assert.equal(result.pending, 1);
});

test('old v1 snapshots migrate explicitly, preserving their time and without invented answers', async () => {
  const storage = memory(); const patch = { ...emptyLearningPatch(), tested: true, correct: false, error_count: 7, last_tested: now };
  const legacy = JSON.stringify({ version: 1, words: { a: { patch, eventId: 'legacy:a', pending: true } }, rounds: { old: now } });
  storage.setItem('vibe_learning_v1:u', legacy);
  const migrated = readLearningJournal('u', storage);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.events['legacy:a'].event.kind, 'legacy_snapshot');
  assert.equal(storage.getItem('vibe_learning_v1:u'), legacy, 'a read must not rewrite stored data');
  const remote = server(); await syncLearningEvents('u', remote.transport, storage);
  assert.equal(remote.state('a').patch.error_count, 7);
  assert.equal(remote.state('a').patch.last_tested, now);
  assert.equal(pending(storage).length, 0);
});

test('missing RPC/schema or network errors retain every pending event indefinitely', async () => {
  const storage = memory(); attempt(storage, 'first'); const remote = server();
  remote.transport.append = async () => { throw new Error('function does not exist'); };
  for (let retry = 0; retry < 5; retry++) await assert.rejects(syncLearningEvents('u', remote.transport, storage), /does not exist/);
  assert.equal(pending(storage).length, 1);
  assert.equal(pending(storage)[0].event.occurred_at, now);
});

test('equal-time events have deterministic order independent of network delivery', () => {
  const a = normalizeLearningEvent({ event_id: 'a', word_id: 'a', occurred_at: now, kind: 'answer', outcome: 'incorrect', duration_ms: null });
  const b = normalizeLearningEvent({ event_id: 'b', word_id: 'a', occurred_at: now, kind: 'answer', outcome: 'independent', duration_ms: 800 });
  assert.deepEqual(projectLearningEvents(emptyLearningPatch(), [a, b]), projectLearningEvents(emptyLearningPatch(), [b, a]));
  assert.equal(projectLearningEvents(emptyLearningPatch(), [a, b, a]).error_count, 1);
});

test('same event id with a different answer is rejected instead of silently replacing history', () => {
  const storage = memory(); attempt(storage, 'collision');
  assert.throws(() => attempt(storage, 'collision', now, 'correct'), /不同内容/);
  assert.equal(pending(storage)[0].event.outcome, 'incorrect');
});

test('classic fractional hint penalties and score survive event replay', async () => {
  const storage = memory(); const remote = server();
  persistLearningAttempt('u', word(), { wordId: 'a', status: 'correct', hintUsed: true, hadMistake: true, score: 2.4, errorDelta: 0.25 }, 'classic', now, storage);
  await syncLearningEvents('u', remote.transport, storage);
  assert.equal(remote.state('a').patch.score, 2.4);
  assert.equal(remote.state('a').patch.error_count, 0.25);
  assert.equal(remote.state('a').patch.review_state?.lastOutcome, 'assisted');
});

test('newer acknowledged cloud revisions win even when their last answer timestamp is equal', async () => {
  const storage = memory(); attempt(storage, 'first'); const remote = server();
  await syncLearningEvents('u', remote.transport, storage);
  const cloud = { ...word(), ...remote.state('a').patch, error_count: 2, learning_revision: 2 };
  assert.deepEqual(overlayLearningProgress('u', [cloud], storage)[0], cloud);
});

test('a large offline queue is split within the RPC word and event limits', async () => {
  const storage = memory(); const remote = server();
  for (let index = 0; index < 205; index++) attempt(storage, `event-${index}`, now + index, 'incorrect', 'u', `word-${index}`);
  const append = remote.transport.append; const sizes: number[] = [];
  remote.transport.append = async events => { assert.ok(events.length <= 200); assert.ok(new Set(events.map(event => event.word_id)).size <= 100); sizes.push(events.length); return append(events); };
  const result = await syncLearningEvents('u', remote.transport, storage);
  assert.deepEqual(sizes, [100, 100, 5]);
  assert.equal(result.synced, 205); assert.equal(result.pending, 0);
});

test('a second device repairs uploaded events after the originating device closes before commit', async () => {
  const origin = memory(); const replacement = memory(); const remote = server();
  attempt(origin, 'lost-device-error');
  await remote.transport.append(pending(origin).map(item => item.event));
  assert.equal(remote.state('a').patch.tested, false);
  remote.transport.getUnprojected = () => remote.transport.getReplay(['a']);
  const result = await syncLearningEvents('u', remote.transport, replacement);
  assert.equal(remote.state('a').patch.error_count, 1);
  assert.equal(result.pending, 0);
  assert.equal(result.projections.a.learning_revision, 1);
  assert.equal(readLearningJournal('u', replacement).events['lost-device-error'].pending, false);
  // The old device can return and redeliver its outstanding event without incrementing it.
  await syncLearningEvents('u', remote.transport, origin);
  assert.equal(remote.state('a').patch.error_count, 1);
});

test('empty recovery response is an error, while an explicit empty words list is valid', async () => {
  const remote = server(); const storage = memory();
  remote.transport.getUnprojected = async () => null;
  await assert.rejects(syncLearningEvents('u', remote.transport, storage));
  remote.transport.getUnprojected = async () => ({ words: [] });
  assert.deepEqual(await syncLearningEvents('u', remote.transport, storage), { synced: 0, pending: 0, projections: {} });
});

test('a remotely deleted word remains pending without blocking other words in its batch', async () => {
  const storage = memory(); const remote = server();
  attempt(storage, 'deleted-word', now, 'incorrect', 'u', 'a');
  attempt(storage, 'live-word', now, 'incorrect', 'u', 'b');
  const append = remote.transport.append;
  remote.transport.append = async events => {
    if (events.some(event => event.word_id === 'a')) throw Object.assign(new Error('Word unavailable'), { code: '42501' });
    return append(events);
  };
  const result = await syncLearningEvents('u', remote.transport, storage);
  assert.deepEqual(result.unavailableWordIds, ['a']);
  assert.equal(result.synced, 1); assert.equal(result.pending, 1);
  assert.equal(remote.state('b').patch.error_count, 1);
  assert.equal(pending(storage)[0].event.event_id, 'deleted-word');
});

test('an answer after fetching a newer device projection preserves that progress immediately', async () => {
  const storage = memory(); attempt(storage, 'first'); const remote = server();
  await syncLearningEvents('u', remote.transport, storage);
  const newerCloud = { ...word(), ...remote.state('a').patch, error_count: 5, learning_revision: 5, last_tested: now + 1000 };
  const updated = persistLearningAttempt('u', newerCloud, { wordId: 'a', status: 'incorrect', hintUsed: false, hadMistake: false }, 'after-cloud-fetch', now + 2000, storage);
  assert.equal(updated.error_count, 6, 'the optimistic answer must not revert other-device errors');
  assert.equal(pending(storage).length, 1);
  assert.equal(Object.keys(readLearningJournal('u', storage).events).length, 2, 'old acknowledged IDs stay available for local retry deduplication');
});
