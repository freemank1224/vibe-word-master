
export interface DictionaryData {
  phonetic?: string;
  audioUrl?: string;
  definition_en?: string;
}

/**
 * Get a high-quality standard audio URL for a word.
 * Defaults to Youdao API (US accent for English).
 * @param word The word to get audio for
 * @param lang Language code (default: 'en')
 */
export const getStandardAudioUrl = (word: string, lang: string = 'en'): string => {
  const encodedWord = encodeURIComponent(word.toLowerCase());
  // Youdao API: type=2 (US), type=1 (UK)
  // le parameter: en (English), ja (Japanese), ko (Korean), etc.
  if (lang === 'en') {
    return `https://dict.youdao.com/dictvoice?audio=${encodedWord}&type=2`;
  }
  return `https://dict.youdao.com/dictvoice?audio=${encodedWord}&le=${lang}`;
};

export const fetchDictionaryData = async (word: string, lang: string = 'en'): Promise<DictionaryData | null> => {
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word.toLowerCase()}`);
    
    // We still want the high-quality audio even if dictionary API fails or doesn't have it
    const standardAudioUrl = getStandardAudioUrl(word, lang);

    if (!response.ok) {
      // Return at least the standard audio if the rest fails
      return {
        audioUrl: standardAudioUrl
      };
    }
    
    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) {
      return { audioUrl: standardAudioUrl };
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
      audioUrl: standardAudioUrl, // Always use high quality standard audio
      definition_en
    };
  } catch (error) {
    console.error("Error fetching dictionary data:", error);
    // Fallback to just the standard audio
    return {
      audioUrl: getStandardAudioUrl(word, lang)
    };
  }
};
