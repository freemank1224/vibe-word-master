import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { SurfRecordingBuffer, SurfRecordingLoadError, type SurfRecordingProgress } from '../../features/monster-surf/recordingBuffer.ts';
import type { SurfWord } from '../../features/monster-surf/types.ts';

const remote = (word: string) => `https://recordings.example/${word}.mp3`;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deck = (count: number) => Array.from({ length: count }, (_, index): SurfWord => ({
  answer: `word${index}`, meaningZh: '释义', meaningEn: 'Meaning', wordId: `id-${index}`,
}));
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = () => ({ ok: true, headers: new Headers(), blob: async () => new Blob(['a complete word recording'], { type: 'audio/mpeg' }) } as Response);

function fixture(t: TestContext, options: { manualFetch?: boolean; manualDecode?: boolean; sources?: (word: string) => string[] } = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls: { url: string; signal: AbortSignal; task: ReturnType<typeof deferred<Response>>; finished: boolean }[] = [];
  const elements: FakeAudio[] = [];
  const blobs = new Map<string, Blob>();
  const revoked: string[] = [];
  const ready: [string, string][] = [];
  let manualFetch = options.manualFetch ?? false;
  let serial = 0;
  class FakeAudio {
    src = ''; preload = ''; paused = false;
    oncanplay: (() => void) | null = null;
    onloadeddata: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { elements.push(this); }
    load() { if (this.src && !options.manualDecode) queueMicrotask(() => this.oncanplay?.()); }
    pause() { this.paused = true; }
    removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { Audio: FakeAudio } });
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) => {
    const task = deferred<Response>();
    calls.push({ url, signal: init.signal!, task, finished: false });
    if (!manualFetch) task.resolve(response());
    return task.promise;
  });
  t.mock.method(URL, 'createObjectURL', (blob: Blob) => {
    const source = `blob:recording-${++serial}`;
    blobs.set(source, blob);
    return source;
  });
  t.mock.method(URL, 'revokeObjectURL', (source: string) => { revoked.push(source); blobs.delete(source); });
  const buffer = new SurfRecordingBuffer({
    resolveSources: options.sources ?? (word => [remote(word)]),
    onSourceReady: (word, source) => ready.push([word, source]),
  });
  t.after(() => {
    buffer.dispose();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  return {
    buffer, calls, elements, blobs, revoked, ready,
    automaticFetch: () => { manualFetch = false; },
    finishCalls: () => { for (const call of calls) if (!call.finished) { call.finished = true; call.task.resolve(response()); } },
  };
}

test('fixed fifty-word rounds download all files with four workers and replay entirely from prepared bytes', async t => {
  const { buffer, calls, blobs, finishCalls } = fixture(t, { manualFetch: true });
  const words = deck(50);
  const progress: SurfRecordingProgress[] = [];
  const prepared = buffer.prepare(words, { mode: 'fixed', onProgress: value => progress.push(value) });
  assert.equal(calls.length, 4);
  for (let wave = 0; wave < 13; wave++) { finishCalls(); await flush(); }
  await prepared;
  assert.equal(calls.length, 50);
  assert.equal(blobs.size, 50);
  assert.deepEqual(buffer.progress, { loaded: 50, total: 50, failed: 0, loading: false });
  assert.ok(progress.some(value => value.loaded > 0 && value.loaded < value.total));
  for (const word of words) assert.equal(await buffer.ensure(word.answer), buffer.getSource(word.answer));
  assert.equal(calls.length, 50, 'no playback-time network request after fixed preparation');
});

test('preparation waits for the full response body and successful media decoding, not headers or preload hints', async t => {
  const { buffer, calls, elements, ready } = fixture(t, { manualFetch: true, manualDecode: true });
  const body = deferred<Blob>();
  let done = false;
  const prepared = buffer.prepare(deck(1), { mode: 'fixed' }).then(() => { done = true; });
  calls[0].task.resolve({ ok: true, headers: new Headers(), blob: () => body.promise } as Response);
  await flush();
  assert.equal(elements.length, 0);
  assert.equal(done, false);
  assert.equal(buffer.getSource('word0'), null);
  body.resolve(new Blob(['full audio'], { type: 'audio/mpeg' }));
  await flush();
  assert.equal(elements.length, 1);
  assert.equal(done, false);
  assert.ok(elements[0].src.startsWith('blob:'));
  assert.deepEqual(ready, []);
  elements[0].oncanplay?.();
  await prepared;
  assert.deepEqual(ready, [['word0', remote('word0')]]);
  assert.equal(elements[0].paused, true);
  assert.equal(elements[0].src, '', 'validation element releases its decoder after readiness');
});

test('missing or failed CORS recordings recover through the next official source', async t => {
  const fallback = 'https://official.example/pronunciation?word=word0';
  const { buffer, calls, ready } = fixture(t, { manualFetch: true, sources: word => [remote(word), fallback] });
  const prepared = buffer.prepare(deck(1), { mode: 'fixed' });
  calls[0].task.reject(new TypeError('Failed to fetch: CORS'));
  await flush();
  assert.equal(calls[1].url, fallback);
  calls[1].task.resolve(response());
  await prepared;
  assert.deepEqual(ready, [['word0', fallback]]);
});

test('HTML/JSON error payloads never count as prepared audio even with a successful HTTP status', async t => {
  const { buffer, calls, elements } = fixture(t, { manualFetch: true });
  const prepared = buffer.prepare(deck(1), { mode: 'fixed' });
  calls[0].task.resolve(new Response('{"error":"missing"}', { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(prepared, SurfRecordingLoadError);
  assert.equal(elements.length, 0);
  assert.deepEqual(buffer.progress, { loaded: 0, total: 1, failed: 1, loading: false });
});

test('decoder rejection revokes corrupt bytes and falls back without caching the bad URL', async t => {
  const { buffer, elements, revoked, ready } = fixture(t, {
    manualDecode: true, sources: word => [remote(word), `${remote(word)}?fallback=1`],
  });
  const prepared = buffer.prepare(deck(1), { mode: 'fixed' });
  await flush();
  const corruptSource = elements[0].src;
  elements[0].onerror?.();
  await flush();
  assert.ok(revoked.includes(corruptSource));
  assert.equal(elements.length, 2);
  assert.deepEqual(ready, []);
  elements[1].oncanplay?.();
  await prepared;
  assert.deepEqual(ready, [['word0', `${remote('word0')}?fallback=1`]]);
});

test('retry preserves completed files and requests only failed recordings', async t => {
  const { buffer, calls, finishCalls, automaticFetch } = fixture(t, { manualFetch: true });
  const prepared = buffer.prepare(deck(3), { mode: 'fixed' });
  calls[1].finished = true;
  calls[1].task.resolve(new Response('', { status: 404 }));
  finishCalls();
  await assert.rejects(prepared, error => error instanceof SurfRecordingLoadError && error.failedWords.join() === 'word1');
  assert.deepEqual(buffer.progress, { loaded: 2, total: 3, failed: 1, loading: false });
  automaticFetch();
  await buffer.prepare(deck(3), { mode: 'fixed' });
  assert.equal(calls.length, 4);
  assert.equal(calls[3].url, remote('word1'));
  assert.deepEqual(buffer.progress, { loaded: 3, total: 3, failed: 0, loading: false });
});

test('endless preparation starts with twenty and streams the entire queue using a bounded cache', async t => {
  const { buffer, calls, blobs, revoked } = fixture(t);
  const words = deck(125);
  await buffer.prepare(words, { mode: 'endless' });
  assert.equal(calls.length, 20);
  assert.equal(buffer.getSource('word20'), null);
  for (let checkpoint = 1; checkpoint < words.length; checkpoint++) {
    buffer.advance(checkpoint);
    await flush();
    assert.ok(buffer.getSource(words[checkpoint].answer), `word ${checkpoint} is ready before playback`);
    assert.ok(blobs.size <= 24, 'past recordings do not accumulate for a large vocabulary');
  }
  assert.equal(calls.length, 125, 'each queued word downloads once, including words beyond the old 100-word cap');
  assert.equal(new Set(calls.map(call => call.url)).size, 125);
  assert.ok(revoked.length >= 100);
  assert.equal(buffer.getSource('word0'), null);
});

test('streaming reserves a fourth download slot for a current-word underrun and promotes it before queued prefetches', async t => {
  const state = fixture(t, { manualFetch: true });
  const { buffer, calls, finishCalls } = state;
  const prepared = buffer.prepare(deck(100), { mode: 'endless' });
  for (let batch = 0; batch < 5; batch++) { finishCalls(); await flush(); }
  await prepared;
  buffer.advance(5);
  assert.deepEqual(calls.slice(20).map(call => call.url), [remote('word20'), remote('word21'), remote('word22')]);
  const foreground = buffer.ensure('word50');
  assert.equal(calls[23].url, remote('word50'), 'foreground does not wait for all background workers');
  const priority = buffer.ensure('word80');
  calls[20].finished = true; calls[20].task.resolve(response());
  await flush();
  assert.equal(calls[24].url, remote('word80'), 'queued foreground wins over word23 and word24');
  finishCalls(); await flush(); finishCalls(); await flush();
  await Promise.all([foreground, priority]);
});

test('concurrent replay requests for the same recording share one complete download', async t => {
  const { buffer, calls, finishCalls } = fixture(t, { manualFetch: true });
  const first = buffer.ensure('sun');
  const second = buffer.ensure(' SUN ');
  assert.equal(first, second);
  assert.equal(calls.length, 1);
  finishCalls();
  assert.equal(await first, await second);
});

test('aborting a load rejects promptly, ignores late downloads and allows a clean retry', async t => {
  const { buffer, calls, blobs, automaticFetch } = fixture(t, { manualFetch: true });
  const prepared = buffer.prepare(deck(10), { mode: 'fixed' });
  buffer.abort();
  await assert.rejects(prepared, { name: 'AbortError' });
  assert.equal(calls.every(call => call.signal.aborted), true);
  for (const call of calls) call.task.resolve(response());
  await flush();
  assert.equal(blobs.size, 0);
  assert.equal(calls.length, 4, 'cancelled queued jobs never start');
  automaticFetch();
  await buffer.prepare(deck(10), { mode: 'fixed' });
  assert.equal(buffer.progress.loaded, 10);
  buffer.dispose();
  assert.equal(blobs.size, 0);
  await assert.rejects(buffer.ensure('word0'), { name: 'AbortError' });
});

test('decoder cancellation releases its element and Blob even if a stale ready event fires', async t => {
  const { buffer, elements, blobs, ready } = fixture(t, { manualDecode: true });
  const prepared = buffer.prepare(deck(1), { mode: 'fixed' });
  await flush();
  const lateReady = elements[0].oncanplay!;
  buffer.dispose();
  lateReady();
  await assert.rejects(prepared, { name: 'AbortError' });
  await flush();
  assert.equal(elements[0].paused, true);
  assert.equal(blobs.size, 0);
  assert.deepEqual(ready, []);
});

test('timed-out sources use fallback followed by only one automatic retry, then fail within a bounded time', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { buffer, calls } = fixture(t, { manualFetch: true, sources: word => [remote(word), `${remote(word)}?fallback=1`] });
  const prepared = buffer.prepare(deck(1), { mode: 'fixed' });
  t.mock.timers.tick(30000); await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].signal.aborted, true);
  t.mock.timers.tick(30000); await flush();
  t.mock.timers.tick(500); await flush();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url, `${remote('word0')}?fallback=1`);
  t.mock.timers.tick(30000); await flush();
  await assert.rejects(prepared, SurfRecordingLoadError);
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(calls[2].signal.aborted, true);
});

test('resumed streaming runs prepare from the saved checkpoint, and small decks need only their actual words', async t => {
  const { buffer, calls } = fixture(t);
  await buffer.prepare(deck(100), { mode: 'endless', checkpoint: 93 });
  assert.deepEqual(calls.map(call => call.url), Array.from({ length: 7 }, (_, index) => remote(`word${index + 93}`)));
  assert.deepEqual(buffer.progress, { loaded: 7, total: 7, failed: 0, loading: false });
});

test('a first-time recording timeout retries once and becomes ready without duplicating prepared cache entries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { buffer, calls, blobs, ready } = fixture(t, { manualFetch: true });
  const prepared = buffer.prepare(deck(1), { mode: 'fixed' });
  t.mock.timers.tick(29999); await flush();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1); await flush();
  assert.equal(calls[0].signal.aborted, true);
  t.mock.timers.tick(499); await flush();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1); await flush();
  assert.equal(calls.length, 2);
  calls[1].task.resolve(response());
  await prepared;
  calls[0].task.resolve(response()); await flush();
  assert.equal(blobs.size, 1);
  assert.deepEqual(ready, [['word0', remote('word0')]]);
  assert.equal(await buffer.ensure('word0'), buffer.getSource('word0'));
  assert.equal(calls.length, 2);
});

for (const status of [408, 429, 500, 503]) {
  test(`HTTP ${status} recovers automatically with one retry`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { buffer, calls, blobs } = fixture(t, { manualFetch: true });
    const prepared = buffer.prepare(deck(1), { mode: 'fixed' });
    calls[0].task.resolve(new Response('', { status })); await flush();
    t.mock.timers.tick(500); await flush();
    assert.equal(calls.length, 2);
    calls[1].task.resolve(response());
    await prepared;
    assert.equal(blobs.size, 1);
  });
}

test('a transient network interruption recovers automatically, while the retry honors a bounded Retry-After', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { buffer, calls } = fixture(t, { manualFetch: true });
  const prepared = buffer.prepare(deck(2), { mode: 'fixed' });
  calls[0].task.reject(new TypeError('Connection lost'));
  calls[1].task.resolve(new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
  await flush();
  t.mock.timers.tick(500); await flush();
  assert.equal(calls.length, 3);
  calls[2].task.resolve(response());
  t.mock.timers.tick(2499); await flush();
  assert.equal(calls.length, 3);
  t.mock.timers.tick(1); await flush();
  assert.equal(calls.length, 4);
  calls[3].task.resolve(response());
  await prepared;
});

test('cancel during retry backoff prevents the next network request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { buffer, calls } = fixture(t, { manualFetch: true });
  const prepared = buffer.prepare(deck(1), { mode: 'fixed' });
  calls[0].task.resolve(new Response('', { status: 503 })); await flush();
  buffer.abort();
  await assert.rejects(prepared, { name: 'AbortError' });
  t.mock.timers.tick(100000); await flush();
  assert.equal(calls.length, 1);
});

test('cancel during the retry request aborts it and a late result never populates the cache', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { buffer, calls, blobs } = fixture(t, { manualFetch: true });
  const prepared = buffer.prepare(deck(1), { mode: 'fixed' });
  calls[0].task.resolve(new Response('', { status: 503 })); await flush();
  t.mock.timers.tick(500); await flush();
  assert.equal(calls.length, 2);
  buffer.abort();
  await assert.rejects(prepared, { name: 'AbortError' });
  assert.equal(calls[1].signal.aborted, true);
  calls[1].task.resolve(response()); await flush();
  assert.equal(blobs.size, 0);
});

test('permanent HTTP failures are not automatically retried', async t => {
  const { buffer, calls } = fixture(t, { manualFetch: true });
  const prepared = buffer.prepare(deck(1), { mode: 'fixed' });
  calls[0].task.resolve(new Response('', { status: 404 }));
  await assert.rejects(prepared, SurfRecordingLoadError);
  assert.equal(calls.length, 1);
});
