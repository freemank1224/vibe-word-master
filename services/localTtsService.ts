/**
 * Browser-side local TTS fallback backed by the vendored tiny-voca runtime
 * (see vendor/tiny-voca/VENDOR-NOTE.md). Used when the MiniMax-backed online
 * pipeline is unavailable, and on demand via the AccountPanel "prefer local
 * TTS" toggle.
 *
 * Strategy:
 * - The ~7.6 MB `tiny-voca-js.gguf` model ships with the app at
 *   /models/tiny-voca-js.gguf and is mirrored into the Cache API on first use,
 *   so later sessions load it without hitting the network.
 * - Synthesized WAVs are session-only Blob URLs: they cannot be persisted to
 *   the localStorage URL cache (`audioCacheManager`), so consumers must treat
 *   `blob:` URLs as ephemeral and never write them to persistent storage.
 * - English only (tiny-voca is a single-language model, voice pinned to M2).
 */

import { createLazyResource } from '../utils/lazyResource.ts';
import { createVocaRuntime, LOCAL_TTS_LANG, type VocaRuntime } from '../vendor/tiny-voca/index.ts';

export const LOCAL_TTS_SOURCE_NAME = 'Local Tiny-Voca TTS';

const MODEL_URL = '/models/tiny-voca-js.gguf';
const MODEL_CACHE_NAME = 'vibe-tts-model';
const PREFERRED_KEY = 'vibe_tts_local_preferred';
/** Session cache cap; each word WAV is ~30–100 KB, so this stays well under control. */
const MAX_SESSION_CACHE = 300;

async function loadVocaRuntime(): Promise<VocaRuntime> {
  const buffer = await loadModelBuffer();
  return createVocaRuntime(buffer);
}

/** Swappable so tests can inject the model without going through fetch(). */
let runtimeLoader: () => Promise<VocaRuntime> = loadVocaRuntime;
let loadRuntime = createLazyResource<VocaRuntime>(() => runtimeLoader());

/** Words that failed synthesis this session (e.g. unpronounceable input) — never retried. */
const failedWords = new Set<string>();
/** word → synthesized WAV Blob, valid for this page session only. */
const sessionCache = new Map<string, Blob>();

const normalizeWord = (word: string): string => word.toLowerCase().trim();

export const isLocalTtsSupportedLang = (lang?: string | null): boolean => {
  const normalized = (lang || 'en').toLowerCase();
  return normalized === LOCAL_TTS_LANG || normalized.startsWith('en');
};

export const isLocalTtsSupported = (): boolean => typeof window !== 'undefined';

async function loadModelBuffer(): Promise<ArrayBuffer> {
  // Cache API mirrors the bundled model so repeat sessions avoid the network.
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(MODEL_CACHE_NAME);
      const hit = await cache.match(MODEL_URL);
      if (hit) {
        try {
          return await hit.arrayBuffer();
        } catch (error) {
          console.warn('[LocalTTS] cached model unreadable — refetching:', error);
          await cache.delete(MODEL_URL);
        }
      }
      const bytes = await fetchAndValidateModel();
      try {
        await cache.put(MODEL_URL, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
      } catch (error) {
        // Quota/private-mode failures must not break synthesis — model is bundled anyway.
        console.warn('[LocalTTS] could not cache model:', error);
      }
      return bytes;
    } catch (error) {
      if (error instanceof TypeError) throw error; // network/fetch failures propagate
      console.warn('[LocalTTS] Cache API unavailable — fetching directly:', error);
    }
  }
  return fetchAndValidateModel();
}

async function fetchAndValidateModel(): Promise<ArrayBuffer> {
  const response = await fetch(MODEL_URL);
  if (!response.ok) throw new Error(`tiny-voca model fetch failed: HTTP ${response.status}`);
  // createVocaRuntime validates the GGUF signature before we cache the bytes.
  return await response.arrayBuffer();
}

/**
 * Pure synthesis: word → WAV Blob. No browser-only APIs, so it runs in Node
 * tests. Returns null when unsupported (non-English), already-failed, or on
 * any synthesis error.
 */
export const synthesizeLocalWav = async (word: string, lang: string = 'en'): Promise<Blob | null> => {
  if (!isLocalTtsSupportedLang(lang)) return null;
  const key = normalizeWord(word);
  if (!key || failedWords.has(key)) return null;

  const cached = sessionCache.get(key);
  if (cached) {
    // Refresh insertion order for LRU behavior.
    sessionCache.delete(key);
    sessionCache.set(key, cached);
    return cached;
  }

  let runtime: VocaRuntime;
  try {
    runtime = await loadRuntime();
  } catch (error) {
    // Stays retryable: createLazyResource clears its pending promise on failure.
    console.warn('[LocalTTS] runtime unavailable:', error);
    return null;
  }

  try {
    const { ids, stress } = runtime.phonemize(key);
    const audio = runtime.synthesize(ids, stress);
    const blob = new Blob([runtime.toWav(audio)], { type: 'audio/wav' });
    sessionCache.set(key, blob);
    if (sessionCache.size > MAX_SESSION_CACHE) {
      const oldest = sessionCache.keys().next().value;
      if (oldest !== undefined) sessionCache.delete(oldest);
    }
    return blob;
  } catch (error) {
    // Per-word synthesis failures are remembered to avoid repeated work.
    failedWords.add(key);
    console.warn('[LocalTTS] synthesis failed for', JSON.stringify(word), error);
    return null;
  }
};

/**
 * Synthesize `word` and resolve a session-only `blob:` URL of the WAV audio.
 * The URL is created per call from the cached Blob; it is never persisted.
 */
export const synthesizeLocalTts = async (word: string, lang: string = 'en'): Promise<string | null> => {
  if (!isLocalTtsSupported()) return null;
  const blob = await synthesizeLocalWav(word, lang);
  if (!blob) return null;
  try {
    return URL.createObjectURL(blob);
  } catch (error) {
    console.warn('[LocalTTS] could not create blob URL:', error);
    return null;
  }
};

/** True once the model is loaded in this session (used by the settings UI). */
export const isLocalTtsReady = async (): Promise<boolean> => {
  try { await loadRuntime(); return true; } catch { return false; }
};

/** Pre-warm the runtime (e.g. when the user enables the local-TTS toggle). */
export const warmUpLocalTts = (): Promise<boolean> => isLocalTtsReady();

export const isLocalTtsPreferred = (): boolean => {
  try { return localStorage.getItem(PREFERRED_KEY) === 'true'; } catch { return false; }
};

export const setLocalTtsPreferred = (value: boolean): void => {
  try { localStorage.setItem(PREFERRED_KEY, String(value)); } catch { /* storage unavailable */ }
};

/** Test hook: swap the runtime loader (skips fetch/Cache API) between tests. */
export const __setRuntimeLoaderForTests = (loader: () => Promise<VocaRuntime>): void => {
  runtimeLoader = loader;
  // Also drop the cached pending promise so the new loader is actually used.
  loadRuntime = createLazyResource<VocaRuntime>(() => runtimeLoader());
};

/** Test hook: forget session state between tests. */
export const __resetLocalTtsForTests = (): void => {
  failedWords.clear();
  sessionCache.clear();
};
