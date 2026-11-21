import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VocaRuntime } from '../../vendor/tiny-voca/index.ts';
import {
  LOCAL_TTS_SOURCE_NAME,
  __setRuntimeLoaderForTests,
  __resetLocalTtsForTests,
} from '../../services/localTtsService.ts';

// Shims must exist before the service modules load (each test file runs in
// its own node --test process, so file-global shims cannot leak elsewhere).
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

// The edge-function URL is normally resolved from build-time env; force the
// localStorage fallback so the test controls it deterministically.
delete process.env.SUPABASE_URL;
const PROJECT = 'https://mkdxdlsjisqazermmfoe.supabase.co';
const proxyUrl = (word: string) =>
  `${PROJECT}/functions/v1/pronunciation?word=${word}&lang=en&uniqueness_mode=strict`;

type Handler = () => void;
/**
 * FakeAudio simulates the two <audio> consumption paths in the service:
 * playAudioFromUrl (constructor src + play()/ended) and loadAudioElement
 * (src assignment + canplaythrough/error). `failHttp` models MiniMax being
 * unreachable: http(s) sources always fail, blob: sources (tiny-voca) play.
 */
class FakeAudio {
  private handlers = new Map<string, Set<Handler>>();
  readyState = 0;
  currentTime = 0;
  playbackRate = 1;
  preservesPitch = false;
  paused = true;
  private _src = '';
  private failHttp: boolean;
  constructor(src: string | undefined, failHttp: boolean, registry: FakeAudio[]) {
    this.failHttp = failHttp;
    registry.push(this);
    if (src) this.src = src;
  }
  get src() { return this._src; }
  set src(value: string) {
    this._src = value;
    if (!value) return;
    const failed = this.failHttp && value.startsWith('http');
    queueMicrotask(() => this.emit(failed ? 'error' : 'canplaythrough'));
  }
  addEventListener(type: string, fn: Handler) {
    const set = this.handlers.get(type) ?? new Set<Handler>();
    set.add(fn);
    this.handlers.set(type, set);
  }
  removeEventListener(type: string, fn: Handler) { this.handlers.get(type)?.delete(fn); }
  private emit(type: string) { for (const fn of [...(this.handlers.get(type) ?? [])]) fn(); }
  play() {
    this.paused = false;
    const failed = this.failHttp && this._src.startsWith('http');
    queueMicrotask(() => this.emit(failed ? 'error' : 'ended'));
    return Promise.resolve();
  }
  pause() { this.paused = true; }
  load() { /* noop */ }
  removeAttribute(name: string) { if (name === 'src') this._src = ''; }
}

interface FixtureOptions { failHttp?: boolean; localTtsPreferred?: boolean; }
async function fixture(options: FixtureOptions = {}) {
  const elements: FakeAudio[] = [];
  const AudioCtor = class extends FakeAudio {
    constructor(src?: string) { super(src, options.failHttp ?? true, elements); }
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      Audio: AudioCtor,
      SpeechSynthesisUtterance: class {
        onend: Handler | null = null;
        onerror: Handler | null = null;
        text: string;
        constructor(text: string) { this.text = text; }
      },
      speechSynthesis: {
        speak(utterance: { onend?: Handler | null }) { queueMicrotask(() => utterance.onend?.()); },
        cancel() { /* noop */ },
        getVoices() { return []; },
      },
    },
  });
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: AudioCtor });
  Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
    configurable: true,
    value: (globalThis.window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance,
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => { void blob; return `blob:fixture-${elements.length}`; },
  });

  values.clear();
  values.set('vibe_supabase_url', PROJECT);
  values.set('vibe_tts_local_preferred', String(options.localTtsPreferred ?? false));

  // A tiny fake runtime: no model needed to exercise service behavior.
  const fakeRuntime: VocaRuntime = {
    phonemize: () => ({ ids: [1, 2], stress: [0, 1] }),
    synthesize: () => new Float32Array(2400),
    toWav: () => new ArrayBuffer(44 + 2 * 2400),
    sampleRate: 24000,
  };
  __setRuntimeLoaderForTests(async () => fakeRuntime);
  __resetLocalTtsForTests();

  const service = await import('../../services/pronunciationService.ts');
  const localTts = await import('../../services/localTtsService.ts');
  return {
    service,
    localTts,
    elements,
    cachedUrls: () => {
      const raw = values.get('vibe_audio_cache');
      return raw ? JSON.parse(raw) as Record<string, { url: string; source: string }> : {};
    },
  };
}

test('sources expose the tiny-voca fallback between proxy and WebSpeech', async () => {
  const { service } = await fixture();
  const sources = service.getAvailableSources().sort((a, b) => a.priority - b.priority);
  assert.deepEqual(sources.map(s => s.name), [
    'Supabase Minimax Proxy',
    LOCAL_TTS_SOURCE_NAME,
    'Browser TTS Fallback',
  ]);
  assert.ok(sources[0].priority < sources[1].priority && sources[1].priority < sources[2].priority);
});

test('a failing MiniMax pipeline falls through to the local tiny-voca synthesis', async () => {
  const { service } = await fixture({ failHttp: true });
  const result = await service.playWordPronunciation('harbor', 'en');
  assert.equal(result.success, true);
  assert.equal(result.sourceUsed, LOCAL_TTS_SOURCE_NAME);
});

test('blob URLs from the local source are not persisted to the URL cache', async () => {
  const { service, cachedUrls } = await fixture({ failHttp: true });
  await service.playWordPronunciation('meadow', 'en');
  assert.deepEqual(cachedUrls(), {});
});

test('the prefer-local toggle promotes tiny-voca above a healthy MiniMax pipeline', async () => {
  const { service } = await fixture({ failHttp: false, localTtsPreferred: true });
  const result = await service.playWordPronunciation('canyon', 'en');
  assert.equal(result.sourceUsed, LOCAL_TTS_SOURCE_NAME);
});

test('with the toggle off, a healthy MiniMax proxy still wins', async () => {
  const { service, cachedUrls } = await fixture({ failHttp: false, localTtsPreferred: false });
  const result = await service.playWordPronunciation('summit', 'en');
  assert.equal(result.sourceUsed, 'Supabase Minimax Proxy');
  const cached = cachedUrls();
  assert.equal(cached['summit-en']?.source, 'Supabase Minimax Proxy');
});

test('the toggle overrides a known direct MiniMax URL on newly added words', async () => {
  const { service } = await fixture({ failHttp: false, localTtsPreferred: true });
  // A freshly added word gets its MiniMax asset backfilled into words.audio_url;
  // playback must still follow the toggle instead of the direct-URL fast path.
  const result = await service.playWordPronunciation('lagoon', 'en', undefined, `${PROJECT}/storage/v1/object/public/word-audio/lagoon.mp3`);
  assert.equal(result.sourceUsed, LOCAL_TTS_SOURCE_NAME);
});

test('without the toggle, a known direct MiniMax URL still wins', async () => {
  const { service } = await fixture({ failHttp: false, localTtsPreferred: false });
  const result = await service.playWordPronunciation('inlet', 'en', undefined, `${PROJECT}/storage/v1/object/public/word-audio/inlet.mp3`);
  assert.equal(result.sourceUsed, 'Storage CDN (direct)');
});

test('a stale cached MiniMax URL does not preempt the local preference', async () => {
  const { service } = await fixture({ failHttp: false, localTtsPreferred: true });
  values.set('vibe_audio_cache', JSON.stringify({
    'shore-en': { url: `${PROJECT}/storage/v1/object/public/word-audio/shore.mp3`, source: 'Supabase Minimax Proxy', timestamp: Date.now(), expiresAt: Date.now() + 60_000, accessCount: 0 },
  }));
  const result = await service.playWordPronunciation('shore', 'en');
  assert.equal(result.sourceUsed, LOCAL_TTS_SOURCE_NAME);
});

test('with the toggle on, preload synthesizes before network candidates', async () => {
  const { service, elements, cachedUrls } = await fixture({ failHttp: false, localTtsPreferred: true });
  const warmed = await service.preloadWordAudio('bayou', 'en', 8000, `${PROJECT}/storage/v1/object/public/word-audio/bayou.mp3`);
  assert.equal(warmed, true);
  assert.match(elements[0].src, /^blob:/, 'the first warmed element must be the local synthesis');
  assert.deepEqual(cachedUrls(), {}, 'blob URLs stay out of the persistent cache');
});

test('preload falls back to local synthesis when every network candidate fails', async () => {
  const { service, localTts, cachedUrls } = await fixture({ failHttp: true });
  const warmed = await service.preloadWordAudio('ember', 'en', 8000, null);
  assert.equal(warmed, true);
  assert.deepEqual(cachedUrls(), {}, 'offline preload must not persist a session blob URL');
  // The synthesized blob must be available for immediate playback too.
  const url = await localTts.synthesizeLocalTts('ember', 'en');
  assert.match(url!, /^blob:/);
});

test('when local synthesis is unavailable, playback reaches WebSpeech', async () => {
  const { service, localTts } = await fixture({ failHttp: true });
  // Break the runtime loader so tiny-voca yields no audio.
  localTts.__setRuntimeLoaderForTests(async () => { throw new Error('model missing'); });
  const result = await service.playWordPronunciation('glacier', 'en');
  assert.equal(result.success, true);
  assert.equal(result.sourceUsed, 'Browser TTS Fallback');
});
