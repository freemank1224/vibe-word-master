
export interface DictionaryData {
  phonetic?: string;
  audioUrl?: string;
  definition_en?: string;
}

/**
 * Play word audio using Web Speech API (browser built-in TTS)
 * This is the most reliable method as it doesn't require external APIs
 */
export const playWordWithSpeechSynthesis = (word: string, lang: string = 'en'): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (!window.speechSynthesis) {
      reject(new Error('Speech synthesis not supported'));
      return;
    }
    
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = lang === 'en' ? 'en-US' : lang;
    utterance.rate = 0.9; // Slightly slower for clarity
    utterance.pitch = 1;
    
    utterance.onend = () => resolve();
    utterance.onerror = (e) => reject(e);
    
    window.speechSynthesis.speak(utterance);
  });
};

/**
 * Try to play audio from a URL, returns true if successful
 */
const tryPlayAudioUrl = async (url: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    
    const timeout = setTimeout(() => {
      audio.pause();
      audio.src = '';
      resolve(false);
    }, 3000); // 3 second timeout
    
    audio.oncanplaythrough = () => {
      clearTimeout(timeout);
      audio.play()
        .then(() => {
          audio.onended = () => resolve(true);
        })
        .catch(() => resolve(false));
    };
    
    audio.onerror = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    
    audio.src = url;
    audio.load();
  });
};

/**
 * Get audio URLs from dictionary API phonetics
 */
const getAudioUrlsFromPhonetics = (phonetics: any[]): string[] => {
  if (!phonetics || !Array.isArray(phonetics)) return [];
  return phonetics
    .map((p: any) => p.audio)
    .filter((url: string) => url && url.length > 0);
};

/**
 * Play word audio with multiple fallback strategies:
 * 1. Dictionary API audio URLs (CORS-friendly)
 * 2. Web Speech API (browser built-in TTS)
 */
export const playWordAudio = async (word: string, lang: string = 'en'): Promise<boolean> => {
  // Strategy 1: Try Dictionary API audio URLs (these are CORS-friendly)
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word.toLowerCase()}`);
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        const audioUrls = getAudioUrlsFromPhonetics(data[0].phonetics);
        for (const url of audioUrls) {
          if (await tryPlayAudioUrl(url)) {
            return true;
          }
        }
      }
    }
  } catch (e) {
    console.warn('Dictionary API audio failed:', e);
  }

  // Strategy 2: Use Web Speech API (always works, no CORS issues)
  try {
    await playWordWithSpeechSynthesis(word, lang);
    return true;
  } catch (e) {
    console.warn('Speech synthesis failed:', e);
  }

  return false;
};

export const fetchDictionaryData = async (word: string, lang: string = 'en'): Promise<DictionaryData | null> => {
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word.toLowerCase()}`);
    
    if (!response.ok) {
      // No audio URL - will use speech synthesis fallback
      return {
        audioUrl: undefined
      };
    }
    
    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) {
      return { audioUrl: undefined };
    }

    const entry = data[0];
    
    // Find phonetic
    let phonetic = entry.phonetic;

    if (!phonetic && entry.phonetics && entry.phonetics.length > 0) {
      const phoneticEntry = entry.phonetics.find((p: any) => p.text && p.text.length > 0);
      if (phoneticEntry) phonetic = phoneticEntry.text;
    }

    // Find audio URL from phonetics (CORS-friendly sources)
    let audioUrl: string | undefined;
    if (entry.phonetics && entry.phonetics.length > 0) {
      const audioEntry = entry.phonetics.find((p: any) => p.audio && p.audio.length > 0);
      if (audioEntry) audioUrl = audioEntry.audio;
    }

    // Find first definition
    let definition_en = '';
    if (entry.meanings && entry.meanings.length > 0) {
      const firstMeaning = entry.meanings[0];
      if (firstMeaning.definitions && firstMeaning.definitions.length > 0) {
        definition_en = firstMeaning.definitions[0].definition;
      }
    }

    return {
      phonetic,
      audioUrl,
      definition_en
    };
  } catch (error) {
    console.error("Error fetching dictionary data:", error);
    return {
      audioUrl: undefined
    };
  }
};
