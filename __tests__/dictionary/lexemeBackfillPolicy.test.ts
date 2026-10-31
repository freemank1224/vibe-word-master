import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BackfillRateLimitError, failureDelaySeconds, retryAfterSeconds, translateBackfillWord,
} from '../../supabase/functions/_shared/lexemeBackfillPolicy.ts';
import { addMachineMeanings } from '../../supabase/functions/_shared/lexemeBackfillStore.ts';

test('one job attempts exactly one provider, alternating only on later attempts', async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(calls.length === 1 ? { translated_text: '剑齿虎' } : [[['银行']]]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  assert.deepEqual(await translateBackfillWord('sabertooth', 1, 'https://example.test/translate', '', fakeFetch), {
    provider: 'uapis', meanings: ['剑齿虎'],
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(await translateBackfillWord('bank', 2, 'https://example.test/translate', '', fakeFetch), {
    provider: 'google-translate', meanings: ['银行'],
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /^https:\/\/translate\.googleapis\.com\//);
  assert.ok(calls.every(url => !url.includes('mymemory')));
});

test('a rate limit stops immediately and retains the longer provider cooldown', async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls++;
    return new Response('', { status: 429, headers: { 'Retry-After': '7200' } });
  };
  await assert.rejects(translateBackfillWord('bank', 1, 'https://example.test/translate', '', fakeFetch),
    (error: unknown) => error instanceof BackfillRateLimitError && error.cooldownSeconds === 7200);
  assert.equal(calls, 1);
  const noHeader: typeof fetch = async () => new Response('', { status: 429 });
  await assert.rejects(translateBackfillWord('bank', 2, 'https://example.test/translate', '', noHeader),
    (error: unknown) => error instanceof BackfillRateLimitError && error.cooldownSeconds === 86400);
  const serviceUnavailable: typeof fetch = async () => new Response('', { status: 503, headers: { 'Retry-After': '5400' } });
  await assert.rejects(translateBackfillWord('bank', 1, 'https://example.test/translate', '', serviceUnavailable),
    (error: unknown) => error instanceof BackfillRateLimitError && error.cooldownSeconds === 5400);
});

test('invalid or long words never issue provider requests', async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => { calls++; return new Response(''); };
  for (const value of ['', 'a'.repeat(33)]) {
    await assert.rejects(translateBackfillWord(value, 1, 'https://example.test/translate', '', fakeFetch));
  }
  assert.equal(calls, 0);
});

test('provider Retry-After dates and exponential retry are bounded', () => {
  const now = Date.parse('2026-10-30T00:00:00Z');
  assert.equal(retryAfterSeconds('Fri, 30 Oct 2026 02:00:00 GMT', now), 7200);
  assert.equal(retryAfterSeconds('nonsense', now), 86400);
  assert.equal(retryAfterSeconds('9'.repeat(400), now), Infinity);
  assert.equal(retryAfterSeconds('3000000000', now), Infinity);
  assert.equal(failureDelaySeconds(1), 600);
  assert.equal(failureDelaySeconds(4), 4800);
  assert.equal(failureDelaySeconds(2, 9000), 9000);
});

test('a user meaning arriving during translation is never overwritten by the machine result', async () => {
  const existing = { meaning_zh: '银行', source_type: 'user_word', source_provider: 'words_trigger' };
  let saved: any = existing;
  const client = { from: (table: string) => {
    assert.equal(table, 'lexeme_meanings');
    return { upsert: async (rows: any[], options: { ignoreDuplicates: boolean; onConflict: string }) => {
      assert.equal(options.onConflict, 'lexeme_id,meaning_zh');
      if (!options.ignoreDuplicates) saved = rows[0];
      return { error: null, status: 201 };
    } };
  } };
  await addMachineMeanings(client, 'lexeme', ['银行'], 'uapis');
  assert.equal(saved, existing);
  assert.equal(saved.source_type, 'user_word');
});
