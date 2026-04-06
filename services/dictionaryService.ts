
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';

export interface DictionaryData {
  phonetic?: string;
  audioUrl?: string;
  definition_en?: string;
  definition_cn?: string;
}

const normalizeMeaning = (value?: string | null): string | undefined => {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized ? normalized : undefined;
};

const normalizeWordKey = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

const fetchDictionaryDataViaEdge = async (word: string, lang: string): Promise<DictionaryData | null> => {
  if (!isSupabaseConfigured) return null;

  try {
    const { data, error } = await supabase.functions.invoke('dictionary-lookup', {
      body: {
        word,
        lang,
      },
    });

    if (error) {
      console.warn('Dictionary edge lookup failed:', error.message);
      return null;
    }

    const definition_cn = normalizeMeaning(data?.definition_cn);
    const definition_en = normalizeMeaning(data?.definition_en);
    const phonetic = normalizeMeaning(data?.phonetic);

    if (!definition_cn && !definition_en && !phonetic) {
      return null;
    }

    return {
      phonetic,
      definition_en,
      definition_cn,
      audioUrl: undefined,
    };
  } catch (error) {
    console.warn('Dictionary edge invocation threw error:', error);
    return null;
  }
};

const fetchGlobalLexemeData = async (word: string, lang: string): Promise<DictionaryData | null> => {
  if (!isSupabaseConfigured) return null;

  const normalizedWord = normalizeWordKey(word);
  if (!normalizedWord) return null;

  try {
    const { data: lexeme, error: lexemeError } = await supabase
      .from('lexeme_entries')
      .select('id, phonetic, definition_en')
      .eq('normalized_text', normalizedWord)
      .eq('language', lang)
      .maybeSingle();

    if (lexemeError) {
      console.warn('Global lexeme lookup failed:', lexemeError.message);
      return null;
    }

    if (!lexeme?.id) return null;

    const { data: meanings, error: meaningsError } = await supabase
      .from('lexeme_meanings')
      .select('meaning_zh, is_verified, confidence, created_at')
      .eq('lexeme_id', lexeme.id)
      .order('is_verified', { ascending: false })
      .order('confidence', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(5);

    if (meaningsError) {
      console.warn('Global lexeme meanings lookup failed:', meaningsError.message);
      return null;
    }

    const definition_cn = normalizeMeaning(meanings?.[0]?.meaning_zh);
    if (!definition_cn && !lexeme.phonetic && !lexeme.definition_en) {
      return null;
    }

    return {
      phonetic: normalizeMeaning(lexeme.phonetic),
      definition_en: normalizeMeaning(lexeme.definition_en),
      definition_cn,
      audioUrl: undefined,
    };
  } catch (error) {
    console.warn('Global lexeme fetch threw error:', error);
    return null;
  }
};

const fetchChineseTranslation = async (text: string, fallbackText?: string): Promise<string | undefined> => {
  const query = text.trim();
  if (!query) return undefined;

  const googleTargets = [query, fallbackText].filter((item): item is string => !!item?.trim());

  for (const target of googleTargets) {
    try {
      const response = await fetch(
        `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(target)}`
      );

      if (response.ok) {
        const data = await response.json();
        const translated = Array.isArray(data?.[0])
          ? data[0].map((segment: any) => segment?.[0]).filter(Boolean).join('')
          : undefined;
        const normalized = normalizeMeaning(translated);
        if (normalized) return normalized;
      }
    } catch (error) {
      console.warn('Google translation failed:', error);
    }
  }

  try {
    const response = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(query)}&langpair=en|zh-CN`
    );

    if (!response.ok) return undefined;

    const data = await response.json();
    return normalizeMeaning(data?.responseData?.translatedText);
  } catch (error) {
    console.warn('Fallback translation failed:', error);
    return undefined;
  }
};

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
  const globalLexemeData = await fetchGlobalLexemeData(word, lang);
  if (globalLexemeData?.definition_cn || globalLexemeData?.phonetic || globalLexemeData?.definition_en) {
    return globalLexemeData;
  }

  const edgeData = await fetchDictionaryDataViaEdge(word, lang);
  if (edgeData?.definition_cn || edgeData?.phonetic || edgeData?.definition_en) {
    return edgeData;
  }

  if (lang !== 'en') {
    const definition_cn = await fetchChineseTranslation(word);
    return {
      audioUrl: undefined,
      definition_cn,
    };
  }

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

    const definition_cn = await fetchChineseTranslation(word, definition_en);

    return {
      phonetic,
      audioUrl: undefined, // 不再提供音频 URL，使用本地 TTS
      definition_en,
      definition_cn
    };
  } catch (error) {
    console.error("Error fetching dictionary data:", error);
    const definition_cn = await fetchChineseTranslation(word);
    return {
      audioUrl: undefined,
      definition_cn
    };
  }
};
