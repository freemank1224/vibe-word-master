import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPendingSyncQueue, pendingSyncKey, type NewPendingSync } from '../pendingSyncQueueCore.ts';
import { parseTestStatsReceipt } from '../testStatsEvents.ts';
import { getShanghaiDateString } from '../../utils/timezone.ts';

const timestamp = Date.parse('2026-10-21T15:59:59Z');
const event = (id = 'round-1', userId = 'alice'): NewPendingSync => ({ id, userId, timestamp, date: '2026-10-21', testCount: 10, correctCount: 8, points: 20, expectedVersion: 0 });
const receipt = (id = 'round-1') => ({ event_id: id, synced_date: '2026-10-21', total_tests: 10, correct_tests: 8, total_points: 20, version: 1, coins_awarded: 3 });
function fixture(send: (item: NewPendingSync) => Promise<unknown> = async item => receipt(item.id)) {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const state = { userId: 'alice', now: timestamp + 86400000 };
  const queue = createPendingSyncQueue({ storage, now: () => state.now, currentUserId: async () => state.userId, send: item => send(item as NewPendingSync) });
  return { queue, storage, state, values };
}

test('stable event ID deduplicates enqueue and rejects changing its contents', () => {
  const { queue } = fixture();
  assert.equal(queue.enqueue(event()), true);
  assert.equal(queue.enqueue(event()), false);
  assert.throws(() => queue.enqueue({ ...event(), points: 100 }));
  assert.equal(queue.read('alice').length, 1);
});

test('retry preserves original event date across Shanghai midnight', async () => {
  const sent: NewPendingSync[] = [];
  const { queue } = fixture(async item => { sent.push(item); return receipt(item.id); });
  queue.enqueue(event());
  assert.equal((await queue.process('alice')).success, 1);
  assert.equal(sent[0].timestamp, timestamp);
  assert.equal(sent[0].date, '2026-10-21');
  assert.equal(getShanghaiDateString(timestamp + 1000), '2026-10-22');
});

test('a committed request with a lost response retries the same ID exactly once', async () => {
  const serverIds = new Set<string>(); let first = true; let count = 0;
  const { queue, state } = fixture(async item => {
    if (!serverIds.has(item.id)) { serverIds.add(item.id); count += item.testCount; }
    if (first) { first = false; throw new Error('response lost'); }
    return receipt(item.id);
  });
  queue.enqueue(event());
  assert.equal((await queue.process('alice')).failed, 1);
  state.now += 1000;
  assert.equal((await queue.process('alice')).success, 1);
  assert.equal(count, 10);
  assert.equal(queue.read('alice').length, 0);
});

test('failures remain after three retries and backoff is checked before request', async () => {
  let calls = 0;
  const { queue, state } = fixture(async () => { calls++; throw new Error('offline'); });
  queue.enqueue(event());
  for (let i = 0; i < 6; i++) { await queue.process('alice'); state.now += 300000; }
  assert.equal(calls, 6);
  assert.equal(queue.read('alice')[0].retryCount, 6);
  await queue.process('alice');
  const before = calls;
  await queue.process('alice');
  assert.equal(calls, before);
  assert.equal(queue.read('alice').length, 1);
});

test('null, empty, mismatched and malformed acknowledgements cannot clear pending work', async () => {
  for (const response of [null, {}, [], { ...receipt(), event_id: 'other' }, { ...receipt(), synced_date: '2026-10-22' }, { ...receipt(), total_tests: NaN }]) {
    const { queue } = fixture(async () => response);
    queue.enqueue(event());
    assert.equal((await queue.process('alice')).success, 0);
    assert.equal(queue.read('alice').length, 1);
  }
  assert.throws(() => parseTestStatsReceipt([receipt(), receipt()], event()));
});

test('accounts are isolated and legacy ownerless records are left intact', async () => {
  const { queue, values, state } = fixture();
  values.set('vibe_pending_syncs', JSON.stringify([{ ...event(), userId: undefined }]));
  queue.enqueue(event()); queue.enqueue(event('round-2', 'bob'));
  state.userId = 'bob';
  assert.equal((await queue.process('alice')).success, 0);
  assert.equal((await queue.process('bob')).success, 1);
  assert.equal(queue.read('alice').length, 1);
  assert.ok(values.get('vibe_pending_syncs'));
});

test('account switch during upload keeps original queue for safe replay', async () => {
  const f = fixture(async () => { f.state.userId = 'bob'; return receipt(); });
  f.queue.enqueue(event());
  assert.equal((await f.queue.process('alice')).success, 0);
  assert.equal(f.queue.read('alice').length, 1);
  assert.equal(f.queue.read('bob').length, 0);
});

test('concurrent processing shares a request and preserves newly enqueued items', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const { queue } = fixture(async () => { calls++; await gate; return receipt(); });
  queue.enqueue(event());
  const first = queue.process('alice'); const second = queue.process('alice');
  assert.equal(first, second);
  queue.enqueue(event('round-2'));
  release(); await first;
  assert.equal(calls, 1);
  assert.deepEqual(queue.read('alice').map(item => item.id), ['round-2']);
});

test('corrupt storage and write failure are surfaced without replacing records', () => {
  const f = fixture(); f.values.set(pendingSyncKey('alice'), '{broken');
  assert.throws(() => f.queue.enqueue(event()));
  assert.equal(f.values.get(pendingSyncKey('alice')), '{broken');
  const queue = createPendingSyncQueue({ storage: { getItem: () => null, setItem: () => { throw new Error('quota'); } }, now: Date.now, currentUserId: async () => 'alice', send: async () => receipt() });
  assert.throws(() => queue.enqueue(event()), /quota/);
});

test('invalid dates and mismatched owners cannot enter or leave the queue', () => {
  const f = fixture();
  assert.throws(() => f.queue.enqueue({ ...event(), date: '2026-10-22' }));
  assert.throws(() => f.queue.enqueue({ ...event(), correctCount: 11 }));
  f.values.set(pendingSyncKey('alice'), JSON.stringify([event('other', 'bob')]));
  assert.throws(() => f.queue.read('alice'));
});
