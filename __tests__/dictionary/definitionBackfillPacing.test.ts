import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFINITION_BACKFILL_INTERVAL_MS, observeSupabaseRateLimits, recordSupabaseRateLimit, retryAfterDeadline,
  sharedRateLimitDeadline, withDefinitionBackfillPermit,
} from '../../services/definitionBackfillPacing.ts';

class MemoryStorage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

class FakeLocks {
  private held = false;
  async request(_name: string, _options: unknown, callback: (lock: object | null) => Promise<unknown>) {
    if (this.held) return callback(null);
    this.held = true;
    try { return await callback({}); }
    finally { this.held = false; }
  }
}

test('one background lookup at a time and one per minute across tabs', async () => {
  const storage = new MemoryStorage();
  const locks = new FakeLocks() as unknown as LockManager;
  let now = 1_000;
  let finish!: () => void;
  let visits = 0;
  const pending = withDefinitionBackfillPermit(storage, locks, () => true, async () => {
    visits++;
    await new Promise<void>(resolve => { finish = resolve; });
    return 'first';
  }, () => now);
  await Promise.resolve();
  assert.deepEqual(await withDefinitionBackfillPermit(storage, locks, () => true, async () => 'second', () => now), { kind: 'wait', ms: 5_000 });
  finish();
  assert.deepEqual(await pending, { kind: 'done', value: 'first' });
  now += DEFINITION_BACKFILL_INTERVAL_MS - 1;
  assert.deepEqual(await withDefinitionBackfillPermit(storage, locks, () => true, async () => 'second', () => now), { kind: 'wait', ms: 1 });
  now++;
  assert.deepEqual(await withDefinitionBackfillPermit(storage, locks, () => true, async () => 'second', () => now), { kind: 'done', value: 'second' });
  assert.equal(visits, 1);
});

test('account changes and unavailable cross-tab coordination do not start work', async () => {
  const storage = new MemoryStorage();
  const locks = new FakeLocks() as unknown as LockManager;
  let visits = 0;
  const task = async () => { visits++; };
  assert.deepEqual(await withDefinitionBackfillPermit(storage, locks, () => false, task), { kind: 'cancelled' });
  assert.deepEqual(await withDefinitionBackfillPermit(storage, undefined, () => true, task), { kind: 'unavailable' });
  assert.deepEqual(await withDefinitionBackfillPermit(undefined, locks, () => true, task), { kind: 'unavailable' });
  assert.equal(visits, 0);
});

test('the Supabase transport reports 429 without altering the original response', async () => {
  const response = new Response('limited', { status: 429, headers: { 'Retry-After': '7200' } });
  const reported: Array<string | null> = [];
  const fetcher = observeSupabaseRateLimits(async () => response, value => reported.push(value));
  assert.equal(await fetcher('https://example.test'), response);
  assert.deepEqual(reported, ['7200']);
  assert.equal(await response.text(), 'limited');
});

test('a cooldown recorded by another tab blocks this tab without a network call', async () => {
  const storage = new MemoryStorage();
  storage.setItem('vibe_supabase_rate_pause_v1:other-tab', '5000000');
  const locks = new FakeLocks() as unknown as LockManager;
  let visits = 0;
  assert.deepEqual(await withDefinitionBackfillPermit(storage, locks, () => true, async () => { visits++; }, () => 1000), { kind: 'wait', ms: 4_999_000 });
  assert.equal(visits, 0);
});

test('429 pauses survive a reload and honor the longer retry deadline', async () => {
  const storage = new MemoryStorage();
  const locks = new FakeLocks() as unknown as LockManager;
  const now = 10_000;
  assert.equal(retryAfterDeadline(null, now), now + 86_400_000);
  assert.equal(retryAfterDeadline('172800', now), now + 172_800_000);
  assert.equal(retryAfterDeadline(new Date(now + 172_800_000).toUTCString(), now), now + 172_800_000);
  assert.equal(retryAfterDeadline('9'.repeat(400), now), Infinity);
  recordSupabaseRateLimit('172800', storage, now);
  assert.equal(sharedRateLimitDeadline(storage, now), now + 172_800_000);
  let called = false;
  assert.deepEqual(await withDefinitionBackfillPermit(storage, locks, () => true, async () => { called = true; }, () => now), { kind: 'wait', ms: 172_800_000 });
  assert.equal(called, false);
});
