
export interface DictionaryData {
  phonetic?: string;
  audioUrl?: string;
  definition_en?: string;
}

export const fetchDictionaryData = async (word: string): Promise<DictionaryData | null> => {
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word.toLowerCase()}`);
    if (!response.ok) return null;
    
    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    const entry = data[0];
    
    // Find phonetic and audio
    let phonetic = entry.phonetic;
    let audioUrl = '';

    if (entry.phonetics && entry.phonetics.length > 0) {
      // Find the best audio match (prefer US, then any audio)
      const phonetics = entry.phonetics;
      
      const usAudio = phonetics.find((p: any) => p.audio && p.audio.endsWith('-us.mp3'));
      const ukAudio = phonetics.find((p: any) => p.audio && p.audio.endsWith('-uk.mp3'));
      const anyAudio = phonetics.find((p: any) => p.audio && p.audio.length > 0);
      
      const bestMatch = usAudio || ukAudio || anyAudio;
      
      if (bestMatch) {
        audioUrl = bestMatch.audio;
        if (!phonetic) phonetic = bestMatch.text;
      } else if (!phonetic) {
        // Fallback to text only if no audio found
        phonetic = phonetics[0].text;
      }
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
    return null;
  }
};
