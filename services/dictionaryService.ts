
export interface DictionaryData {
  phonetic?: string;
  audioUrl?: string;
  definition_en?: string;
}

/**
 * Play word audio using enhanced pronunciation service
 * Uses multiple high-quality sources with automatic fallback:
 * 1. Google Translate TTS (Natural AI voices)
 * 2. Cambridge Dictionary (Human recordings)
 * 3. DictionaryAPI.dev (Mixed sources)
 * 4. Youdao Dictionary (Alternative)
 * 5. Web Speech API (System fallback)
 */
export const playWordAudio = async (word: string, lang: string = 'en'): Promise<boolean> => {
  try {
    const { playWordPronunciation } = await import('./pronunciationService');
    const result = await playWordPronunciation(word, lang);
    console.log(`Pronunciation played using: ${result.sourceUsed}`);
    return result.success;
  } catch (error) {
    console.error('Pronunciation service error:', error);
    // Fallback to Web Speech API if service fails to load
    if (!window.speechSynthesis) {
      return false;
    }
    return new Promise((resolve) => {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(word);
      utterance.lang = lang === 'en' ? 'en-US' : lang;
      utterance.rate = 0.8;
      utterance.volume = 0.8;
      utterance.pitch = 1;
      utterance.onend = () => resolve(true);
      utterance.onerror = () => resolve(false);
      window.speechSynthesis.speak(utterance);
    });
  }
};

export const fetchDictionaryData = async (word: string, lang: string = 'en'): Promise<DictionaryData | null> => {
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word.toLowerCase()}`);
    
    if (!response.ok) {
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
      audioUrl: undefined, // 不再提供音频 URL，使用本地 TTS
      definition_en
    };
  } catch (error) {
    console.error("Error fetching dictionary data:", error);
    return {
      audioUrl: undefined
    };
  }
};
