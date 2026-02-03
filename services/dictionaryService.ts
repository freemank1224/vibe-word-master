
export interface DictionaryData {
  phonetic?: string;
  audioUrl?: string;
  definition_en?: string;
}

/**
 * Play word audio using Web Speech API (browser built-in TTS)
 * This is a reliable local method that doesn't require external APIs
 */
export const playWordAudio = async (word: string, lang: string = 'en'): Promise<boolean> => {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) {
      console.warn('Speech synthesis not supported');
      resolve(false);
      return;
    }
    
    // Stop any currently speaking synthesis
    window.speechSynthesis.cancel();
    
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = lang === 'en' ? 'en-US' : lang;
    utterance.rate = 0.8; // Slightly slower for clarity
    utterance.volume = 0.8;
    utterance.pitch = 1;
    
    utterance.onend = () => resolve(true);
    utterance.onerror = (e) => {
      console.warn('Speech synthesis error:', e);
      resolve(false);
    };
    
    window.speechSynthesis.speak(utterance);
  });
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
