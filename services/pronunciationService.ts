/**
 * Minimax-backed Pronunciation Service
 *
 * Strategy:
 * 1) localStorage URL cache hit
 * 2) Supabase Edge Function /pronunciation (global dedup + generation)
 * 3) no WebSpeech fallback by default (to avoid low-quality synthetic voice)
 */

import { audioCacheManager } from './audioCache';
import { WORD_LEARNING_CONFIG } from '../config/wordLearningConfig';

export interface PronunciationSource {
  name: string;
  getAudioUrl: (word: string, lang?: string) => Promise<string | null>;
  priority: number;
}

const audioElementCache = new Map<string, HTMLAudioElement>();
let currentPlayingKey: string | null = null;

const getSupabaseUrl = (): string | null => {
  const viteEnv = (import.meta as any)?.env;
  if (viteEnv?.VITE_SUPABASE_URL) {
    return viteEnv.VITE_SUPABASE_URL;
  }
  const processEnv = (process as any)?.env;
  if (processEnv?.SUPABASE_URL) {
    return processEnv.SUPABASE_URL;
  }
  if (typeof window !== 'undefined' && (window as any).env?.VITE_SUPABASE_URL) {
    return (window as any).env.VITE_SUPABASE_URL;
  }
  if (typeof window !== 'undefined') {
    const cached = localStorage.getItem('vibe_supabase_url');
    if (cached) return cached;
  }
  return null;
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
        audio.crossOrigin = 'anonymous';
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
  preferredSource?: string
): Promise<{ success: boolean; sourceUsed: string }> => {
  const cacheKey = `${word}-${lang}`;
  await stopCurrentAudio();

  const cachedUrl = audioCacheManager.get(word, lang);
  if (cachedUrl) {
    const success = await playAudioFromUrl(cachedUrl, cacheKey, word);
    if (success) return { success: true, sourceUsed: 'Persistent Cache' };
    audioCacheManager.delete(word, lang);
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
    const success = await playAudioFromUrl(audioUrl, cacheKey, word);
    if (success) {
      audioCacheManager.set(word, lang, audioUrl, source.name);
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
    audio.crossOrigin = 'anonymous';
    audio.preload = 'auto';
    audioElementCache.set(cacheKey, audio);
    return true;
  }

  const source = sources[0];
  const url = await source.getAudioUrl(word, lang);
  if (!url) return false;

  const audio = new Audio(url);
  audio.crossOrigin = 'anonymous';
  audio.preload = 'auto';
  audioElementCache.set(cacheKey, audio);
  audioCacheManager.set(word, lang, url, source.name);
  return true;
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
