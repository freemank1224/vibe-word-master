import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCoinBalance } from '../coinService.ts';
import { supabase } from '../../lib/supabaseClient.ts';

test('wallet read preserves a real zero but reports failed or malformed balances as unavailable', async t => {
  let reply: { data: unknown; error: { message: string } | null } = { data: { balance: 0 }, error: null };
  let fail = false;
  t.mock.method(console, 'error', () => {});
  t.mock.method(supabase, 'rpc', async (name: string, args: unknown) => {
    assert.equal(name, 'get_wallet_state');
    assert.deepEqual(args, { p_transaction_limit: 1 });
    if (fail) throw new Error('offline');
    return reply;
  });
  assert.equal(await getCoinBalance(), 0);
  reply.data = { balance: 42 };
  assert.equal(await getCoinBalance(), 42);
  reply = { data: null, error: { message: 'unavailable' } };
  assert.equal(await getCoinBalance(), null);
  for (const value of [null, {}, { balance: '42' }, { balance: -1 }, { balance: 2.5 }]) {
    reply = { data: value, error: null };
    assert.equal(await getCoinBalance(), null);
  }
  fail = true;
  assert.equal(await getCoinBalance(), null);
});
