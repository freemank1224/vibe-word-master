import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type DictionaryResponse = {
  phonetic?: string;
  definition_en?: string;
  definition_cn?: string;
  source: string;
};

const normalizeMeaning = (value?: string | null): string | undefined => {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized ? normalized : undefined;
};

const normalizeWordKey = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

const splitMeaningCandidates = (value?: string | null): string[] => {
  const normalized = normalizeMeaning(value);
  if (!normalized) return [];

  const rawParts = normalized
    .split(/[;/；、，]/g)
    .map((part) => normalizeMeaning(part))
    .filter((part): part is string => !!part);

  const unique = new Set<string>();
  for (const part of rawParts.length > 0 ? rawParts : [normalized]) {
    unique.add(part);
    if (unique.size >= 5) break;
  }

  return Array.from(unique);
};

const fetchExistingLexemeData = async (word: string, lang: string): Promise<DictionaryResponse | null> => {
  const normalizedWord = normalizeWordKey(word);
  if (!normalizedWord) return null;

  const { data: lexeme, error: lexemeError } = await supabase
    .from('lexeme_entries')
    .select('id, phonetic, definition_en')
    .eq('normalized_text', normalizedWord)
    .eq('language', lang)
    .maybeSingle();

  if (lexemeError) {
    throw new Error(`Global lexeme lookup failed: ${lexemeError.message}`);
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
    throw new Error(`Global lexeme meanings lookup failed: ${meaningsError.message}`);
  }

  const definition_cn = normalizeMeaning(meanings?.[0]?.meaning_zh);
  const phonetic = normalizeMeaning(lexeme.phonetic);
  const definition_en = normalizeMeaning(lexeme.definition_en);

  if (!phonetic && !definition_en && !definition_cn) {
    return null;
  }

  return {
    phonetic,
    definition_en,
    definition_cn,
    source: 'lexeme-cache',
  };
};

const fetchChineseTranslation = async (text: string, fallbackText?: string) => {
  const query = text.trim();
  if (!query) {
    return { provider: 'none', meanings: [] as string[] };
  }

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
        const meanings = splitMeaningCandidates(translated);
        if (meanings.length > 0) {
          return { provider: 'google-translate', meanings };
        }
      }
    } catch (error) {
      console.warn('Google translation failed:', error);
    }
  }

  try {
    const response = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(query)}&langpair=en|zh-CN`
    );

    if (response.ok) {
      const data = await response.json();
      const meanings = splitMeaningCandidates(data?.responseData?.translatedText);
      if (meanings.length > 0) {
        return { provider: 'mymemory', meanings };
      }
    }
  } catch (error) {
    console.warn('MyMemory translation failed:', error);
  }

  return { provider: 'none', meanings: [] as string[] };
};

const fetchEnglishDictionaryData = async (word: string): Promise<Pick<DictionaryResponse, 'phonetic' | 'definition_en'>> => {
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`);
    if (!response.ok) {
      return {};
    }

    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) {
      return {};
    }

    const entry = data[0];
    let phonetic = normalizeMeaning(entry.phonetic);

    if (!phonetic && Array.isArray(entry.phonetics)) {
      const phoneticEntry = entry.phonetics.find((item: any) => normalizeMeaning(item?.text));
      phonetic = normalizeMeaning(phoneticEntry?.text);
    }

    let definition_en: string | undefined;
    if (Array.isArray(entry.meanings) && entry.meanings.length > 0) {
      const firstMeaning = entry.meanings[0];
      if (Array.isArray(firstMeaning?.definitions) && firstMeaning.definitions.length > 0) {
        definition_en = normalizeMeaning(firstMeaning.definitions[0]?.definition);
      }
    }

    return {
      phonetic,
      definition_en,
    };
  } catch (error) {
    console.warn('Dictionary API lookup failed:', error);
    return {};
  }
};

const ensureLexemeEntry = async (
  text: string,
  lang: string,
  phonetic?: string,
  definitionEn?: string,
): Promise<string | null> => {
  const { data, error } = await supabase.rpc('ensure_lexeme_entry', {
    p_text: text,
    p_language: lang,
    p_phonetic: phonetic || null,
    p_definition_en: definitionEn || null,
  });

  if (error) {
    throw new Error(`ensure_lexeme_entry failed: ${error.message}`);
  }

  return typeof data === 'string' ? data : null;
};

const upsertMeanings = async (lexemeId: string, meanings: string[], provider: string) => {
  if (meanings.length === 0) return;

  const payload = meanings.map((meaning, index) => ({
    lexeme_id: lexemeId,
    meaning_zh: meaning,
    source_type: 'machine',
    source_provider: provider,
    confidence: index === 0 ? 0.82 : 0.72,
    is_verified: false,
  }));

  const { error } = await supabase
    .from('lexeme_meanings')
    .upsert(payload, { onConflict: 'lexeme_id,meaning_zh' });

  if (error) {
    throw new Error(`Upsert meanings failed: ${error.message}`);
  }
};

const propagateMeaningToWords = async (lexemeId: string, meaning: string) => {
  const { error: nullError } = await supabase
    .from('words')
    .update({ definition_cn: meaning })
    .eq('lexeme_id', lexemeId)
    .is('definition_cn', null);

  if (nullError) {
    throw new Error(`Propagate null meaning failed: ${nullError.message}`);
  }

  const { error: emptyError } = await supabase
    .from('words')
    .update({ definition_cn: meaning })
    .eq('lexeme_id', lexemeId)
    .eq('definition_cn', '');

  if (emptyError) {
    throw new Error(`Propagate empty meaning failed: ${emptyError.message}`);
  }
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'Missing Supabase service env vars' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const word = normalizeMeaning(body.word);
    const lang = normalizeMeaning(body.lang) || 'en';

    if (!word) {
      return new Response(JSON.stringify({ error: 'Missing word' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const existing = await fetchExistingLexemeData(word, lang);
    if (existing?.definition_cn && (existing.phonetic || existing.definition_en || existing.definition_cn)) {
      return new Response(JSON.stringify(existing), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const dictionaryData = lang === 'en' ? await fetchEnglishDictionaryData(word) : {};
    const phonetic = existing?.phonetic || dictionaryData.phonetic;
    const definition_en = existing?.definition_en || dictionaryData.definition_en;

    const translation = await fetchChineseTranslation(word, definition_en);
    const definition_cn = existing?.definition_cn || translation.meanings[0];

    const lexemeId = await ensureLexemeEntry(word, lang, phonetic, definition_en);
    if (lexemeId && translation.meanings.length > 0) {
      await upsertMeanings(lexemeId, translation.meanings, translation.provider === 'none' ? 'edge-none' : translation.provider);
      if (definition_cn) {
        await propagateMeaningToWords(lexemeId, definition_cn);
      }
    }

    const response: DictionaryResponse = {
      phonetic,
      definition_en,
      definition_cn,
      source: definition_cn ? 'edge-live' : 'edge-empty',
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('dictionary-lookup error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
