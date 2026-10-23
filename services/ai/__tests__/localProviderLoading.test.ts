import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalProvider } from '../localProvider.ts';

const dictionaryResponse = (path: string) => new Response(path.endsWith('.aff') ? 'SET UTF-8\n' : '2\nhello\nworld\n');

test('local spelling fetches on first validation, shares in-flight loading, and awaits a valid dictionary', async (context) => {
  const requests: string[] = [];
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  context.mock.method(globalThis, 'fetch', async (input: string) => {
    requests.push(input);
    await ready;
    return dictionaryResponse(input);
  });
  const provider = new LocalProvider();
  assert.deepEqual(requests, []);
  let settled = false;
  const first = provider.validateSpelling('hello').then(result => { settled = true; return result; });
  const second = provider.validateSpelling('world');
  await Promise.resolve();
  assert.equal(settled, false, 'an unfinished load cannot report a spelling result');
  assert.equal(requests.length, 2);
  release();
  assert.equal((await first).isValid, true);
  assert.equal((await second).isValid, true);
  assert.equal((await provider.validateSpelling('hello')).isValid, true);
  assert.equal(requests.length, 2);
});

test('an offline first load can retry when the dictionary is available again', async (context) => {
  let offline = true;
  context.mock.method(console, 'error', () => {});
  context.mock.method(globalThis, 'fetch', async (input: string) => {
    if (offline) throw new Error('offline');
    return dictionaryResponse(input);
  });
  const provider = new LocalProvider();
  assert.deepEqual(await provider.validateSpelling('hello'), { found: false, isValid: false });
  offline = false;
  assert.equal((await provider.validateSpelling('hello')).isValid, true);
});

test('hanging dictionary requests time out, abort both requests, and allow a later retry', { timeout: 1500 }, async (context) => {
  const signals: AbortSignal[] = [];
  let hanging = true;
  context.mock.method(console, 'error', () => {});
  context.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    if (!hanging) return dictionaryResponse(input);
    signals.push(init.signal as AbortSignal);
    // Deliberately ignore the signal to verify that abort alone isn't relied on.
    return new Promise<Response>(() => {});
  });
  const provider = new LocalProvider({ loadTimeoutMs: 20 });
  assert.deepEqual(await provider.validateSpelling('hello'), { found: false, isValid: false });
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
  hanging = false;
  assert.equal((await provider.validateSpelling('hello')).isValid, true);
});

test('the total dictionary budget includes hanging response bodies and ignores their late result', { timeout: 1500 }, async (context) => {
  let hanging = true;
  const releases: Array<() => void> = [];
  const signals: AbortSignal[] = [];
  context.mock.method(console, 'error', () => {});
  context.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    if (!hanging) return dictionaryResponse(input);
    signals.push(init.signal as AbortSignal);
    return {
      ok: true,
      text: () => new Promise<string>(resolve => {
        releases.push(() => resolve(input.endsWith('.aff') ? 'SET UTF-8\n' : '1\nlateword\n'));
      }),
    } as Response;
  });
  const provider = new LocalProvider({ loadTimeoutMs: 20 });
  assert.deepEqual(await provider.validatePhrase('hello world'), { isValid: false, error: 'DICT_NOT_LOADED' });
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
  hanging = false;
  assert.equal((await provider.validateSpelling('hello')).isValid, true);
  releases.forEach(release => release());
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal((await provider.validateSpelling('hello')).isValid, true, 'late timed-out data must not replace the successful retry');
});
