import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVocaRuntime } from '../../vendor/tiny-voca/index.ts';
import {
  isLocalTtsSupportedLang,
  synthesizeLocalWav,
  synthesizeLocalTts,
  isLocalTtsPreferred,
  setLocalTtsPreferred,
  __setRuntimeLoaderForTests,
  __resetLocalTtsForTests,
} from '../../services/localTtsService.ts';

// Each node --test file runs in its own process, so these file-global shims
// are safe. audioCache.test.ts uses the same localStorage shim pattern.
const values = new Map<string, string>();
const storage: Storage = {
  get length() { return values.size; },
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => { values.set(key, value); },
  removeItem: key => { values.delete(key); },
  clear: () => values.clear(),
  key: index => [...values.keys()][index] ?? null,
};
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
// synthesizeLocalTts gates on the window global and URL.createObjectURL.
Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true });
let blobCounter = 0;
Object.defineProperty(URL, 'createObjectURL', {
  configurable: true,
  value: (blob: Blob) => { void blob; return `blob:mock-${++blobCounter}`; },
});

// Load the real bundled model once; tests assert actual synthesized audio.
const raw = readFileSync('public/models/tiny-voca-js.gguf');
const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const runtime = await createVocaRuntime(buffer);
__setRuntimeLoaderForTests(async () => runtime);

test('tiny-voca is an English-only model', () => {
  assert.equal(isLocalTtsSupportedLang('en'), true);
  assert.equal(isLocalTtsSupportedLang('en-GB'), true);
  assert.equal(isLocalTtsSupportedLang(undefined), true);
  assert.equal(isLocalTtsSupportedLang('zh'), false);
});

test('synthesizes a real mono WAV from the bundled model', async () => {
  __resetLocalTtsForTests();
  const blob = await synthesizeLocalWav('hello');
  assert.ok(blob, 'expected a synthesized WAV blob');
  assert.equal(blob!.type, 'audio/wav');
  const bytes = new Uint8Array(await blob!.arrayBuffer());
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...bytes.slice(8, 12)), 'WAVE');
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  assert.equal(view.getUint16(22, true), 1, 'mono channel');
  assert.equal(view.getUint32(24, true), runtime.sampleRate, 'model sample rate');
  assert.ok(bytes.byteLength > 1000, 'non-trivial audio payload');
});

test('repeat synthesis reuses the session cache across letter cases', async () => {
  __resetLocalTtsForTests();
  const first = await synthesizeLocalWav('bank');
  const second = await synthesizeLocalWav('BANK');
  assert.ok(first && second);
  assert.equal(first, second, 'same Blob instance for the same normalized word');
});

test('non-English languages are refused', async () => {
  assert.equal(await synthesizeLocalWav('hello', 'zh'), null);
});

test('blank input is refused', async () => {
  assert.equal(await synthesizeLocalWav('   '), null);
});

test('unpronounceable input fails gracefully and is not re-attempted', async () => {
  __resetLocalTtsForTests();
  assert.equal(await synthesizeLocalWav('♪♫'), null);
  assert.equal(await synthesizeLocalWav('♪♫'), null, 'second attempt short-circuits');
});

test('synthesizeLocalTts returns a session-only blob URL', async () => {
  __resetLocalTtsForTests();
  const url = await synthesizeLocalTts('ocean');
  assert.ok(url);
  assert.match(url!, /^blob:/);
  const again = await synthesizeLocalTts('ocean');
  assert.match(again!, /^blob:/);
});

test('runtime load failure keeps words retryable', async () => {
  __resetLocalTtsForTests();
  __setRuntimeLoaderForTests(async () => { throw new Error('model missing'); });
  assert.equal(await synthesizeLocalWav('river'), null, 'no crash while the runtime is unavailable');
  __setRuntimeLoaderForTests(async () => runtime);
  assert.ok(await synthesizeLocalWav('river'), 'recovers once the runtime loads');
});

test('preferred toggle persists through localStorage', () => {
  setLocalTtsPreferred(true);
  assert.equal(isLocalTtsPreferred(), true);
  assert.equal(values.get('vibe_tts_local_preferred'), 'true');
  setLocalTtsPreferred(false);
  assert.equal(isLocalTtsPreferred(), false);
  assert.equal(values.get('vibe_tts_local_preferred'), 'false');
});
