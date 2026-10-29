import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import type { WordMeaningOption } from '../types';
import { createDictionaryLookupCache, withinDeadline } from './dictionaryLookupCache';
import { normalizeChineseMeaning } from '../utils/chineseMeaning';

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
    const meaningZh = normalizeChineseMeaning(option.meaningZh);
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

export interface DictionaryLookupOptions { signal?: AbortSignal }

const dictionaryCache = createDictionaryLookupCache<DictionaryData>({ isUsable: data => !!data.definition_cn });
const meaningCache = createDictionaryLookupCache<WordMeaningOption[]>();
const globalCache = createDictionaryLookupCache<DictionaryData>({ isUsable: data => !!data.definition_cn });
const apiCache = createDictionaryLookupCache<DictionaryApiEntry[]>({ timeoutMs: 2500 });
const translationCache = createDictionaryLookupCache<string>({ timeoutMs: 3500 });
const keyFor = (word: string, lang: string) => JSON.stringify([lang.toLowerCase(), normalizeWordKey(word)]);

interface DictionaryApiEntry {
  phonetic?: string;
  phonetics?: Array<{ text?: string }>;
  meanings?: Array<{ partOfSpeech?: string; definitions?: Array<{ definition?: string }> }>;
}

const jsonRequest = <T>(url: string, signal: AbortSignal, init?: RequestInit): Promise<T> =>
  withinDeadline(async requestSignal => {
    const response = await fetch(url, { ...init, signal: requestSignal });
    if (!response.ok) throw new Error(`Dictionary source returned ${response.status}`);
    return await response.json() as T;
  }, 2000, signal);

const fetchGlobalLexemeData = (word: string, lang: string, signal: AbortSignal) =>
  globalCache(keyFor(word, lang), async sharedSignal => {
    if (!isSupabaseConfigured) return null;
    return withinDeadline(async requestSignal => {
      const { data: lexeme, error } = await supabase.from('lexeme_entries')
        .select('id, phonetic, definition_en').eq('normalized_text', normalizeWordKey(word))
        .eq('language', lang).abortSignal(requestSignal).maybeSingle();
      if (error || !lexeme?.id) return null;
      const { data: meanings, error: meaningsError } = await supabase.from('lexeme_meanings')
        .select('meaning_zh, part_of_speech, source_provider, confidence, is_verified, created_at')
        .eq('lexeme_id', lexeme.id).order('is_verified', { ascending: false })
        .order('confidence', { ascending: false }).order('created_at', { ascending: true })
        .limit(10).abortSignal(requestSignal);
      const meaningOptions = meaningsError ? [] : dedupeMeaningOptions((meanings || []).map(item => ({
        key: buildMeaningOptionKey(item.meaning_zh, item.part_of_speech),
        meaningZh: item.meaning_zh, partOfSpeech: item.part_of_speech, sourceProvider: item.source_provider,
      })));
      const data: DictionaryData = {
        phonetic: normalizeMeaning(lexeme.phonetic), definition_en: normalizeMeaning(lexeme.definition_en),
        definition_cn: meaningOptions[0]?.meaningZh, meaningOptions,
      };
      return data.definition_cn || data.definition_en || data.phonetic ? data : null;
    }, 2000, sharedSignal);
  }, signal);

const fetchDictionaryDataViaEdge = async (word: string, lang: string, signal: AbortSignal): Promise<DictionaryData | null> => {
  if (!isSupabaseConfigured) return null;
  try {
    // The edge function can spend up to 2.5 seconds on its first translation
    // provider. Give it time to return before cancelling the client request.
    return await withinDeadline(async requestSignal => {
      const { data, error } = await supabase.functions.invoke('dictionary-lookup', { body: { word, lang }, signal: requestSignal });
      if (error) return null;
      const result = {
        phonetic: normalizeMeaning(data?.phonetic), definition_en: normalizeMeaning(data?.definition_en),
        definition_cn: normalizeChineseMeaning(data?.definition_cn),
      };
      return result.definition_cn || result.definition_en || result.phonetic ? result : null;
    }, 4000, signal);
  } catch { return null; }
};

const fetchDictionaryApi = (word: string, signal: AbortSignal) => apiCache(keyFor(word, 'en'), async requestSignal => {
  const data = await jsonRequest<DictionaryApiEntry[]>(
    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(normalizeWordKey(word))}`, requestSignal,
  );
  return Array.isArray(data) && data.length ? data : null;
}, signal);

const fetchChineseTranslation = (word: string, lang: string, signal: AbortSignal) =>
  translationCache(keyFor(word, lang), async requestSignal => {
    const local = lang === 'en' ? PROPER_NOUN_TRANSLATIONS[normalizeWordKey(word)] : undefined;
    if (local) return local;
    // Independent sources race within one budget; failed/CORS sources cannot serialize delays.
    const uapis = jsonRequest<{ translated_text?: string }>(`${uapisTranslateEndpoint}?to_lang=zh`, requestSignal, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(uapisApiKey ? {
        Authorization: `Bearer ${uapisApiKey}`, 'x-api-key': uapisApiKey,
      } : {}) }, body: JSON.stringify({ text: word }),
    }).then(data => normalizeChineseMeaning(data.translated_text));
    const google = jsonRequest<unknown>(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(lang)}&tl=zh-CN&dt=t&q=${encodeURIComponent(word)}`,
      requestSignal,
    ).then(data => {
      const rows = Array.isArray(data) ? data[0] : undefined;
      return normalizeChineseMeaning(Array.isArray(rows) ? rows.map(row => Array.isArray(row) ? row[0] : '').join('') : undefined);
    });
    try {
      return await Promise.any([uapis, google].map(request => request.then(value => {
        if (!value) throw new Error('Empty translation');
        return value;
      })));
    } catch {
      if (requestSignal.aborted) return null;
      const fallback = await jsonRequest<{ responseData?: { translatedText?: string } }>(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=${encodeURIComponent(lang)}|zh-CN`, requestSignal,
      );
      return normalizeChineseMeaning(fallback.responseData?.translatedText) || null;
    }
  }, signal);

/** Basic lookup does not eagerly translate every meaning; full alternatives are loaded on demand. */
export const fetchDictionaryData = (
  word: string, lang: string = 'en', options: DictionaryLookupOptions = {},
): Promise<DictionaryData | null> => {
  if (!normalizeWordKey(word)) return Promise.resolve(null);
  return dictionaryCache(keyFor(word, lang), async signal => {
    const shared = await fetchGlobalLexemeData(word, lang, signal);
    if (shared?.definition_cn) return shared;
    const [edge, entries, translated] = await Promise.all([
      fetchDictionaryDataViaEdge(word, lang, signal),
      lang === 'en' ? fetchDictionaryApi(word, signal) : Promise.resolve(null),
      fetchChineseTranslation(word, lang, signal),
    ]);
    const entry = entries?.[0];
    const result: DictionaryData = {
      phonetic: shared?.phonetic || edge?.phonetic || normalizeMeaning(entry?.phonetic)
        || normalizeMeaning(entry?.phonetics?.find(item => item.text)?.text),
      definition_en: shared?.definition_en || edge?.definition_en || normalizeMeaning(entry?.meanings?.[0]?.definitions?.[0]?.definition),
      definition_cn: shared?.definition_cn || edge?.definition_cn || translated || undefined,
      meaningOptions: shared?.meaningOptions || [],
    };
    return result.definition_cn || result.definition_en || result.phonetic ? result : null;
  }, options.signal);
};

/** The expensive alternative-meaning path is only used when opening the meaning picker. */
export const fetchWordMeaningOptions = (
  word: string, lang: string = 'en', fallbackDefinitionEn?: string, options: DictionaryLookupOptions = {},
): Promise<WordMeaningOption[]> => {
  if (!normalizeWordKey(word)) return Promise.resolve([]);
  return meaningCache(JSON.stringify([keyFor(word, lang), fallbackDefinitionEn || '']), async signal => {
    const shared = await fetchGlobalLexemeData(word, lang, signal);
    if (shared?.meaningOptions?.length) return shared.meaningOptions;
    const entries = lang === 'en' ? await fetchDictionaryApi(word, signal) : null;
    const candidates = (entries || []).flatMap(entry => (entry.meanings || []).flatMap(meaning =>
      (meaning.definitions || []).slice(0, 2).map(definition => ({
        definitionEn: normalizeMeaning(definition.definition), partOfSpeech: normalizePartOfSpeech(meaning.partOfSpeech),
      })),
    )).filter(item => item.definitionEn).slice(0, 4);
    const options = await Promise.all(candidates.map(async candidate => {
      const meaningZh = await fetchChineseTranslation(candidate.definitionEn!, 'en', signal);
      return meaningZh ? {
        key: buildMeaningOptionKey(meaningZh, candidate.partOfSpeech), meaningZh,
        partOfSpeech: candidate.partOfSpeech || null, definitionEn: candidate.definitionEn || null,
        sourceProvider: 'dictionaryapi.dev',
      } : null;
    }));
    const meanings = dedupeMeaningOptions(options.filter((item): item is NonNullable<typeof item> => !!item));
    if (meanings.length) return meanings;
    const translated = await fetchChineseTranslation(word, lang, signal);
    return translated ? [{
      key: buildMeaningOptionKey(translated), meaningZh: translated, partOfSpeech: null,
      definitionEn: normalizeMeaning(fallbackDefinitionEn) || null, sourceProvider: 'translation-fallback',
    }] : null;
  }, options.signal).then(options => options || []);
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
export const playWordAudio = async (word: string, lang: string = 'en', directUrl?: string | null): Promise<boolean> => {
  try {
    const { playWordPronunciation } = await import('./pronunciationService');
    const result = await playWordPronunciation(word, lang, undefined, directUrl);
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
  timeoutMs: number = 8000,
  directUrl?: string | null
): Promise<boolean> => {
  try {
    const { preloadWordAudio: impl } = await import('./pronunciationService');
    return await impl(word, lang, timeoutMs, directUrl);
  } catch (error) {
    console.error('Preload pronunciation error:', error);
    return false;
  }
};
