/**
 * Minimax-backed Pronunciation Service
 *
 * Strategy:
 * 1) localStorage URL cache hit
 * 2) Supabase Edge Function /pronunciation (global dedup + generation)
 * 3) no WebSpeech fallback by default (to avoid low-quality synthetic voice)
 */

import { buildPronunciationCandidates } from './pronunciationSources';
import { audioCacheManager } from './audioCache';
import { WORD_LEARNING_CONFIG } from '../config/wordLearningConfig';

export interface PronunciationSource {
  name: string;
  getAudioUrl: (word: string, lang?: string) => Promise<string | null>;
  priority: number;
}

const audioElementCache = new Map<string, HTMLAudioElement>();
let currentPlayingKey: string | null = null;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isSupabasePronunciationUrl = (url: string): boolean => {
  return /https:\/\/[^.]+\.supabase\.co\/functions\/v1\/pronunciation\?/.test(url);
};

const appendRetryQuery = (url: string, attempt: number): string => {
  if (attempt <= 0) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}_retry=${attempt}&_ts=${Date.now()}`;
};

const stripTransientQueryParams = (url: string): string => {
  return url
    .replace(/([?&])_retry=\d+(&)?/g, (match, prefix, suffix) => (suffix ? prefix : ''))
    .replace(/([?&])_ts=\d+(&)?/g, (match, prefix, suffix) => (suffix ? prefix : ''))
    .replace(/[?&]$/, '');
};

const switchToRelaxedUniquenessMode = (url: string): string => {
  if (!url.includes('uniqueness_mode=strict')) return url;
  return url.replace('uniqueness_mode=strict', 'uniqueness_mode=relaxed');
};

const getSupabaseUrl = (): string | null => {
  // process.env.SUPABASE_URL is statically replaced by vite.config.ts `define` at build time.
  const url = process.env.SUPABASE_URL || '';
  if (url) return url;
  // localStorage cache as last resort (populated elsewhere if needed)
  if (typeof window !== 'undefined') {
    const cached = localStorage.getItem('vibe_supabase_url');
    if (cached) return cached;
  }
  return null;
};

/** Shared recording lookup for lessons and cancellable game players. */
export const getRecordedPronunciationUrls = (word: string, directUrl?: string | null, lang = 'en'): string[] => {
  let cachedUrl: string | null = null;
  try { cachedUrl = audioCacheManager.get(word, lang); } catch { /* Optional persistent cache. */ }
  return buildPronunciationCandidates({ word, lang, directUrl, cachedUrl,
    supabaseUrl: getSupabaseUrl(), uniquenessMode: WORD_LEARNING_CONFIG.pronunciation.uniquenessMode });
};

export const rememberRecordedPronunciation = (word: string, url: string, lang = 'en'): void => {
  audioCacheManager.set(word, lang, stripTransientQueryParams(url), 'Project pronunciation recording');
};

const supabaseProxySource: PronunciationSource = {
  name: 'Supabase Minimax Proxy',
  priority: 0,
  getAudioUrl: async (word: string, lang: string = 'en') => {
    const supabaseUrl = getSupabaseUrl();
    if (!supabaseUrl) return null;

    const match = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/);
    if (!match) return null;

    const projectId = match[1];
    const normalizedWord = word.toLowerCase().trim();
    const uniquenessMode = WORD_LEARNING_CONFIG.pronunciation.uniquenessMode;
    return `https://${projectId}.supabase.co/functions/v1/pronunciation?word=${encodeURIComponent(normalizedWord)}&lang=${encodeURIComponent(lang)}&uniqueness_mode=${encodeURIComponent(uniquenessMode)}`;
  }
};

const webSpeechFallback: PronunciationSource = {
  name: 'Browser TTS Fallback',
  priority: 999,
  getAudioUrl: async () => null,
};

const sources: PronunciationSource[] = [supabaseProxySource, webSpeechFallback];

const playAudioFromUrl = async (url: string, cacheKey: string, word: string): Promise<boolean> => {
  return new Promise((resolve) => {
    try {
      let audio: HTMLAudioElement;
      const cachedAudio = audioElementCache.get(cacheKey);

      if (cachedAudio && cachedAudio.src === url) {
        audio = cachedAudio;
      } else {
        audio = new Audio(url);
        // No crossOrigin: word audio is plain playback (no Web Audio analysis),
        // and Storage CDN URLs are served without CORS headers. Setting
        // crossOrigin='anonymous' here would make direct-Storage loads fail.
        audioElementCache.set(cacheKey, audio);
      }

      let resolved = false;
      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          audio.removeEventListener('ended', onEnded);
          audio.removeEventListener('error', onError);
          audio.removeEventListener('abort', onAbort);
        }
      };

      const onEnded = () => {
        cleanup();
        currentPlayingKey = null;
        resolve(true);
      };

      const onError = () => {
        cleanup();
        currentPlayingKey = null;
        resolve(false);
      };

      const onAbort = () => {
        cleanup();
        currentPlayingKey = null;
        resolve(false);
      };

      audio.addEventListener('ended', onEnded);
      audio.addEventListener('error', onError);
      audio.addEventListener('abort', onAbort);

      currentPlayingKey = cacheKey;
      audio.currentTime = 0;
      const playPromise = audio.play();
      if (playPromise) {
        playPromise.catch(() => {
          cleanup();
          currentPlayingKey = null;
          resolve(false);
        });
      }
    } catch {
      resolve(false);
    }
  });
};

const playAudioWithResilience = async (url: string, cacheKey: string, word: string): Promise<{ success: boolean; playedUrl: string }> => {
  const isSupabaseUrl = isSupabasePronunciationUrl(url);
  const maxAttempts = isSupabaseUrl ? 2 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const attemptUrl = appendRetryQuery(url, attempt);
    const success = await playAudioFromUrl(attemptUrl, cacheKey, word);
    if (success) {
      return { success: true, playedUrl: attemptUrl };
    }
    if (attempt < maxAttempts - 1) {
      await wait(200 * (attempt + 1));
    }
  }

  if (isSupabaseUrl && url.includes('uniqueness_mode=strict')) {
    const relaxedUrl = switchToRelaxedUniquenessMode(url);
    const relaxedSuccess = await playAudioFromUrl(appendRetryQuery(relaxedUrl, 1), cacheKey, word);
    if (relaxedSuccess) {
      return { success: true, playedUrl: relaxedUrl };
    }
  }

  return { success: false, playedUrl: url };
};

export const stopCurrentAudio = async (): Promise<void> => {
  if (currentPlayingKey) {
    const cachedAudio = audioElementCache.get(currentPlayingKey);
    if (cachedAudio) {
      try {
        cachedAudio.pause();
        cachedAudio.currentTime = 0;
      } catch {
      }
    }
    currentPlayingKey = null;
  }
};

export const playWordPronunciation = async (
  word: string,
  lang: string = 'en',
  preferredSource?: string,
  directUrl?: string | null
): Promise<{ success: boolean; sourceUsed: string }> => {
  const cacheKey = `${word}-${lang}`;
  await stopCurrentAudio();

  const cachedUrl = audioCacheManager.get(word, lang);
  if (cachedUrl) {
    const success = await playAudioFromUrl(cachedUrl, cacheKey, word);
    if (success) return { success: true, sourceUsed: 'Persistent Cache' };
    audioCacheManager.delete(word, lang);
  }

  // Prefer a known direct Storage CDN URL (already-generated asset) — this
  // bypasses the edge function entirely for a true, cacheable download. Only
  // fall through to the edge-function source loop (which generates server-side)
  // if no direct URL is available or it fails to play.
  if (directUrl) {
    const result = await playAudioWithResilience(directUrl, cacheKey, word);
    if (result.success) {
      audioCacheManager.set(word, lang, stripTransientQueryParams(result.playedUrl), 'Storage CDN (direct)');
      return { success: true, sourceUsed: 'Storage CDN (direct)' };
    }
  }

  let sortedSources = [...sources].sort((a, b) => a.priority - b.priority);
  if (preferredSource) {
    const preferred = sortedSources.find(s => s.name === preferredSource);
    if (preferred) {
      sortedSources = [preferred, ...sortedSources.filter(s => s.name !== preferredSource)];
    }
  }

  for (const source of sortedSources) {
    if (source.name === 'Browser TTS Fallback') {
      const success = await playWithWebSpeech(word, lang);
      if (success) {
        return { success: true, sourceUsed: source.name };
      }
      continue;
    }

    const audioUrl = await source.getAudioUrl(word, lang);
    if (!audioUrl) continue;
    const result = await playAudioWithResilience(audioUrl, cacheKey, word);
    if (result.success) {
      audioCacheManager.set(word, lang, stripTransientQueryParams(result.playedUrl), source.name);
      return { success: true, sourceUsed: source.name };
    }
  }

  return { success: false, sourceUsed: 'None' };
};

const playWithWebSpeech = async (word: string, lang: string): Promise<boolean> => {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      resolve(false);
      return;
    }

    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(word);
      utterance.lang = lang === 'en-GB' ? 'en-GB' : 'en-US';
      utterance.rate = 0.9;
      utterance.pitch = 1;
      utterance.volume = 1;
      utterance.onend = () => resolve(true);
      utterance.onerror = () => resolve(false);
      window.speechSynthesis.speak(utterance);
    } catch {
      resolve(false);
    }
  });
};

export const preloadAudio = async (word: string, lang: string = 'en'): Promise<boolean> => {
  const cacheKey = `${word}-${lang}`;

  const cachedUrl = audioCacheManager.get(word, lang);
  if (cachedUrl) {
    const audio = new Audio(cachedUrl);
    audio.preload = 'auto';
    audioElementCache.set(cacheKey, audio);
    return true;
  }

  const source = sources[0];
  const url = await source.getAudioUrl(word, lang);
  if (!url) return false;

  const audio = new Audio(url);
  audio.preload = 'auto';
  audioElementCache.set(cacheKey, audio);
  audioCacheManager.set(word, lang, url, source.name);
  return true;
};

/**
 * Robustly preload a word's pronunciation so it plays with ZERO network at test time.
 *
 * Unlike `preloadAudio` above (which returns immediately without confirming the bytes
 * actually arrived), this awaits a real media event (loadeddata/canplaythrough), with a
 * timeout. Only on confirmed success does it warm `audioElementCache` + `audioCacheManager`,
 * so a later `playWordPronunciation` → `playAudioFromUrl` reuses the warmed <audio> element
 * (same src) and never hits the network.
 *
 * Mirrors playWordPronunciation's self-heal: if a persistently-cached URL fails to load,
 * that entry is evicted so play-time rebuilds it fresh (and play-time resilience retries).
 */
// Load a single URL into an HTMLAudioElement and resolve only once a real media
// event fires (loadeddata/canplaythrough) or the timeout elapses. Resolves with
// the warmed element on success, null on failure/timeout. No crossOrigin — word
// audio is plain playback and Storage CDN URLs are served without CORS headers.
const loadAudioElement = (url: string, timeoutMs: number): Promise<HTMLAudioElement | null> => {
  return new Promise((resolve) => {
    let settled = false;
    const audio = new Audio();
    audio.preload = 'auto';

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeEventListener('loadeddata', onReady);
      audio.removeEventListener('canplaythrough', onReady);
      audio.removeEventListener('error', onFail);
      audio.removeEventListener('abort', onFail);
      if (!ok) {
        try { audio.removeAttribute('src'); audio.load(); } catch { /* ignore */ }
      }
      resolve(ok ? audio : null);
    };

    const onReady = () => finish(true);
    const onFail = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);

    // Attach listeners BEFORE assigning src so we never miss the event.
    audio.addEventListener('loadeddata', onReady);
    audio.addEventListener('canplaythrough', onReady);
    audio.addEventListener('error', onFail);
    audio.addEventListener('abort', onFail);

    audio.src = url;

    // Some browsers sync-ready already-cached resources without firing an event.
    if (audio.readyState >= 2) {
      finish(true);
    }
  });
};

export const preloadWordAudio = async (
  word: string,
  lang: string = 'en',
  timeoutMs: number = 8000,
  directUrl?: string | null
): Promise<boolean> => {
  const cacheKey = `${word}-${lang}`;

  // Already warmed and ready — nothing to do.
  const existing = audioElementCache.get(cacheKey);
  if (existing && existing.readyState >= 2) {
    return true;
  }

  // Build candidate URLs in priority order:
  //   1. The word's known direct Storage CDN URL (word.audio_url) — a true,
  //      cacheable download that BYPASSES the edge function entirely.
  //   2. The persistent URL cache (may be a direct or edge URL from prior use).
  //   3. The edge-function URL — generates+caches server-side if the asset
  //      isn't ready yet. Always tried last so a stale direct/cache URL can't
  //      cause a preload failure the edge function could have recovered.
  const persistentUrl = audioCacheManager.get(word, lang);
  const candidates = getRecordedPronunciationUrls(word, directUrl, lang);
  if (candidates.length === 0) return false;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const fromDirect = i === 0 && !!directUrl;
    const audio = await loadAudioElement(stripTransientQueryParams(candidate), timeoutMs);
    if (audio) {
      audioElementCache.set(cacheKey, audio);
      audioCacheManager.set(
        word,
        lang,
        stripTransientQueryParams(candidate),
        fromDirect ? 'Storage CDN (direct)' : 'Supabase Minimax Proxy'
      );
      return true;
    }
    // This candidate failed. If it was the persistent cache URL, evict it so a
    // later play-time call doesn't reuse a known-bad URL. Direct/edge URLs are
    // not eviction candidates (we don't own their lifecycle here).
    if (candidate === persistentUrl) {
      audioCacheManager.delete(word, lang);
    }
  }
  return false;
};

export const clearAudioCache = (): void => {
  audioElementCache.forEach((audio) => {
    try {
      audio.pause();
      audio.src = '';
    } catch {
    }
  });
  audioElementCache.clear();
  // 保留持久缓存，不再在测试结束时清空
};

export const getAvailableSources = (): PronunciationSource[] => {
  return sources.map(s => ({ name: s.name, priority: s.priority, getAudioUrl: s.getAudioUrl }));
};

export const playWordAudio = async (word: string, lang: string = 'en'): Promise<boolean> => {
  const result = await playWordPronunciation(word, lang);
  return result.success;
};

export const initializeService = (): void => {
  const supabaseUrl = getSupabaseUrl();
  if (supabaseUrl) {
    console.log('✅ Pronunciation service initialized with Minimax-backed Supabase proxy');
    console.log(`📡 Proxy URL: ${supabaseUrl}/functions/v1/pronunciation`);
  } else {
    console.warn('⚠️ VITE_SUPABASE_URL not found; pronunciation proxy unavailable');
  }
};

if (typeof window !== 'undefined') {
  initializeService();
}
