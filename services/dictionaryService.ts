
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import type { WordMeaningOption } from '../types';

export interface DictionaryData {
  phonetic?: string;
  audioUrl?: string;
  definition_en?: string;
  definition_cn?: string;
  meaningOptions?: WordMeaningOption[];
}

const PLACEHOLDER_MEANINGS = new Set([
  '暂无中文释义',
  '无中文释义',
  '暂无释义',
  'n/a',
  'na',
  '-',
]);

const normalizeMeaning = (value?: string | null): string | undefined => {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  if (PLACEHOLDER_MEANINGS.has(normalized.toLowerCase())) return undefined;
  return normalized;
};

const normalizeWordKey = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');
const normalizePartOfSpeech = (value?: string | null): string | undefined => {
  const normalized = value?.replace(/[_-]+/g, ' ').trim();
  if (!normalized) return undefined;

  const partOfSpeechMap: Record<string, string> = {
    noun: 'n.',
    verb: 'v.',
    adjective: 'adj.',
    adverb: 'adv.',
    pronoun: 'pron.',
    preposition: 'prep.',
    conjunction: 'conj.',
    interjection: 'int.',
    article: 'art.',
    determiner: 'det.',
    auxiliary: 'aux.',
    phrase: 'phr.',
  };

  return partOfSpeechMap[normalized.toLowerCase()] || normalized;
};

const buildMeaningOptionKey = (meaningZh: string, partOfSpeech?: string | null) => {
  return `${(partOfSpeech || 'na').trim().toLowerCase()}::${normalizeWordKey(meaningZh)}`;
};

const dedupeMeaningOptions = (options: WordMeaningOption[]): WordMeaningOption[] => {
  const optionMap = new Map<string, WordMeaningOption>();

  for (const option of options) {
    const meaningZh = normalizeMeaning(option.meaningZh);
    if (!meaningZh) continue;

    const partOfSpeech = normalizePartOfSpeech(option.partOfSpeech);
    const key = option.key || buildMeaningOptionKey(meaningZh, partOfSpeech);
    if (optionMap.has(key)) continue;

    optionMap.set(key, {
      key,
      meaningZh,
      partOfSpeech: partOfSpeech || null,
      definitionEn: normalizeMeaning(option.definitionEn) || null,
      sourceProvider: option.sourceProvider || null,
    });
  }

  return Array.from(optionMap.values());
};
const uapisTranslateEndpoint = (import.meta as any)?.env?.VITE_UAPIS_TRANSLATE_ENDPOINT || 'https://uapis.cn/api/v1/translate/text';
const uapisApiKey = (import.meta as any)?.env?.VITE_UAPIS_API_KEY || '';

const PROPER_NOUN_TRANSLATIONS: Record<string, string> = {
  january: '一月',
  february: '二月',
  march: '三月',
  april: '四月',
  may: '五月',
  june: '六月',
  july: '七月',
  august: '八月',
  september: '九月',
  october: '十月',
  november: '十一月',
  december: '十二月',
};

const toTitleCase = (value: string) => {
  const lowered = value.toLowerCase();
  return lowered.charAt(0).toUpperCase() + lowered.slice(1);
};

const buildQueryVariants = (value: string): string[] => {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const lower = trimmed.toLowerCase();
  return Array.from(new Set([trimmed, lower, toTitleCase(trimmed)]));
};

const lookupProperNounTranslation = (value: string): string | undefined => {
  const key = value.trim().toLowerCase();
  return PROPER_NOUN_TRANSLATIONS[key];
};

const fetchWithTimeout = async (input: string, timeoutMs: number, init?: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...(init || {}), signal: controller.signal });
  } finally {
    clearTimeout(timeoutHandle);
  }
};

const fetchUapisTranslation = async (text: string): Promise<string | undefined> => {
  try {
    const response = await fetchWithTimeout(`${uapisTranslateEndpoint}?to_lang=zh`, 2500, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(uapisApiKey ? {
          Authorization: `Bearer ${uapisApiKey}`,
          'x-api-key': uapisApiKey,
        } : {}),
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) return undefined;

    const data = await response.json().catch(() => ({}));
    return normalizeMeaning(data?.translated_text);
  } catch (error) {
    console.warn('UAPIs translation failed:', error);
    return undefined;
  }
};

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

const fetchGlobalLexemeMeaningOptions = async (word: string, lang: string): Promise<WordMeaningOption[]> => {
  if (!isSupabaseConfigured) return [];

  const normalizedWord = normalizeWordKey(word);
  if (!normalizedWord) return [];

  try {
    const { data: lexeme, error: lexemeError } = await supabase
      .from('lexeme_entries')
      .select('id')
      .eq('normalized_text', normalizedWord)
      .eq('language', lang)
      .maybeSingle();

    if (lexemeError || !lexeme?.id) {
      return [];
    }

    const { data: meanings, error: meaningsError } = await supabase
      .from('lexeme_meanings')
      .select('meaning_zh, part_of_speech, source_provider, confidence, is_verified, created_at')
      .eq('lexeme_id', lexeme.id)
      .order('is_verified', { ascending: false })
      .order('confidence', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(10);

    if (meaningsError) {
      return [];
    }

    return dedupeMeaningOptions((meanings || []).map((item: any) => ({
      key: buildMeaningOptionKey(item.meaning_zh, item.part_of_speech),
      meaningZh: item.meaning_zh,
      partOfSpeech: item.part_of_speech,
      sourceProvider: item.source_provider,
    })));
  } catch (error) {
    console.warn('Global lexeme meaning options fetch failed:', error);
    return [];
  }
};

const fetchChineseTranslation = async (text: string, fallbackText?: string): Promise<string | undefined> => {
  const query = text.trim();
  if (!query) return undefined;

  const localFallback = lookupProperNounTranslation(query);
  if (localFallback) return localFallback;

  const googleTargets = Array.from(new Set([
    ...buildQueryVariants(query),
    ...buildQueryVariants(fallbackText || ''),
  ])).filter((item): item is string => !!item?.trim());

  for (const target of googleTargets) {
    const translated = await fetchUapisTranslation(target);
    if (translated) return translated;
  }

  for (const target of googleTargets) {
    try {
      const response = await fetchWithTimeout(
        `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(target)}`
      , 2000
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
    const response = await fetchWithTimeout(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(query)}&langpair=en|zh-CN`
    , 2000
    );

    if (!response.ok) return localFallback;

    const data = await response.json();
    return normalizeMeaning(data?.responseData?.translatedText) || localFallback;
  } catch (error) {
    console.warn('Fallback translation failed:', error);
    return localFallback;
  }
};

const fetchDictionaryApiMeaningOptions = async (word: string): Promise<WordMeaningOption[]> => {
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word.toLowerCase()}`);
    if (!response.ok) return [];

    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) return [];

    const candidates: Array<{ partOfSpeech?: string; definitionEn: string }> = [];

    for (const entry of data) {
      for (const meaning of entry.meanings || []) {
        for (const definition of (meaning.definitions || []).slice(0, 2)) {
          const definitionEn = normalizeMeaning(definition?.definition);
          if (!definitionEn) continue;
          candidates.push({
            partOfSpeech: meaning.partOfSpeech,
            definitionEn,
          });
          if (candidates.length >= 10) break;
        }
        if (candidates.length >= 10) break;
      }
      if (candidates.length >= 10) break;
    }

    const translatedOptions = await Promise.all(candidates.map(async (candidate) => {
      const meaningZh = await fetchChineseTranslation(candidate.definitionEn, word);
      if (!meaningZh) return null;

      const partOfSpeech = normalizePartOfSpeech(candidate.partOfSpeech);
      return {
        key: buildMeaningOptionKey(meaningZh, partOfSpeech),
        meaningZh,
        partOfSpeech: partOfSpeech || null,
        definitionEn: candidate.definitionEn,
        sourceProvider: 'dictionaryapi.dev',
      } as WordMeaningOption;
    }));

    return dedupeMeaningOptions(translatedOptions.filter((item): item is WordMeaningOption => !!item)).slice(0, 8);
  } catch (error) {
    console.warn('Dictionary API meaning options fetch failed:', error);
    return [];
  }
};

export const fetchWordMeaningOptions = async (word: string, lang: string = 'en', fallbackDefinitionEn?: string): Promise<WordMeaningOption[]> => {
  const globalOptions = await fetchGlobalLexemeMeaningOptions(word, lang);
  if (globalOptions.length > 0) {
    return globalOptions;
  }

  if (lang === 'en') {
    const dictionaryOptions = await fetchDictionaryApiMeaningOptions(word);
    if (dictionaryOptions.length > 0) {
      return dictionaryOptions;
    }
  }

  const fallbackMeaning = await fetchChineseTranslation(word, fallbackDefinitionEn || word);
  if (!fallbackMeaning) return [];

  return [{
    key: buildMeaningOptionKey(fallbackMeaning, null),
    meaningZh: fallbackMeaning,
    partOfSpeech: null,
    definitionEn: normalizeMeaning(fallbackDefinitionEn) || null,
    sourceProvider: 'translation-fallback',
  }];
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

/**
 * Preload a word's pronunciation so it plays with zero network at test time.
 * Thin dynamic-import wrapper around pronunciationService.preloadWordAudio,
 * mirroring the playWordAudio pattern. Returns true only when the audio bytes
 * are confirmed locally playable.
 */
export const preloadWordAudio = async (
  word: string,
  lang: string = 'en',
  timeoutMs: number = 8000
): Promise<boolean> => {
  try {
    const { preloadWordAudio: impl } = await import('./pronunciationService');
    return await impl(word, lang, timeoutMs);
  } catch (error) {
    console.error('Preload pronunciation error:', error);
    return false;
  }
};

export const fetchDictionaryData = async (word: string, lang: string = 'en'): Promise<DictionaryData | null> => {
  const meaningOptions = await fetchWordMeaningOptions(word, lang);

  const globalLexemeData = await fetchGlobalLexemeData(word, lang);
  if (globalLexemeData?.definition_cn || globalLexemeData?.phonetic || globalLexemeData?.definition_en) {
    return {
      ...globalLexemeData,
      definition_cn: globalLexemeData.definition_cn || meaningOptions[0]?.meaningZh,
      meaningOptions,
    };
  }

  const edgeData = await fetchDictionaryDataViaEdge(word, lang);
  if (edgeData?.definition_cn || edgeData?.phonetic || edgeData?.definition_en) {
    return {
      ...edgeData,
      definition_cn: edgeData.definition_cn || meaningOptions[0]?.meaningZh,
      meaningOptions,
    };
  }

  if (lang !== 'en') {
    const definition_cn = await fetchChineseTranslation(word);
    return {
      audioUrl: undefined,
      definition_cn,
      meaningOptions,
    };
  }

  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word.toLowerCase()}`);
    
    if (!response.ok) {
      return {
        audioUrl: undefined,
        meaningOptions,
      };
    }
    
    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) {
      return { audioUrl: undefined, meaningOptions };
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
      definition_cn: definition_cn || meaningOptions[0]?.meaningZh,
      meaningOptions,
    };
  } catch (error) {
    console.error("Error fetching dictionary data:", error);
    const definition_cn = await fetchChineseTranslation(word);
    return {
      audioUrl: undefined,
      definition_cn,
      meaningOptions,
    };
  }
};
