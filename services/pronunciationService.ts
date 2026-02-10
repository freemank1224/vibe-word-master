/**
 * Multi-source Pronunciation Service (China-Accessible + CORS-Safe)
 * Provides high-quality word pronunciation with automatic fallback
 *
 * Production deployment strategy:
 * 1. Try persistent cache (localStorage) - INSTANT
 * 2. Try Supabase Edge Function proxy (bypasses CORS)
 * 3. Fallback to direct API access (may work locally)
 * 4. Final fallback to browser TTS
 */

import { audioCacheManager } from './audioCache';

export interface PronunciationSource {
  name: string;
  getAudioUrl: (word: string, lang?: string) => Promise<string | null>;
  priority: number;
}

/**
 * Get Supabase project URL from environment or storage
 */
const getSupabaseUrl = (): string | null => {
  // Try import.meta.env (Vite)
  if (import.meta.env?.VITE_SUPABASE_URL) {
    return import.meta.env.VITE_SUPABASE_URL;
  }

  // Try window.env (runtime)
  if (typeof window !== 'undefined' && (window as any).env?.VITE_SUPABASE_URL) {
    return (window as any).env.VITE_SUPABASE_URL;
  }

  // Try localStorage (cached)
  if (typeof window !== 'undefined') {
    const cached = localStorage.getItem('vibe_supabase_url');
    if (cached) return cached;
  }

  return null;
};

/**
 * Source 0: Supabase Edge Function Proxy (Production Primary)
 * Bypasses CORS by routing through your own server
 * REQUIRES: Deploy the Edge Function to your Supabase project
 */
const supabaseProxySource: PronunciationSource = {
  name: 'Supabase Proxy',
  priority: 0, // Highest priority
  getAudioUrl: async (word: string, lang: string = 'en') => {
    try {
      const supabaseUrl = getSupabaseUrl();
      if (!supabaseUrl) {
        console.warn('⚠️ Supabase URL not configured, skipping proxy');
        return null;
      }

      // Extract project URL from https://xxxxx.supabase.co
      const match = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/);
      if (!match) {
        console.warn('⚠️ Invalid Supabase URL format');
        return null;
      }

      const projectId = match[1];
      const normalizedWord = word.toLowerCase().trim();

      // Build Edge Function URL
      const source = 'youdao'; // Use youdao as default via proxy
      const functionUrl = `https://${projectId}.supabase.co/functions/v1/pronunciation?word=${encodeURIComponent(normalizedWord)}&source=${source}&lang=${lang}`;

      return functionUrl;
    } catch (error) {
      console.warn('⚠️ Supabase proxy URL generation failed:', error);
      return null;
    }
  }
};

/**
 * Source 1: 有道词典 (Youdao Dictionary) - Direct Access
 * Most reliable for users in China, free, no API key required
 * Type 1 = UK English, Type 2 = US English
 * NOTE: May fail in production due to CORS (use proxy instead)
 */
const youdaoSource: PronunciationSource = {
  name: 'Youdao Dictionary (CN)',
  priority: 1,
  getAudioUrl: async (word: string, lang: string = 'en') => {
    try {
      const normalizedWord = word.toLowerCase().trim();
      // Type 2 = US English (default), Type 1 = UK English
      const type = (lang === 'en-GB') ? '1' : '2';
      return `https://dict.youdao.com/dictvoice?type=${type}&audio=${encodeURIComponent(normalizedWord)}`;
    } catch {
      return null;
    }
  }
};

/**
 * Source 2: 金山词霸 (iCiba) - Direct Access
 * Popular dictionary in China, free access
 */
const icibaSource: PronunciationSource = {
  name: 'iCiba Dictionary (CN)',
  priority: 2,
  getAudioUrl: async (word: string, lang: string = 'en') => {
    try {
      const normalizedWord = word.toLowerCase().trim();
      // iCiba uses different URLs for US/UK pronunciation
      if (lang === 'en-GB') {
        return `https://res.iciba.com/resource/amp3/oxford/${normalizedWord}.mp3`;
      }
      return `https://res.iciba.com/resource/amp3/${normalizedWord}.mp3`;
    } catch {
      return null;
    }
  }
};

/**
 * Source 3: 海词词典 (Dict.cn) - Direct Access
 * Another China-accessible dictionary service
 */
const dictCnSource: PronunciationSource = {
  name: 'Dict.cn (CN)',
  priority: 3,
  getAudioUrl: async (word: string, lang: string = 'en') => {
    try {
      const normalizedWord = word.toLowerCase().trim();
      return `https://mp3.dict.cn/mp3/${normalizedWord}.mp3`;
    } catch {
      return null;
    }
  }
};

/**
 * Source 4: 中国教育在线发音 - Direct Access
 * Educational resource with pronunciation audio
 */
const eduSource: PronunciationSource = {
  name: 'Edu.123听力 (CN)',
  priority: 4,
  getAudioUrl: async (word: string, lang: string = 'en') => {
    try {
      const normalizedWord = word.toLowerCase().trim();
      // Alternative education source
      return `https://d1.jdihitalt0f6y.cloudfront.net/static/audio/${normalizedWord}.mp3`;
    } catch {
      return null;
    }
  }
};

/**
 * Source 5: Vocabulary.com (with CDN check)
 * May work from China, has high-quality human pronunciations
 */
const vocabularySource: PronunciationSource = {
  name: 'Vocabulary.com',
  priority: 5,
  getAudioUrl: async (word: string, lang: string = 'en') => {
    try {
      if (lang !== 'en' && lang !== 'en-US') return null;
      const normalizedWord = word.toLowerCase().trim();
      return `https://static.vocab.com/audio/pron/${normalizedWord}.mp3`;
    } catch {
      return null;
    }
  }
};

/**
 * Source 6: Web Speech API with optimized voice selection (Fallback)
 * Uses browser built-in TTS with voice optimization
 */
const webSpeechFallback: PronunciationSource = {
  name: 'Browser TTS (Optimized)',
  priority: 999,
  getAudioUrl: async () => {
    return null; // Indicates to use speech synthesis
  }
};

// All sources sorted by priority
const sources: PronunciationSource[] = [
  supabaseProxySource,
  youdaoSource,
  icibaSource,
  dictCnSource,
  eduSource,
  vocabularySource,
  webSpeechFallback
];

/**
 * Audio element cache to prevent re-creating HTMLAudioElements
 * Stores the actual audio instances (separate from URL cache)
 */
const audioElementCache = new Map<string, HTMLAudioElement>();

/**
 * Current playing audio for cleanup
 */
let currentPlayingKey: string | null = null;

/**
 * Play word pronunciation using the best available source
 * Automatically tries the next source if one fails
 */
export const playWordPronunciation = async (
  word: string,
  lang: string = 'en',
  preferredSource?: string
): Promise<{ success: boolean; sourceUsed: string }> => {
  const cacheKey = `${word}-${lang}`;

  // Stop any currently playing audio
  await stopCurrentAudio();

  // Check persistent cache first (instant playback)
  console.log(`🔍 Checking persistent cache for "${word}"...`);
  const cachedUrl = audioCacheManager.get(word, lang);
  if (cachedUrl) {
    console.log(`🎯 Persistent cache hit for "${word}": ${cachedUrl}`);
    const success = await playAudioFromUrl(cachedUrl, cacheKey, word);
    if (success) {
      return { success: true, sourceUsed: 'Persistent Cache' };
    }
    // Cache URL is invalid, remove it
    audioCacheManager.delete(word, lang);
    console.warn(`⚠️ Persistent cache URL expired for "${word}", re-fetching...`);
  } else {
    console.log(`❌ No persistent cache found for "${word}"`);
  }

  // Sort sources by priority, but prioritize preferred source if specified
  let sortedSources = [...sources].sort((a, b) => a.priority - b.priority);
  if (preferredSource) {
    const preferred = sortedSources.find(s => s.name === preferredSource);
    if (preferred) {
      sortedSources = [preferred, ...sortedSources.filter(s => s.name !== preferredSource)];
    }
  }

  // Try each source in order
  for (const source of sortedSources) {
    try {
      console.log(`🔊 Trying source: ${source.name} for "${word}"`);

      // Check if this is the Web Speech API fallback
      if (source.name === 'Browser TTS (Optimized)') {
        const success = await playWithWebSpeech(word, lang);
        if (success) {
          console.log(`✅ Success using: ${source.name}`);
          return { success: true, sourceUsed: source.name };
        }
        console.warn(`❌ Failed: ${source.name}`);
        continue;
      }

      // Get audio URL from source
      const audioUrl = await source.getAudioUrl(word, lang);
      if (!audioUrl) {
        console.warn(`⚠️ No URL from: ${source.name}`);
        continue;
      }

      console.log(`🌐 URL: ${audioUrl}`);

      // Try to play audio from URL
      const success = await playAudioFromUrl(audioUrl, cacheKey, word);
      console.log(`📢 playAudioFromUrl returned: ${success}`);
      if (success) {
        console.log(`✅ Success using: ${source.name}`);

        // Save to persistent cache for future instant playback
        console.log(`💾 Saving to cache: word="${word}", lang="${lang}", url="${audioUrl}", source="${source.name}"`);
        audioCacheManager.set(word, lang, audioUrl, source.name);
        console.log(`💾 Cached URL for "${word}" from ${source.name}`);

        // Verify cache was saved
        const verifyCache = audioCacheManager.get(word, lang);
        console.log(`✅ Cache verification: ${verifyCache ? 'SAVED' : 'FAILED'}`);

        return { success: true, sourceUsed: source.name };
      }

      console.warn(`❌ Playback failed for: ${source.name}`);
    } catch (error) {
      console.warn(`❌ Source ${source.name} error:`, error);
      continue;
    }
  }

  console.error(`❌ All sources failed for "${word}"`);
  return { success: false, sourceUsed: 'None' };
};

/**
 * Play audio from URL with caching and error handling
 */
const playAudioFromUrl = async (
  url: string,
  cacheKey: string,
  word: string
): Promise<boolean> => {
  return new Promise((resolve) => {
    try {
      // Check audio element cache (separate from persistent URL cache)
      let audio: HTMLAudioElement;
      const cachedAudio = audioElementCache.get(cacheKey);

      if (cachedAudio && cachedAudio.src === url) {
        audio = cachedAudio;
        console.log(`♻️ Using cached audio element for "${word}"`);
      } else {
        audio = new Audio(url);
        // Enable CORS for audio
        audio.crossOrigin = 'anonymous';
        audioElementCache.set(cacheKey, audio);
        console.log(`🆕 Creating new audio element for "${word}"`);
      }

      // Set up event handlers
      let resolved = false;

      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          audio.removeEventListener('canplay', onCanPlay);
          audio.removeEventListener('ended', onEnded);
          audio.removeEventListener('error', onError);
          audio.removeEventListener('abort', onAbort);
        }
      };

      const onCanPlay = () => {
        console.log(`🎵 Audio ready to play for "${word}"`);
      };

      const onEnded = () => {
        console.log(`✅ Playback completed for "${word}"`);
        cleanup();
        currentPlayingKey = null;
        resolve(true);
      };

      const onError = (e: Event) => {
        console.error(`❌ Audio error for "${word}":`, e);
        cleanup();
        currentPlayingKey = null;
        resolve(false);
      };

      const onAbort = () => {
        console.warn(`⚠️ Audio aborted for "${word}"`);
        cleanup();
        currentPlayingKey = null;
        resolve(false);
      };

      audio.addEventListener('canplay', onCanPlay, { once: true });
      audio.addEventListener('ended', onEnded);
      audio.addEventListener('error', onError);
      audio.addEventListener('abort', onAbort);

      // Play audio
      currentPlayingKey = cacheKey;
      audio.currentTime = 0;

      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            console.log(`▶️ Playing audio for "${word}"`);
          })
          .catch((err) => {
            console.error(`❌ Play failed for "${word}":`, err);
            cleanup();
            currentPlayingKey = null;
            resolve(false);
          });
      }
    } catch (error) {
      console.error(`❌ Audio creation error for "${word}":`, error);
      resolve(false);
    }
  });
};

/**
 * Play using Web Speech API with optimized voice selection (fallback)
 */
const playWithWebSpeech = async (word: string, lang: string): Promise<boolean> => {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) {
      resolve(false);
      return;
    }

    try {
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(word);

      // Set language
      utterance.lang = lang === 'en-GB' ? 'en-GB' : 'en-US';
      utterance.rate = 0.85; // Slightly slower for clarity
      utterance.volume = 1.0;
      utterance.pitch = 1.0;

      // Try to get the best available voice
      const voices = window.speechSynthesis.getVoices();
      if (voices && voices.length > 0) {
        // Prefer high-quality English voices
        const preferredVoices = voices.filter(v =>
          v.lang.startsWith('en') &&
          (v.name.includes('Google') || v.name.includes('Microsoft') || v.name.includes('Natural'))
        );

        if (preferredVoices.length > 0) {
          // Use the first preferred voice
          utterance.voice = preferredVoices[0];
          console.log(`🎤 Using voice: ${utterance.voice.name}`);
        }
      }

      utterance.onend = () => {
        console.log(`✅ Web Speech API completed for "${word}"`);
        resolve(true);
      };

      utterance.onerror = (e) => {
        console.error(`❌ Web Speech API error for "${word}":`, e);
        resolve(false);
      };

      window.speechSynthesis.speak(utterance);
    } catch (error) {
      console.error(`❌ Web Speech API initialization error:`, error);
      resolve(false);
    }
  });
};

/**
 * Stop currently playing audio
 */
export const stopCurrentAudio = async (): Promise<void> => {
  // Stop HTML audio
  if (currentPlayingKey) {
    const cachedAudio = audioElementCache.get(currentPlayingKey);
    if (cachedAudio) {
      try {
        cachedAudio.pause();
        cachedAudio.currentTime = 0;
        console.log('⏸️ Stopped audio playback');
      } catch (e) {
        console.warn('⚠️ Error stopping audio:', e);
      }
    }
    currentPlayingKey = null;
  }

  // Stop speech synthesis
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
    console.log('⏸️ Cancelled speech synthesis');
  }
};

/**
 * Get available pronunciation sources
 */
export const getAvailableSources = (): PronunciationSource[] => {
  return sources.map(s => ({
    name: s.name,
    priority: s.priority,
    getAudioUrl: s.getAudioUrl
  }));
};

/**
 * Clear audio cache (useful for memory management)
 */
export const clearAudioCache = (): void => {
  // Clear audio element cache (memory)
  audioElementCache.forEach((audio) => {
    try {
      audio.pause();
      audio.src = '';
    } catch (e) {
      // Ignore errors
    }
  });
  audioElementCache.clear();

  // Clear persistent URL cache (localStorage)
  audioCacheManager.clear();

  console.log('🗑️ Cleared all audio caches (memory + persistent)');
};

/**
 * Preload audio for a word (optional optimization)
 */
export const preloadAudio = async (word: string, lang: string = 'en'): Promise<boolean> => {
  const cacheKey = `${word}-${lang}`;

  // Try to preload from the first available source
  for (const source of sources.slice(0, -1)) { // Exclude fallback
    try {
      const url = await source.getAudioUrl(word, lang);
      if (!url) continue;

      const audio = new Audio(url);
      audio.crossOrigin = 'anonymous';
      audio.preload = 'auto';
      audioElementCache.set(cacheKey, audio);
      console.log(`📥 Preloaded audio for "${word}" from ${source.name}`);

      // Also save to persistent cache
      audioCacheManager.set(word, lang, url, source.name);

      return true;
    } catch (error) {
      console.warn(`⚠️ Preload failed from ${source.name}:`, error);
      continue;
    }
  }

  return false;
};

/**
 * Legacy compatibility: Play word audio (backward compatible with old API)
 */
export const playWordAudio = async (word: string, lang: string = 'en'): Promise<boolean> => {
  const result = await playWordPronunciation(word, lang);
  return result.success;
};

/**
 * Initialize service (load voices, etc.)
 */
export const initializeService = (): void => {
  if (window.speechSynthesis) {
    // Trigger voice loading (Chrome requires this)
    window.speechSynthesis.getVoices();

    // Listen for voices loaded
    window.speechSynthesis.onvoiceschanged = () => {
      const voices = window.speechSynthesis.getVoices();
      console.log(`🎤 Loaded ${voices.length} voices for Web Speech API`);
    };
  }

  // Check if Supabase proxy is available
  const supabaseUrl = getSupabaseUrl();
  if (supabaseUrl) {
    console.log('✅ Pronunciation service initialized with Supabase proxy support');
    console.log(`📡 Proxy URL: ${supabaseUrl}/functions/v1/pronunciation`);
  } else {
    console.log('⚠️ Supabase URL not found, will use direct API access (may fail in production)');
    console.log('💡 To fix: Ensure VITE_SUPABASE_URL is set in .env file');
  }

  console.log('🌐 Available pronunciation sources:');
  sources.forEach(s => {
    console.log(`   ${s.priority}. ${s.name}`);
  });
};

// Auto-initialize on load
if (typeof window !== 'undefined') {
  initializeService();
}
