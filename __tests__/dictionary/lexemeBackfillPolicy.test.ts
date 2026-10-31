import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BackfillRateLimitError, failureDelaySeconds, retryAfterSeconds, translateBackfillWord,
} from '../../supabase/functions/_shared/lexemeBackfillPolicy.ts';
import { addMachineMeanings } from '../../supabase/functions/_shared/lexemeBackfillStore.ts';

const oddLexeme = '00000000-0000-4000-8000-000000000001';
const evenLexeme = '00000000-0000-4000-8000-000000000000';

test('one job attempts exactly one provider, alternating only on later attempts', async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(calls.length === 1 ? { translated_text: '剑齿虎' } : [[['银行']]]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  assert.deepEqual(await translateBackfillWord('sabertooth', oddLexeme, 1, 'https://example.test/translate', '', fakeFetch), {
    provider: 'uapis', meanings: ['剑齿虎'],
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(await translateBackfillWord('bank', oddLexeme, 2, 'https://example.test/translate', '', fakeFetch), {
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
  await assert.rejects(translateBackfillWord('bank', oddLexeme, 1, 'https://example.test/translate', '', fakeFetch),
    (error: unknown) => error instanceof BackfillRateLimitError && error.cooldownSeconds === 7200);
  assert.equal(calls, 1);
  const noHeader: typeof fetch = async () => new Response('', { status: 429 });
  await assert.rejects(translateBackfillWord('bank', oddLexeme, 2, 'https://example.test/translate', '', noHeader),
    (error: unknown) => error instanceof BackfillRateLimitError && error.cooldownSeconds === 86400);
  const serviceUnavailable: typeof fetch = async () => new Response('', { status: 503, headers: { 'Retry-After': '5400' } });
  await assert.rejects(translateBackfillWord('bank', oddLexeme, 1, 'https://example.test/translate', '', serviceUnavailable),
    (error: unknown) => error instanceof BackfillRateLimitError && error.cooldownSeconds === 5400);
});

test('invalid or long words never issue provider requests', async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => { calls++; return new Response(''); };
  for (const value of ['', 'a'.repeat(33)]) {
    await assert.rejects(translateBackfillWord(value, oddLexeme, 1, 'https://example.test/translate', '', fakeFetch));
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


test('stable UUID buckets divide first attempts and alternate after ordinary failure', async () => {
  const urls: string[] = [];
  const fakeFetch: typeof fetch = async url => {
    urls.push(String(url));
    return new Response(JSON.stringify(String(url).startsWith('https://example.test')
      ? { translated_text: '测试' } : [[['测试']]]));
  };
  for (const [id, expected] of [
    [oddLexeme, ['uapis', 'google-translate', 'uapis']],
    [evenLexeme, ['google-translate', 'uapis', 'google-translate']],
  ] as const) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = urls.length;
      const result = await translateBackfillWord('test', id, attempt, 'https://example.test/translate', '', fakeFetch);
      assert.equal(result.provider, expected[attempt - 1]);
      assert.equal(urls.length, before + 1);
    }
  }
  // Include all hexadecimal suffixes: exactly half select each provider.
  let uapis = 0;
  for (const digit of '0123456789abcdef') {
    const id = oddLexeme.slice(0, -1) + digit;
    if ((await translateBackfillWord('test', id, 1, 'https://example.test/translate', '', fakeFetch)).provider === 'uapis') uapis++;
  }
  assert.equal(uapis, 8);
});

test('a rate limit makes one request and does not switch providers when the attempt is restored', async () => {
  for (const id of [oddLexeme, evenLexeme]) {
    const urls: string[] = [];
    const limited: typeof fetch = async url => { urls.push(String(url)); return new Response('', { status: 429 }); };
    for (let run = 0; run < 2; run++) {
      await assert.rejects(translateBackfillWord('test', id, 1, 'https://example.test/translate', '', limited), BackfillRateLimitError);
    }
    assert.equal(urls.length, 2);
    assert.equal(urls[0], urls[1]);
  }
});

test('an invalid lexeme ID cannot dispatch a provider request', async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => { calls++; return new Response(''); };
  await assert.rejects(translateBackfillWord('test', 'invalid', 1, 'https://example.test', '', fakeFetch));
  assert.equal(calls, 0);
});
