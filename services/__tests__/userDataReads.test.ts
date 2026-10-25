import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { supabase } from '../../lib/supabaseClient.ts';
import { coalesceUserReads, fetchUserLearningProgress, invalidateUserDataReads, mapWordLearningProgress, readForCurrentIdentity } from '../userDataReads.ts';

test('concurrent progress consumers share only the same account in-flight request', async () => {
  const pending: Array<{ userId: string; resolve: (rows: string[]) => void }> = [];
  const read = coalesceUserReads((userId: string) => new Promise<string[]>(resolve => pending.push({ userId, resolve })));
  const first = read('account-a');
  const duplicate = read('account-a');
  const other = read('account-b');
  assert.equal(first, duplicate);
  assert.notEqual(first, other);
  await setImmediate();
  assert.deepEqual(pending.map(item => item.userId), ['account-a', 'account-b']);
  pending[0].resolve(['a-word']);
  pending[1].resolve(['b-word']);
  assert.deepEqual(await first, ['a-word']);
  assert.deepEqual(await duplicate, ['a-word']);
  assert.deepEqual(await other, ['b-word']);
  const refreshed = read('account-a');
  assert.notEqual(refreshed, first, 'a completed read is never reused as stale library data');
  await setImmediate();
  assert.equal(pending.length, 3);
  pending[2].resolve(['a-word', 'new-word']);
  assert.deepEqual(await refreshed, ['a-word', 'new-word']);
});

test('a failed or synchronously thrown coalesced read releases the account for an explicit retry', async () => {
  let calls = 0;
  const read = coalesceUserReads<string[]>(() => {
    calls++;
    if (calls === 1) return Promise.reject(new Error('statement timeout'));
    if (calls === 2) throw new Error('transport unavailable');
    return Promise.resolve(['recovered-word']);
  });
  const first = read('retry-account');
  const duplicate = read('retry-account');
  const failed = await Promise.allSettled([first, duplicate]);
  assert.equal(calls, 1);
  assert.ok(failed.every(result => result.status === 'rejected'));
  await assert.rejects(read('retry-account'), /transport unavailable/);
  assert.deepEqual(await read('retry-account'), ['recovered-word']);
  assert.equal(calls, 3);
});

test('a full-library refresh after a write always starts a fresh read even while an earlier read is pending', async () => {
  const pending: Array<(rows: string[]) => void> = [];
  const refresh = () => readForCurrentIdentity(() => new Promise<string[]>(resolve => pending.push(resolve)));
  const beforeWrite = refresh();
  await setImmediate();
  const afterWrite = refresh();
  assert.notEqual(beforeWrite, afterWrite);
  await setImmediate();
  assert.equal(pending.length, 2, 'post-write consumers must not share a pre-write snapshot');
  pending[1](['newly-saved-word']);
  assert.deepEqual(await afterWrite, ['newly-saved-word']);
  pending[0]([]);
  assert.deepEqual(await beforeWrite, []);
});

test('logging out and back into the same account starts a new generation and rejects the old result', async () => {
  const pending: Array<(rows: string[]) => void> = [];
  const read = coalesceUserReads(() => new Promise<string[]>(resolve => pending.push(resolve)));
  const previous = read('returning-account');
  const rejected = assert.rejects(previous, /Account changed/);
  await setImmediate();
  invalidateUserDataReads(); // A -> signed out.
  invalidateUserDataReads(); // Signed out -> A.
  const current = read('returning-account');
  assert.notEqual(current, previous);
  await setImmediate();
  assert.equal(pending.length, 2);
  pending[0]([]);
  await rejected;
  assert.equal(read('returning-account'), current, 'the old finally cannot delete the new generation');
  pending[1](['current-word']);
  assert.deepEqual(await current, ['current-word']);
});

test('an account switch before a queued read starts prevents its loader from running', async () => {
  let calls = 0;
  const read = coalesceUserReads(async () => { calls++; return []; });
  const stale = read('previous-account');
  invalidateUserDataReads();
  await assert.rejects(stale, /Account changed/);
  assert.equal(calls, 0);
});

type Query = {
  table: string; fields?: string; userId?: string; filter?: string;
  order?: string; ascending?: boolean; limit?: number; cursor?: string;
};
function queries(reply: (query: Query) => unknown | Promise<unknown>) {
  return (table: string) => {
    const query: Query = { table };
    return {
      select(fields: string) { query.fields = fields; return this; },
      eq(column: string, value: string) { assert.equal(column, 'user_id'); query.userId = value; return this; },
      or(filter: string) { query.filter = filter; return this; },
      order(column: string, options: { ascending: boolean }) { query.order = column; query.ascending = options.ascending; return this; },
      limit(limit: number) { query.limit = limit; return this; },
      gt(column: string, value: string) { assert.equal(column, 'id'); query.cursor = value; return this; },
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        return Promise.resolve().then(() => reply({ ...query })).then(resolve, reject);
      },
    };
  };
}
const row = (index: number) => ({
  id: String(index).padStart(6, '0'), correct: true, tested: true, score: 2.4,
  error_count: 2, consecutive_correct: 3, last_tested: '2026-10-24T12:00:00Z',
  best_time_ms: 740, review_state: null, learning_revision: 7,
});

test('background progress reads use only learning fields, stable cursor pagination and no media pipeline', async t => {
  const source = Array.from({ length: 513 }, (_, index) => row(index));
  const calls: Query[] = [];
  t.mock.method(supabase, 'from', queries(query => {
    calls.push(query);
    assert.equal(query.table, 'words', 'no sessions, image assets, or image repair writes');
    assert.equal(query.userId, 'progress-account');
    assert.equal(query.filter, 'deleted.eq.false,deleted.is.null');
    assert.equal(query.order, 'id');
    assert.equal(query.ascending, true);
    assert.equal(query.limit, 500);
    assert.deepEqual(query.fields?.split(','), ['id', 'correct', 'tested', 'score', 'error_count',
      'consecutive_correct', 'last_tested', 'best_time_ms', 'review_state', 'learning_revision']);
    return { data: source.filter(item => !query.cursor || item.id > query.cursor).slice(0, query.limit), error: null };
  }));
  const first = fetchUserLearningProgress('progress-account');
  const duplicate = fetchUserLearningProgress('progress-account');
  assert.equal(first, duplicate);
  const progress = await first;
  assert.equal(progress.length, 513);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.cursor), [undefined, '000499']);
  assert.equal(progress[0].score, 2.4);
  assert.equal(progress[0].last_tested, Date.parse('2026-10-24T12:00:00Z'));
  assert.equal(progress[0].learning_revision, 7);
  await fetchUserLearningProgress('progress-account');
  assert.equal(calls.length, 4, 'a later poll reads fresh progress');
});

test('an exact full progress page terminates on the empty next page', async t => {
  const calls: Query[] = [];
  t.mock.method(supabase, 'from', queries(query => {
    calls.push(query);
    return { data: query.cursor ? [] : Array.from({ length: 500 }, (_, index) => row(index)), error: null };
  }));
  const progress = await fetchUserLearningProgress('exact-page-account');
  assert.equal(progress.length, 500);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cursor, '000499');
});

test('a failed later progress page rejects the entire read and retries from the beginning', async t => {
  let failed = true;
  const calls: Query[] = [];
  t.mock.method(supabase, 'from', queries(query => {
    calls.push(query);
    if (query.cursor && failed) return { data: null, error: { message: 'statement timeout' } };
    return { data: query.cursor ? [row(500)] : Array.from({ length: 500 }, (_, index) => row(index)), error: null };
  }));
  await assert.rejects(fetchUserLearningProgress('failed-page-account'), /statement timeout/);
  failed = false;
  const recovered = await fetchUserLearningProgress('failed-page-account');
  assert.equal(recovered.length, 501);
  assert.deepEqual(calls.map(call => call.cursor), [undefined, '000499', undefined, '000499']);
});

test('an account generation change stops old progress pagination and preserves the replacement read', async t => {
  const calls: Query[] = [];
  const pending: Array<(reply: unknown) => void> = [];
  t.mock.method(supabase, 'from', queries(query => {
    calls.push(query);
    return new Promise(resolve => pending.push(resolve));
  }));
  const previous = fetchUserLearningProgress('same-progress-account');
  const rejected = assert.rejects(previous, /Account changed/);
  await setImmediate();
  invalidateUserDataReads();
  const current = fetchUserLearningProgress('same-progress-account');
  await setImmediate();
  assert.equal(pending.length, 2);
  pending[0]({ data: Array.from({ length: 500 }, (_, index) => row(index)), error: null });
  await rejected;
  assert.equal(calls.length, 2, 'the stale full page must not issue another query under the new identity');
  assert.ok(calls.every(call => call.cursor === undefined));
  assert.equal(fetchUserLearningProgress('same-progress-account'), current);
  pending[1]({ data: [row(900)], error: null });
  assert.deepEqual((await current).map(word => word.id), ['000900']);
});

test('learning mapping keeps legitimate zeros and defaults nullable database values consistently', () => {
  const progress = mapWordLearningProgress({ id: 'word', correct: false, tested: false, score: 0,
    error_count: 0, best_time_ms: 0, last_tested: null });
  assert.equal(progress.score, 0);
  assert.equal(progress.best_time_ms, 0);
  assert.equal(progress.last_tested, null);
  assert.equal(progress.error_count, 0);
  assert.equal(progress.consecutive_correct, 0);
  assert.equal(progress.learning_revision, 0);
  assert.equal(progress.review_state, null);
});
