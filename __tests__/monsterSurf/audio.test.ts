import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { SurfAudio } from '../../features/monster-surf/audio.ts';
import { buildPronunciationCandidates } from '../../services/pronunciationSources.ts';

const project = 'https://mkdxdlsjisqazermmfoe.supabase.co';
const recording = `${project}/storage/v1/object/public/word-audio/sun.mp3`;
const cachedRecording = `${project}/storage/v1/object/public/word-audio/old-sun.mp3`;
const proxy = (word: string) => `${project}/functions/v1/pronunciation?word=${word}&lang=en&uniqueness_mode=strict`;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

interface FixtureOptions {
  useAudio?: boolean;
  resolveSources?: (word: string, audioUrl?: string | null) => readonly string[];
  onSourceReady?: (word: string, url: string) => void;
  resolvePreparedSource?: (word: string, audioUrl?: string | null) => string | null | Promise<string | null>;
}

function fixture(t: TestContext, options: FixtureOptions = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const elements: FakeAudio[] = [];
  const playFailures: Error[] = [];
  class FakeAudio {
    src: string;
    playbackRate = 1;
    preservesPitch = false;
    paused = false;
    onplaying: (() => void) | null = null;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(src: string) { this.src = src; elements.push(this); }
    play() {
      const error = playFailures.shift();
      return error ? Promise.reject(error) : Promise.resolve();
    }
    pause() { this.paused = true; }
    load() {}
    removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  }
  const synth = {
    spoken: [] as unknown[],
    speak(utterance: unknown) { this.spoken.push(utterance); },
    getVoices() { return []; },
    cancel() {},
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true, value: {
      Audio: options.useAudio === false ? undefined : FakeAudio,
      SpeechSynthesisUtterance: class { text: string; constructor(text: string) { this.text = text; } },
      speechSynthesis: synth,
    },
  });
  const audio = new SurfAudio({ resolveSources: options.resolveSources, onSourceReady: options.onSourceReady, resolvePreparedSource: options.resolvePreparedSource });
  t.after(() => {
    audio.destroy();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  return { audio, synth, elements, playFailures };
}

const officialSources = (word: string, audioUrl?: string | null) => buildPronunciationCandidates({
  word, directUrl: audioUrl, supabaseUrl: project,
});

test('stored recording wins over old cache, retains pitch at slow speed, and plays with effects muted', async t => {
  const ready: string[][] = [];
  const { audio, synth, elements } = fixture(t, {
    resolveSources: (word, audioUrl) => buildPronunciationCandidates({
      word, directUrl: audioUrl, cachedUrl: cachedRecording, supabaseUrl: project,
    }),
    onSourceReady: (word, url) => ready.push([word, url]),
  });
  audio.effectsEnabled = false;
  const result = audio.speak('sun', true, recording);
  let resolved = false;
  void result.then(() => { resolved = true; });
  await flush();
  assert.equal(resolved, false, 'play() resolving is not evidence that sound actually started');
  assert.equal(elements[0].src, recording);
  assert.equal(elements[0].playbackRate, 0.72);
  assert.equal(elements[0].preservesPitch, true);
  assert.deepEqual(ready, [], 'do not cache a recording that has not played');
  elements[0].onplaying?.();
  assert.equal(await result, true);
  assert.deepEqual(ready, [['sun', recording]]);
  assert.equal(elements.length, 1);
  assert.equal(synth.spoken.length, 0);
});

test('words with no personal audio_url use the official recording service, even former demo words', async t => {
  const { audio, synth, elements } = fixture(t, { resolveSources: officialSources });
  for (const word of ['ocean', 'dictionary']) {
    const result = audio.speak(word, false, null);
    const element = elements.at(-1)!;
    assert.equal(element.src, proxy(word));
    assert.equal(element.playbackRate, 1);
    assert.equal(element.src.includes('/monster-surf/audio/'), false);
    element.onplaying?.();
    assert.equal(await result, true);
  }
  assert.equal(synth.spoken.length, 0);
});

test('without an injected resolver the player uses only a valid explicit recording, never a demo or TTS', async t => {
  const { audio, synth, elements } = fixture(t);
  assert.equal(await audio.speak('sun'), false);
  assert.equal(await audio.speak('dictionary'), false);
  assert.equal(elements.length, 0);
  const result = audio.speak('sun', false, recording);
  assert.equal(elements[0].src, recording);
  elements[0].onplaying?.();
  assert.equal(await result, true);
  assert.equal(synth.spoken.length, 0);
});

test('failed stored and cached recordings try the official service and never synthesize a substitute', async t => {
  const ready: string[] = [];
  const { audio, synth, elements } = fixture(t, {
    resolveSources: (word, audioUrl) => buildPronunciationCandidates({
      word, directUrl: audioUrl, cachedUrl: cachedRecording, supabaseUrl: project,
    }),
    onSourceReady: (_word, url) => ready.push(url),
  });
  const result = audio.speak('sun', false, recording);
  for (const [index, expected] of [recording, cachedRecording, proxy('sun')].entries()) {
    assert.equal(elements[index].src, expected);
    elements[index].onerror?.();
    await flush();
    assert.equal(elements[index].paused, true);
  }
  assert.equal(await result, false);
  assert.equal(elements.length, 3);
  assert.deepEqual(ready, []);
  assert.equal(synth.spoken.length, 0);
});

test('an unresponsive source times out after eight seconds and a late callback cannot validate it', async t => {
  const ready: string[] = [];
  const { audio, synth, elements } = fixture(t, {
    resolveSources: officialSources,
    onSourceReady: (_word, url) => ready.push(url),
  });
  const result = audio.speak('sun', false, recording);
  const latePlaying = elements[0].onplaying!;
  t.mock.timers.tick(7999);
  assert.equal(elements.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(elements[0].paused, true);
  assert.equal(elements[1].src, proxy('sun'));
  latePlaying();
  assert.deepEqual(ready, []);
  elements[1].onplaying?.();
  assert.equal(await result, true);
  assert.deepEqual(ready, [proxy('sun')]);
  t.mock.timers.tick(20000);
  assert.equal(elements.length, 2);
  assert.equal(synth.spoken.length, 0);
});

test('every timed-out candidate eventually reports failure rather than leaving silent playback pending', async t => {
  const { audio, synth, elements } = fixture(t, { resolveSources: officialSources });
  const result = audio.speak('sun', false, recording);
  t.mock.timers.tick(8000);
  await flush();
  t.mock.timers.tick(8000);
  assert.equal(await result, false);
  assert.equal(elements.length, 2);
  assert.equal(elements.every(element => element.paused), true);
  assert.equal(synth.spoken.length, 0);
});

test('missing HTML audio support reports failure without requesting browser speech', async t => {
  const { audio, synth, elements } = fixture(t, { useAudio: false, resolveSources: officialSources });
  assert.equal(await audio.speak('sun', false, recording), false);
  assert.equal(elements.length, 0);
  assert.equal(synth.spoken.length, 0);
});

test('rapid replay cancels old audio and stale error, end and playing callbacks cannot launch its next source', async t => {
  const ready: string[] = [];
  const { audio, elements } = fixture(t, {
    resolveSources: officialSources,
    onSourceReady: (word) => ready.push(word),
  });
  const old = audio.speak('sun', false, recording);
  const late = [elements[0].onplaying!, elements[0].onerror!, elements[0].onended!];
  const latest = audio.speak('moon');
  assert.equal(await old, false);
  assert.equal(elements[0].paused, true);
  assert.equal(elements[0].src, '');
  late.forEach(callback => callback());
  await flush();
  assert.equal(elements.length, 2);
  assert.equal(elements[1].src, proxy('moon'));
  assert.deepEqual(ready, []);
  elements[1].onplaying?.();
  assert.equal(await latest, true);
  assert.deepEqual(ready, ['moon']);
});

test('pausing during source fallback cancels the current candidate and all subsequent playback', async t => {
  const { audio, synth, elements } = fixture(t, { resolveSources: officialSources });
  const result = audio.speak('sun', false, recording);
  elements[0].onerror?.();
  await flush();
  const late = [elements[1].onplaying!, elements[1].onerror!];
  audio.stopSpeech();
  assert.equal(await result, false);
  assert.equal(elements.every(element => element.paused), true);
  late.forEach(callback => callback());
  t.mock.timers.tick(20000);
  await flush();
  assert.equal(elements.length, 2);
  assert.equal(synth.spoken.length, 0);
});

test('destroy prevents a late failure or a new request from starting more audio', async t => {
  const { audio, synth, elements } = fixture(t, { resolveSources: officialSources });
  const result = audio.speak('sun', false, recording);
  const lateError = elements[0].onerror!;
  audio.destroy();
  lateError();
  t.mock.timers.tick(20000);
  assert.equal(await result, false);
  assert.equal(await audio.speak('moon'), false);
  assert.equal(elements.length, 1);
  assert.equal(elements[0].paused, true);
  assert.equal(synth.spoken.length, 0);
});

test('a rejected play promise advances to the official recording without a synthetic voice', async t => {
  const { audio, synth, elements, playFailures } = fixture(t, { resolveSources: officialSources });
  playFailures.push(new Error('unsupported recording'));
  const result = audio.speak('sun', false, recording);
  await flush();
  assert.equal(elements[0].paused, true);
  assert.equal(elements[1].src, proxy('sun'));
  elements[1].onplaying?.();
  assert.equal(await result, true);
  assert.equal(synth.spoken.length, 0);
});

test('unsafe explicit recording URLs and empty answers do not produce playable sources', async t => {
  const { audio, synth, elements } = fixture(t);
  for (const url of ['javascript:alert(1)', 'data:audio/mpeg;base64,abc', 'file:///tmp/audio.mp3',
    '/monster-surf/audio/sun.m4a', 'https://user:password@example.org/audio.mp3', 'not a URL']) {
    assert.equal(await audio.speak('sun', false, url), false);
  }
  assert.equal(await audio.speak('  ', false, recording), false);
  assert.equal(elements.length, 0);
  assert.equal(synth.spoken.length, 0);
});

test('prepared playback uses only local Blob bytes and never replaces the persistent URL cache with a Blob', async t => {
  const cacheWrites: string[] = [];
  let remoteCalls = 0;
  const { audio, elements, synth } = fixture(t, {
    resolveSources: () => { remoteCalls++; return [recording]; },
    resolvePreparedSource: async () => 'blob:ready-word-recording',
    onSourceReady: (_word, source) => cacheWrites.push(source),
  });
  const result = audio.speak('sun', true, recording);
  await flush();
  assert.equal(elements[0].src, 'blob:ready-word-recording');
  assert.equal(elements[0].playbackRate, 0.72);
  assert.equal(elements[0].preservesPitch, true);
  elements[0].onplaying?.();
  assert.equal(await result, true);
  assert.equal(remoteCalls, 0);
  assert.deepEqual(cacheWrites, []);
  assert.equal(synth.spoken.length, 0);
});

test('failed preparation or decoder playback never falls through to a network load or system speech', async t => {
  let source: string | null = null;
  const { audio, elements, synth } = fixture(t, {
    resolveSources: () => [recording], resolvePreparedSource: () => source,
  });
  assert.equal(await audio.speak('sun'), false);
  source = recording;
  assert.equal(await audio.speak('sun'), false, 'remote URLs are rejected by the prepared-only path');
  source = 'blob:ready-word-recording';
  const result = audio.speak('sun');
  await flush();
  elements[0].onerror?.();
  assert.equal(await result, false);
  assert.equal(elements.length, 1);
  assert.equal(synth.spoken.length, 0);
});

test('pausing while a current recording buffers prevents a late completed download from speaking', async t => {
  let finish!: (source: string) => void;
  const pending = new Promise<string>(resolve => { finish = resolve; });
  const { audio, elements } = fixture(t, { resolvePreparedSource: () => pending });
  const result = audio.speak('sun');
  audio.stopSpeech();
  assert.equal(await result, false);
  finish('blob:late-word-recording');
  await flush();
  assert.equal(elements.length, 0);
});

test('a superseded buffer request cannot interrupt the newer recording', async t => {
  let finish!: (source: string) => void;
  const pending = new Promise<string>(resolve => { finish = resolve; });
  const { audio, elements } = fixture(t, {
    resolvePreparedSource: word => word === 'sun' ? pending : 'blob:moon',
  });
  const old = audio.speak('sun');
  const latest = audio.speak('moon');
  assert.equal(await old, false);
  await flush();
  elements[0].onplaying?.();
  assert.equal(await latest, true);
  finish('blob:sun');
  await flush();
  assert.equal(elements.length, 1);
  assert.equal(elements[0].src, 'blob:moon');
  assert.equal(elements[0].paused, false);
});
