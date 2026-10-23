import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalBackupStore, indexedBackupKey, localBackupKey, mapCloudWord, newWordRow, wordMetadata } from '../sessionSyncModel.ts';
import type { OwnedLocalBackup } from '../sessionSyncModel.ts';
import { updateReviewState } from '../reviewScheduler.ts';
import type { WordEntry } from '../../types.ts';

const at = Date.UTC(2026, 9, 22, 12);
const word: WordEntry = {
  id: 'word-a', text: 'sun', sessionId: 'session-a', timestamp: at,
  correct: true, tested: true, score: 3, error_count: 2, consecutive_correct: 1,
  best_time_ms: 2100, last_tested: at, review_state: updateReviewState({}, 'independent', at),
  learning_revision: 9, language: 'en', phonetic: '/sʌn/', audio_url: '/sun.wav',
  definition_cn: '太阳', definition_en: 'a star', image_asset_id: 'asset-a',
};
const learningFields = ['correct', 'tested', 'score', 'error_count', 'consecutive_correct', 'best_time_ms', 'last_tested', 'review_state', 'learning_revision'];

test('session metadata updates cannot contain learning state or change ownership', () => {
  const payload = wordMetadata(word);
  for (const field of [...learningFields, 'id', 'user_id', 'session_id']) assert.equal(field in payload, false, field);
  assert.equal(payload.language, 'en');
  assert.equal(payload.image_asset_id, 'asset-a');
  assert.equal(payload.definition_cn, '太阳');
});

test('new word insertion carries owner and content while deferring learning to the journal', () => {
  const payload = newWordRow('owner-a', 'session-a', word);
  assert.equal(payload.id, word.id);
  assert.equal(payload.user_id, 'owner-a');
  assert.equal(payload.session_id, 'session-a');
  for (const field of learningFields) assert.equal(field in payload, false, field);
  assert.throws(() => newWordRow('', 'session-a', word), /登录/);
});

test('download preserves complete learning state and language', () => {
  const downloaded = mapCloudWord({
    ...wordMetadata(word), id: word.id, session_id: word.sessionId, created_at: new Date(at).toISOString(),
    correct: true, tested: true, score: 2.4, error_count: 1.5, consecutive_correct: 2,
    best_time_ms: 1000, last_tested: new Date(at).toISOString(), review_state: word.review_state, learning_revision: 9,
  }, '/shared-sun.png');
  assert.equal(downloaded.learning_revision, 9);
  assert.equal(downloaded.score, 2.4);
  assert.equal(downloaded.error_count, 1.5);
  assert.equal(downloaded.consecutive_correct, 2);
  assert.equal(downloaded.last_tested, at);
  assert.deepEqual(downloaded.review_state, word.review_state);
  assert.equal(downloaded.language, 'en');
  assert.equal(downloaded.image_url, '/shared-sun.png');
  assert.equal(downloaded.image_asset_id, 'asset-a');
});

function fixture(initialUser: string | null = 'owner-a') {
  let currentUser = initialUser;
  const records = new Map<string, unknown>();
  const reads: string[] = [];
  const writes: string[] = [];
  const store = createLocalBackupStore({
    resolveCurrentUser: async () => currentUser,
    read: async id => { reads.push(id); return structuredClone(records.get(localBackupKey(id)) ?? null); },
    write: async (id, backup) => { writes.push(id); records.set(localBackupKey(id), structuredClone(backup)); return true; },
    remove: async id => { records.delete(localBackupKey(id)); },
  });
  return { store, records, reads, writes, setUser: (id: string | null) => { currentUser = id; } };
}
const backup = (ownerId: string): OwnedLocalBackup => ({ ownerId, version: 2, sessions: [], words: [] });

test('localStorage and IndexedDB keys isolate owners and preserve unowned legacy backups', async () => {
  const f = fixture();
  assert.notEqual(localBackupKey('owner-a'), localBackupKey('owner-b'));
  assert.notEqual(indexedBackupKey('owner-a'), indexedBackupKey('owner-b'));
  f.records.set('vocab_local_backup', { version: 1, sessions: [], words: [word] });
  await f.store.save(backup('owner-a'), 'owner-a');
  await f.store.save(backup('owner-b'), 'owner-b');
  await f.store.clear('owner-a');
  assert.equal(await f.store.load('owner-a'), null);
  assert.equal((await f.store.load('owner-b'))?.ownerId, 'owner-b');
  assert.ok(f.records.has('vocab_local_backup'));
});

test('backup access requires an owner and rejects foreign or unowned scoped records', async () => {
  const f = fixture(null);
  await assert.rejects(f.store.load(), /登录/);
  assert.equal(f.reads.length, 0);
  await assert.rejects(f.store.save(backup('owner-a'), 'owner-b'), /另一个账号/);
  f.records.set(localBackupKey('owner-a'), { sessions: [], words: [], version: 1 });
  await assert.rejects(f.store.load('owner-a'), /归属异常/);
  assert.ok(f.records.has(localBackupKey('owner-a')));
});

test('account switch during asynchronous read never redirects a write', async () => {
  let currentUser = 'owner-a';
  let release!: () => void;
  let started!: () => void;
  const readStarted = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writes: string[] = [];
  const store = createLocalBackupStore({
    resolveCurrentUser: async () => currentUser,
    read: async id => { started(); await gate; return backup(id); },
    write: async (id, value) => { assert.equal(value.ownerId, id); writes.push(id); return true; },
    remove: async () => {},
  });
  const pending = store.update(value => value);
  await readStarted;
  currentUser = 'owner-b';
  release();
  await pending;
  assert.deepEqual(writes, ['owner-a']);
});

test('parallel session changes for one account are serialized without dropping either write', async () => {
  const f = fixture();
  const append = (id: string) => f.store.update(value => ({
    ...value, sessions: [...value.sessions, { id, timestamp: at, wordCount: 0, targetCount: 9, syncStatus: 'pending' }],
  }), 'owner-a');
  await Promise.all([append('session-1'), append('session-2')]);
  assert.deepEqual((await f.store.load('owner-a'))?.sessions.map(session => session.id), ['session-1', 'session-2']);
});
