
import { supabase } from '../lib/supabaseClient';
import {
  InputSession,
  PuzzleGameSummary,
  PuzzleLeaderboardEntry,
  PuzzleLeaderboardMetric,
  PuzzleLeaderboardScope,
  WordEntry,
  WordMeaningOption,
  WordStrikeGameSummary,
  WordStrikeLeaderboardEntry,
  WordStrikeLeaderboardMetric,
  WordStrikeLeaderboardScope,
} from '../types';
import { compressToWebP } from '../utils/imageUtils';
import { aiService } from './ai';
import { getShanghaiDateString } from '../utils/timezone';
import { WORD_LEARNING_CONFIG } from '../config/wordLearningConfig';
import { overlayLearningProgress } from './learningRecordStore';
import { parseTestStatsReceipt, validateTestStatsEvent } from './testStatsEvents';
import { adaptiveWordSelector } from './adaptiveWordSelector';
import { updateReviewState, getReviewSchedule, type ReviewState } from './reviewScheduler';

let wordsMeaningFieldsSupported: boolean | null = null;

const isMissingMeaningFieldError = (error: any): boolean => {
  const message = String(error?.message || error?.details || error?.hint || '').toLowerCase();
  return message.includes('meaning_options') || message.includes('selected_meaning_key');
};

const stripMeaningFields = <T extends Record<string, any>>(payload: T): Omit<T, 'meaning_options' | 'selected_meaning_key'> => {
  const { meaning_options, selected_meaning_key, ...rest } = payload;
  void meaning_options;
  void selected_meaning_key;
  return rest;
};

const executeWordsMutationWithCompatibility = async <T>(
  primary: () => Promise<{ data?: T; error?: any }>,
  fallback: () => Promise<{ data?: T; error?: any }>,
  context: string,
): Promise<{ data?: T; error?: any }> => {
  if (wordsMeaningFieldsSupported === false) {
    return fallback();
  }

  const result = await primary();
  if (!result.error) {
    wordsMeaningFieldsSupported = true;
    return result;
  }

  if (!isMissingMeaningFieldError(result.error)) {
    return result;
  }

  console.warn(`[dataService] ${context}: words table missing meaning columns, retrying without new fields.`);
  wordsMeaningFieldsSupported = false;
  return fallback();
};

const triggerPronunciationGeneration = async (word: string, lang: string = 'en'): Promise<void> => {
  try {
    // process.env.SUPABASE_URL is statically replaced by vite.config.ts `define` at build time.
    const supabaseUrl = process.env.SUPABASE_URL || '';
    if (!supabaseUrl) return;
    const uniquenessMode = WORD_LEARNING_CONFIG.pronunciation.uniquenessMode;
    const endpoint = `${supabaseUrl}/functions/v1/pronunciation?word=${encodeURIComponent(word)}&lang=${encodeURIComponent(lang)}&uniqueness_mode=${encodeURIComponent(uniquenessMode)}`;
    const response = await fetch(endpoint, { method: 'GET' });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.warn(
        `[pronunciation-trigger] ${word} (${lang}) failed with ${response.status} ${response.statusText}`,
        {
          endpoint,
          uniquenessMode,
          error: errorText.slice(0, 500) || '(empty response body)'
        }
      );
      return;
    }

    const source = response.headers.get('X-Pronunciation-Source');
    if (source) {
      console.log(`[pronunciation-trigger] ${word} (${lang}) succeeded via ${source}`);
    }
  } catch (error) {
    console.warn(`[pronunciation-trigger] failed for ${word}:`, error);
  }
};

const triggerPronunciationBatch = (items: { text: string; language?: string | null }[]) => {
  if (!items || items.length === 0) return;
  const uniqueMap = new Map<string, { text: string; language?: string | null }>();
  for (const item of items) {
    const key = `${item.text.toLowerCase().trim()}::${(item.language || 'en').trim()}`;
    if (!uniqueMap.has(key)) uniqueMap.set(key, item);
  }

  const queue = Array.from(uniqueMap.values());
  const concurrency = 2;

  const worker = async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      await triggerPronunciationGeneration(next.text, next.language || 'en');
    }
  };

  for (let i = 0; i < concurrency; i++) {
    void worker();
  }

  void supabase.functions.invoke('pronunciation-rebuild', {
    body: {
      action: 'process_generation_jobs',
      limit: 20,
      uniqueness_mode: WORD_LEARNING_CONFIG.pronunciation.uniquenessMode,
    },
  }).catch((error) => {
    console.warn('[pronunciation-jobs] trigger retry worker failed:', error?.message || error);
  });
};

/**
 * Fire-and-forget: trigger image generation for a batch of words.
 * The edge function handles cache check, generation, upload, and word linking.
 */
const triggerImageGenerationBatch = (items: { text: string; language?: string | null }[]) => {
  if (!items || items.length === 0) return;

  const supabaseUrl = process.env.SUPABASE_URL || '';
  if (!supabaseUrl) return;

  // Deduplicate by normalized word + language
  const uniqueMap = new Map<string, { text: string; language?: string | null }>();
  for (const item of items) {
    const key = `${item.text.toLowerCase().trim()}::${(item.language || 'en').trim()}`;
    if (!uniqueMap.has(key)) uniqueMap.set(key, item);
  }

  const queue = Array.from(uniqueMap.values());
  const concurrency = 2;

  const worker = async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      try {
        await supabase.functions.invoke('image-generate', {
          body: { word: next.text, language: next.language || 'en' },
        });
      } catch (e) {
        console.warn(`[image-trigger] failed for ${next.text}:`, e);
      }
    }
  };

  for (let i = 0; i < concurrency; i++) {
    void worker();
  }
};

// 与 image_assets 服务端一致的归一化（toLowerCase + 折叠空白）。
// image_assets 的唯一键是 (normalized_word, language)，所以客户端必须用同一算法构造查询键。
const normalizeWord = (text: string): string =>
  text.toLowerCase().trim().replace(/\s+/g, ' ');

/**
 * 按 (normalized_word, language) 批量查询全局已就绪的 image_assets。
 * 图片在 image_assets 是跨用户共享的（无 user_id，唯一键 normalized_word+language），
 * 因此任一用户的词只要 asset 存在且 status='ready' 即可命中。
 *
 * 返回 Map: `${normalized}::${language}` -> { id, public_url }
 *
 * 分块查询：大词库（如 CET-4 ~2500 词首次全 null）时，单次 .in() 的 URL 会过长而失败，
 * 因此按 ASSET_QUERY_CHUNK 分批拉取再合并。
 */
const ASSET_QUERY_CHUNK = 200;

const fetchReadyAssetMap = async (
  entries: { text: string; language?: string | null }[]
): Promise<Map<string, { id: string; public_url: string }>> => {
  const result = new Map<string, { id: string; public_url: string }>();
  if (!entries || entries.length === 0) return result;

  const normalizeds: string[] = [];
  const languages = new Set<string>();
  const seen = new Set<string>();
  for (const e of entries) {
    const nw = normalizeWord(e.text);
    const lang = (e.language || 'en').trim();
    const k = `${nw}::${lang}`;
    if (!seen.has(k)) {
      seen.add(k);
      normalizeds.push(nw);
      languages.add(lang);
    }
  }
  if (normalizeds.length === 0) return result;

  const langList = Array.from(languages);
  for (let i = 0; i < normalizeds.length; i += ASSET_QUERY_CHUNK) {
    const chunk = normalizeds.slice(i, i + ASSET_QUERY_CHUNK);
    // PostgREST 的 .in() 是按列的 OR；跨列组合在客户端按完整 key 精确匹配，结果正确。
    const { data: assets } = await supabase
      .from('image_assets')
      .select('id, normalized_word, language, public_url')
      .eq('status', 'ready')
      .in('normalized_word', chunk)
      .in('language', langList);
    for (const a of assets || []) {
      result.set(`${a.normalized_word}::${a.language}`, { id: a.id, public_url: a.public_url });
    }
  }
  return result;
};

/**
 * 把刚插入的 words 与全局共享的 ready image_assets 关联（按 normalized_word+language 命中）。
 * 仅返回「未命中共享图」的词，供调用方触发真正需要的生成——
 * 避免对已有共享图的词重复发起生成请求（这正是历史 bug 的浪费点）。
 */
const linkExistingImageAssets = async (
  inserted: { id: string; text: string; language?: string | null }[]
): Promise<{ text: string; language?: string | null }[]> => {
  if (!inserted || inserted.length === 0) return [];

  const assetMap = await fetchReadyAssetMap(inserted);
  if (assetMap.size === 0) return inserted.map(w => ({ text: w.text, language: w.language }));

  // 按 assetId 聚合待回写的 wordId，减少 UPDATE 次数
  const assetToWordIds = new Map<string, string[]>();
  const missing: { text: string; language?: string | null }[] = [];

  for (const w of inserted) {
    const nw = normalizeWord(w.text);
    const lang = (w.language || 'en').trim();
    const asset = assetMap.get(`${nw}::${lang}`);
    if (asset) {
      const arr = assetToWordIds.get(asset.id) || [];
      arr.push(w.id);
      assetToWordIds.set(asset.id, arr);
    } else {
      missing.push({ text: w.text, language: w.language });
    }
  }

  for (const [assetId, wordIds] of assetToWordIds) {
    const { error } = await supabase
      .from('words')
      .update({ image_asset_id: assetId })
      .in('id', wordIds);
    if (error) {
      console.warn(`[linkExistingImageAssets] update failed for asset ${assetId}: ${error.message}`);
    }
  }

  return missing;
};

/**
 * 加词后的统一入口：先回链已存在的跨用户共享图，再对真正缺失的词触发生成。
 * 替代原先「无脑全部触发」的写法。
 */
const linkAndGenerateImages = (inserted: { id: string; text: string; language?: string | null }[]) => {
  if (!inserted || inserted.length === 0) return;
  linkExistingImageAssets(inserted)
    .then(missing => {
      if (missing.length > 0) triggerImageGenerationBatch(missing);
    })
    .catch(err => console.warn('[linkAndGenerateImages] warning:', err?.message || err));
};

/**
 * 读时兜底（安全网）：对 image_asset_id 仍为 null 的词，按 (normalized_word, language)
 * 查全局共享图，命中则回写 image_asset_id（持久化 + 内存同步）。
 *
 * 无论词从哪个入口进入（save / modify / 字典批量导入 / 历史数据），开卡即可被捞回。
 * 这是唯一能兜住所有入口的环节，因此优先级最高。
 */
const backfillMissingImageAssets = async (rows: any[]): Promise<void> => {
  const missing = (rows || []).filter(r => r && !r.image_asset_id && !r.deleted);
  if (missing.length === 0) return;

  const assetMap = await fetchReadyAssetMap(missing.map(r => ({ text: r.text, language: r.language })));
  if (assetMap.size === 0) return;

  const assetToWordIds = new Map<string, string[]>();
  for (const r of missing) {
    const nw = normalizeWord(r.text);
    const lang = (r.language || 'en').trim();
    const asset = assetMap.get(`${nw}::${lang}`);
    if (!asset) continue;
    r.image_asset_id = asset.id; // 内存同步，供本次 mapping 直接拿到 image_asset_id
    const arr = assetToWordIds.get(asset.id) || [];
    arr.push(r.id);
    assetToWordIds.set(asset.id, arr);
  }

  for (const [assetId, wordIds] of assetToWordIds) {
    const { error } = await supabase
      .from('words')
      .update({ image_asset_id: assetId })
      .in('id', wordIds);
    if (error) {
      console.warn(`[backfillMissingImageAssets] update failed for asset ${assetId}: ${error.message}`);
    }
  }
};

// Helper to get current user ID
export const getCurrentUserId = async (): Promise<string | null> => {
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id || null;
};

// Helper to upload Base64 image to Supabase Storage
export const uploadImage = async (base64Data: string, userId: string): Promise<string | null> => {
  try {
    // 1. Compress and convert to WebP
    // We target 1024x1024 max as it's a good balance of clarity and size
    const blob = await compressToWebP(base64Data, 1024, 1024, 0.8);

    // 2. Generate path (using .webp extension)
    const fileName = `${userId}/${Date.now()}-${Math.random().toString(36).substring(7)}.webp`;
    
    // 3. Upload
    const { data, error } = await supabase.storage
      .from('vocab-images')
      .upload(fileName, blob, {
        cacheControl: '3600',
        upsert: false
      });

    if (error) {
        console.error("Supabase Storage Upload Error:", error.message);
        throw error;
    }
    
    // 4. Return path
    return data.path;
  } catch (error: any) {
    console.error("Upload failed:", error.message || error);
    return null;
  }
};

export const getImageUrl = (path: string | null | undefined): string | null => {
  if (!path) return null;
  const { data } = supabase.storage.from('vocab-images').getPublicUrl(path);
  return data.publicUrl;
};

const IMAGE_ASSET_URL_HEAL_FLAG = 'vibe_word_img_url_heal_v1';

/**
 * 一次性自愈：修复 image_assets 里被【双重 URL 编码】的 public_url。
 *
 * 背景：旧版 imageProcessAndUpload.ts 用 encodeURIComponent 预编码词再交给 getPublicUrl，
 * 后者又编一次 → 多词短语（如 "get up"）的 public_url 变成 get%2520up.webp，
 * 而 storage 实际存的 key 是解码后的 "get up"，于是 400 加载失败。单词无空格不受影响。
 *
 * 写 image_assets 需要登录身份（anon 被 RLS 挡），所以由前端登录后调用。
 * localStorage 标记保证每个客户端只跑一次；坏数据被任意一个客户端修完后，
 * 后续客户端 SELECT 命中 0 行，自然 no-op。
 */
export const healDoubleEncodedImageUrls = async (): Promise<number> => {
  if (typeof window !== 'undefined' && window.localStorage.getItem(IMAGE_ASSET_URL_HEAL_FLAG)) {
    return 0;
  }
  try {
    // 取所有 normalized_word 含空格的 asset（双重编码只可能出现在多词短语上）
    const { data: rows, error } = await supabase
      .from('image_assets')
      .select('id, language, normalized_word, public_url')
      .like('normalized_word', '* *');
    if (error) throw error;

    const broken = (rows || []).filter((r: any) => typeof r.public_url === 'string' && r.public_url.includes('%2520'));
    let fixed = 0;
    for (const r of broken) {
      const word = String(r.normalized_word || '').trim();
      const lang = String(r.language || 'en').trim();
      // 与修复后的上传逻辑一致：传未编码路径，getPublicUrl 单次编码
      const storagePath = `images/${lang}/${word}.webp`;
      const { data: urlData } = supabase.storage.from('word-images').getPublicUrl(storagePath);
      const { error: ue } = await supabase
        .from('image_assets')
        .update({ public_url: urlData.publicUrl, storage_path: storagePath })
        .eq('id', r.id);
      if (!ue) fixed += 1;
    }

    // 只有全部修完（或本就无坏数据）才打标，避免部分失败时漏修；失败则下次登录重试
    if (typeof window !== 'undefined' && fixed === broken.length) {
      window.localStorage.setItem(IMAGE_ASSET_URL_HEAL_FLAG, '1');
    }
    if (fixed > 0) console.log(`[image-heal] fixed ${fixed}/${broken.length} double-encoded image_assets rows`);
    return fixed;
  } catch (e) {
    console.warn('[image-heal] skipped:', e);
    return 0;
  }
};


export const fetchUserData = async (userId: string) => {
  // Fetch Sessions (Filtered: Not deleted)
  const { data: sessionsData, error: sessionsError } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .or('deleted.eq.false,deleted.is.null') // Ensure we only get active sessions
    .order('created_at', { ascending: false });
    
  if (sessionsError) {
      console.error("Supabase Error fetching sessions:", sessionsError.message);
      throw new Error(`Failed to load sessions: ${sessionsError.message}`);
  }

  // Fetch Words (Filtered: Not deleted) - with pagination to handle > 1000 words
  const wordsData: any[] = [];
  let page = 0;
  const PAGE_SIZE = 1000;
  let hasMore = true;
  
  while (hasMore) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    
    const { data: pageData, error: wordsError } = await supabase
      .from('words')
      .select('*')
      .eq('user_id', userId)
      .or('deleted.eq.false,deleted.is.null')
      .range(from, to);

    if (wordsError) {
      console.error("Supabase Error fetching words:", wordsError.message);
      throw new Error(`Failed to load words: ${wordsError.message}`);
    }
    
    if (!pageData || pageData.length === 0) {
      hasMore = false;
    } else {
      wordsData.push(...pageData);
      hasMore = pageData.length === PAGE_SIZE;
      page++;
    }
  }
  
  console.log(`[fetchUserData] Loaded ${wordsData.length} words for user`);

  // 读时兜底：把已有共享图但 image_asset_id 仍为 null 的词懒回链（覆盖所有加词入口与历史数据）
  await backfillMissingImageAssets(wordsData);

  // Map DB structure to App Interface
  // Note: We calculate wordCount and timestamp dynamically based on the actual words fetched
  // to ensure the UI always reflects the latest activity, regardless of stale metadata.
  const sessions: InputSession[] = (sessionsData || []).map((s: any) => {
    const libraryTag = s.library_tag || 'Custom';
    
    // For library sessions (non-Custom), count words by tags to match LibraryMode filtering
    // For Custom sessions, count words by session_id
    let sessionWords: any[];
    if (libraryTag !== 'Custom') {
      // Count all words that have this library tag
      sessionWords = (wordsData || []).filter((w: any) => {
        const tags = w.tags && w.tags.length > 0 ? w.tags : ['Custom'];
        return tags.includes(libraryTag);
      });
    } else {
      // Custom session: count by session_id
      sessionWords = (wordsData || []).filter((w: any) => w.session_id === s.id);
    }
    
    const lastWordTime = sessionWords.length > 0 
      ? Math.max(...sessionWords.map(w => new Date(w.created_at).getTime()))
      : 0;

    return {
      id: s.id,
      timestamp: Math.max(new Date(s.created_at).getTime(), lastWordTime),
      wordCount: sessionWords.length,
      targetCount: s.target_count,
      deleted: s.deleted || false,
      libraryTag,
      syncStatus: 'synced' as const  // ✅ 云端数据都是已同步的
    };
  }).filter(s => s.wordCount > 0); // Remove sessions that have no active words (Zombies)

  const words: WordEntry[] = (wordsData || []).map((w: any) => ({
    id: w.id,
    text: w.text,
    timestamp: new Date(w.created_at).getTime(),
    sessionId: w.session_id,
    correct: w.correct,
    tested: w.tested,
    image_path: w.image_path,
    image_url: getImageUrl(w.image_path), // Will be updated below if asset exists
    image_asset_id: w.image_asset_id || null,
    error_count: w.error_count || 0,
    best_time_ms: w.best_time_ms || null,
    last_tested: w.last_tested ? new Date(w.last_tested).getTime() : null,
    phonetic: w.phonetic || null,
    audio_url: w.audio_url || null,
    language: w.language || 'en',
    lexeme_id: w.lexeme_id || null,
    definition_cn: w.definition_cn || null,
    definition_en: w.definition_en || null,
    meaning_options: Array.isArray(w.meaning_options) ? w.meaning_options : [],
    selected_meaning_key: w.selected_meaning_key || null,
    deleted: w.deleted || false,
    tags: w.tags || ['Custom'],
    consecutive_correct: w.consecutive_correct || 0,
    review_state: w.review_state || null,
    learning_revision: w.learning_revision || 0
  }));

  // Batch-resolve image URLs from shared image_assets
  const assetIds = [...new Set(words.filter(w => w.image_asset_id).map(w => w.image_asset_id!))];
  if (assetIds.length > 0) {
    const { data: assets } = await supabase
      .from('image_assets')
      .select('id, public_url')
      .in('id', assetIds)
      .eq('status', 'ready');

    if (assets && assets.length > 0) {
      const assetUrlMap = new Map<string, string>(assets.map((a: { id: string; public_url: string }) => [a.id, a.public_url]));
      for (const word of words) {
        if (word.image_asset_id) {
          const assetUrl = assetUrlMap.get(word.image_asset_id);
          if (assetUrl) {
            word.image_url = assetUrl;
          }
        }
      }
    }
  }

  return { sessions, words: overlayLearningProgress(userId, words) };
};

export const saveSessionData = async (
  userId: string, 
  targetCount: number, 
  wordList: { text: string, imageBase64?: string, language?: string, definition_cn?: string, definition_en?: string, meaning_options?: WordMeaningOption[] | null, selected_meaning_key?: string | null }[],
  libraryTag: string = 'Custom'
) => {
  // 0. Global Deduplication Check
  // Filter out words that already exist globally for this user (Active words only)
  const texts = wordList.map(w => w.text);
  const { data: existing } = await supabase
      .from('words')
      .select('text')
      .eq('user_id', userId)
      .in('text', texts)
      .or('deleted.eq.false,deleted.is.null');

  const existingSet = new Set((existing || []).map((e: any) => e.text));
  const uniqueWordList = wordList.filter(w => !existingSet.has(w.text));

  // Log dropped words for debugging
  if (wordList.length > uniqueWordList.length) {
    console.log(`[saveSessionData] Dropped ${wordList.length - uniqueWordList.length} duplicate words:`, 
        wordList.filter(w => existingSet.has(w.text)).map(w => w.text));
  }

  // 1. Create Session
  const { data: sessionData, error: sessionError } = await supabase
    .from('sessions')
    .insert({
      user_id: userId,
      word_count: uniqueWordList.length,
      target_count: targetCount,
      library_tag: libraryTag
    })
    .select()
    .single();

  if (sessionError) {
      console.error("Error creating session:", sessionError.message);
      throw sessionError;
  }

  // 2. Process Words (no client-side image upload - edge function handles it)
  const wordsPayload = [];

  for (const w of uniqueWordList) {
    wordsPayload.push({
      user_id: userId,
      session_id: sessionData.id,
      text: w.text,
      language: w.language || 'en',
      definition_cn: w.definition_cn || null,
      definition_en: w.definition_en || null,
      meaning_options: w.meaning_options || [],
      selected_meaning_key: w.selected_meaning_key || null,
      tags: [libraryTag]
    });
  }

  // 3. Bulk Insert Words
  let wordsData = [];
  if (wordsPayload.length > 0) {
    const { data, error: wordsError } = await executeWordsMutationWithCompatibility<Record<string, unknown>[]>(
      () => supabase
        .from('words')
        .insert(wordsPayload)
        .select(),
      () => supabase
        .from('words')
        .insert(wordsPayload.map(stripMeaningFields))
        .select(),
      'saveSessionData.insert'
    );

    if (wordsError) {
        console.error("Error inserting words:", wordsError.message);
        throw wordsError;
    }
    wordsData = data || [];

    if (wordsData?.length) {
      triggerPronunciationBatch(wordsData.map((w: any) => ({ text: w.text, language: w.language })));
      // 先回链已存在的跨用户共享图；只对真正缺失的词触发生成（避免对已有共享图重复请求）
      linkAndGenerateImages(wordsData.map((w: any) => ({ id: w.id, text: w.text, language: w.language })));
    }
  }


  // 4. Final Sync: Ensure word_count matches actual inserted words
  const { count: finalCount } = await supabase
    .from('words')
    .select('*', { count: 'exact', head: true })
    .eq('session_id', sessionData.id)
    .eq('user_id', userId);

  if (finalCount !== null && finalCount !== wordList.length) {
    await supabase
      .from('sessions')
      .update({ word_count: finalCount })
      .eq('id', sessionData.id)
      .eq('user_id', userId);
  }

  return { sessionData, wordsData: wordsData || [] };
};

export const modifySession = async (
  userId: string,
  sessionId: string,
  addedWords: { text: string, imageBase64?: string, definition_cn?: string, definition_en?: string, language?: string, meaning_options?: WordMeaningOption[] | null, selected_meaning_key?: string | null }[],
  removedWordIds: string[],
  updatedWords: { id: string, text: string, imageBase64?: string, definition_cn?: string, definition_en?: string, language?: string, meaning_options?: WordMeaningOption[] | null, selected_meaning_key?: string | null }[] = []
) => {
    // Get session's library_tag - words added to this session belong to its library
    const { data: sessionInfo } = await supabase
        .from('sessions')
        .select('library_tag')
        .eq('id', sessionId)
        .single();
    
    const libraryTag = sessionInfo?.library_tag || 'Custom';
    
    // 1. Delete Removed Words (Soft Delete)
    if (removedWordIds.length > 0) {
        const { error: delError } = await supabase
            .from('words')
            .update({ deleted: true, deleted_at: new Date().toISOString() })
            .in('id', removedWordIds);
        
        if (delError) {
            console.error("Error deleting words:", delError.message);
            throw delError;
        }

        _drainPronunciationStorageCleanupQueue().catch(err =>
          console.warn('[modifySession] Storage cleanup queue warning:', err?.message || err)
        );
    }

    // 2. Add New Words - they belong to the session's library
    const newWordsData: any[] = [];
    if (addedWords.length > 0) {
        // Global Deduplication Check
        const texts = addedWords.map(w => w.text);
        const { data: existing } = await supabase
            .from('words')
            .select('text')
            .eq('user_id', userId)
            .in('text', texts)
            .or('deleted.eq.false,deleted.is.null');

        const existingSet = new Set((existing || []).map((e: any) => e.text));
        const uniqueAddedWords = addedWords.filter(w => !existingSet.has(w.text));

        if (addedWords.length > uniqueAddedWords.length) {
            console.log(`[modifySession] Dropped ${addedWords.length - uniqueAddedWords.length} duplicate words:`, 
                addedWords.filter(w => existingSet.has(w.text)).map(w => w.text));
        }

        const wordsPayload = [];
        for (const w of uniqueAddedWords) {
            wordsPayload.push({
                user_id: userId,
                session_id: sessionId,
                text: w.text,
              language: w.language || 'en',
              definition_cn: w.definition_cn || null,
              definition_en: w.definition_en || null,
              meaning_options: w.meaning_options || [],
              selected_meaning_key: w.selected_meaning_key || null,
                tags: [libraryTag]
            });
        }

        if (wordsPayload.length > 0) {
          const { data, error: insError } = await executeWordsMutationWithCompatibility<Record<string, unknown>[]>(
            () => supabase
              .from('words')
              .insert(wordsPayload)
              .select(),
            () => supabase
              .from('words')
              .insert(wordsPayload.map(stripMeaningFields))
              .select(),
            'modifySession.insert'
          );
                
            if (insError) {
                console.error("Error adding words to session:", insError.message);
                throw insError;
            }
            if (data) newWordsData.push(...data);
            if (data?.length) {
              triggerPronunciationBatch(data.map((w: any) => ({ text: w.text, language: w.language })));
              linkAndGenerateImages(data.map((w: any) => ({ id: w.id, text: w.text, language: w.language })));
            }
        }
    }

    // 2.5 Update Existing Words
    // 2.5 Update Existing Words
    if (updatedWords && updatedWords.length > 0) {
        console.log(`Updating ${updatedWords.length} existing words...`);
        for (const w of updatedWords) {
            const updates: any = { text: w.text };
          if (w.language) updates.language = w.language;
          if (w.definition_cn) updates.definition_cn = w.definition_cn;
          if (w.definition_en) updates.definition_en = w.definition_en;
          if (w.meaning_options) updates.meaning_options = w.meaning_options;
          if (w.selected_meaning_key !== undefined) updates.selected_meaning_key = w.selected_meaning_key;
            
            // Image is now handled by the edge function (shared storage)
            // If a new imageBase64 is provided, trigger regeneration via edge function
            if (w.imageBase64) {
                triggerImageGenerationBatch([{ text: w.text, language: w.language }]);
            }

            const { error: upError } = await executeWordsMutationWithCompatibility(
              () => supabase
                .from('words')
                .update(updates)
                .eq('id', w.id)
                .eq('user_id', userId),
              () => supabase
                .from('words')
                .update(stripMeaningFields(updates))
                .eq('id', w.id)
                .eq('user_id', userId),
              'modifySession.update'
            );

            if (upError) {
                console.error(`Error updating word ${w.id}:`, upError.message);
                throw upError;
            }
        }
    }

    // 3. Update Session Count & Modification Time - Recalculate accurately
    // We count the words currently associated with this session to ensure consistency.
    const { count, error: countError } = await supabase
        .from('words')
        .select('*', { count: 'exact', head: true })
        .eq('session_id', sessionId)
        .eq('user_id', userId)
        .or('deleted.eq.false,deleted.is.null'); // Ensure we ignore deleted words

    if (countError) {
        console.error("Error counting words:", countError.message);
    }

    // Always update word_count and created_at (as editing time)
    const finalCount = count !== null ? count : 0;
    const { error: updateError } = await supabase
        .from('sessions')
        .update({ 
            word_count: finalCount,
            target_count: finalCount, // Align target count with actual count
            created_at: new Date().toISOString() // Bump timestamp to now for "Editing Time"
        })
        .eq('id', sessionId)
        .eq('user_id', userId);

    if (updateError) {
        console.error("Error updating session metadata:", updateError.message);
    }

    return { newWordsData };
};

// V2 Stats with Frozen History & Daily Buffer
export const fetchUserStats = async (userId: string) => {
    const { data, error } = await supabase
        .from('daily_stats')
        .select('*')
        .eq('user_id', userId);
        
    if (error) {
        console.error("Error fetching daily stats:", error.message);
        throw new Error(`Failed to load stats: ${error.message}`);
    }
    return data || [];
};

export const syncDailyStats = async () => {
    // Calculate client's timezone offset in hours (e.g., -480 minutes / 60 = -8, so we negate it to get +8)
    // Date.getTimezoneOffset() returns positive for West, negative for East.
    // China (+8) returns -480. New York (-5) returns 300.
    // We want the adder value: China = +8. So we negate the result.
    const offsetHours = Math.round(-(new Date().getTimezoneOffset() / 60));

    // Try the new dynamic function first
    const { error } = await supabase.rpc('sync_todays_stats_with_timezone', {
      p_timezone_offset_hours: offsetHours
    });

    // Fallback to old function if new one doesn't exist yet (during migration)
    if (error) {
       console.warn("Dynamic sync failed, falling back to static:", error.message);
       await supabase.rpc('sync_todays_stats');
    }
};

/**
 * ✨ NEW: Record a test session and incrementally update statistics
 * This is the preferred method for recording test results
 * @param userId - User ID
 * @param testCount - Number of words tested in this session
 * @param correctCount - Number of correct answers in this session
 * @param points - Points earned in this session
 * @returns The updated aggregated statistics
 */
export const recordTestAndSyncStats = async (
  testCount: number,
  correctCount: number,
  points: number,
  expectedVersion: number | undefined,
  event: { eventId: string; occurredAt: number; userId: string },
) => {
  const item = {
    id: event.eventId, userId: event.userId, timestamp: event.occurredAt,
    date: getShanghaiDateString(event.occurredAt), testCount, correctCount, points,
    expectedVersion: expectedVersion ?? 0,
  };
  validateTestStatsEvent(item);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || user?.id !== event.userId) throw new Error('统计记录与当前登录账号不匹配。');
  const { data, error } = await supabase.rpc('record_test_event_v1', {
    p_expected_user_id: event.userId,
    p_event_id: event.eventId,
    p_occurred_at: new Date(event.occurredAt).toISOString(),
    p_test_count: testCount,
    p_correct_count: correctCount,
    p_points: points,
  });
  // Retrying a non-idempotent legacy RPC can award a completed test twice.
  if (error) throw new Error(`统计记录仍待同步：${error.message}`);
  return parseTestStatsReceipt(data, item);
};

/**
 * ✨ NEW: Get today's statistics (aggregated from test records)
 * This returns accurate incremental statistics
 */
export const getTodaysStats = async () => {
    const offsetHours = Math.round(-(new Date().getTimezoneOffset() / 60));

    const { data, error } = await supabase.rpc('get_todays_stats', {
        p_timezone_offset_hours: offsetHours
    });

    if (error) {
        console.error("Error fetching today's stats:", error.message);
        return null;
    }

    return Array.isArray(data) && data.length > 0 ? data[0] : data;
};

export const recordPuzzleGameRound = async (summary: PuzzleGameSummary) => {
  const clientDate = getShanghaiDateString();

  const { data, error } = await supabase.rpc('record_puzzle_game_round', {
    p_total_score: summary.totalScore,
    p_accuracy_rate: summary.accuracyRate,
    p_speed_score: summary.speedScore,
    p_no_hint_score: summary.noHintScore,
    p_time_used_seconds: summary.timeUsedSeconds,
    p_seconds_remaining: summary.secondsRemaining,
    p_hints_used: summary.hintsUsed,
    p_words_total: summary.wordsTotal,
    p_words_correct: summary.wordsCorrect,
    p_solved_without_hint: summary.solvedWithoutHint,
    p_selection_mode: summary.selectionMode,
    p_client_date: clientDate,
  });

  if (error) {
    console.error('[recordPuzzleGameRound] Failed to record puzzle round:', error.message);
    throw error;
  }

  return Array.isArray(data) && data.length > 0 ? data[0] : data;
};

export const fetchPuzzleGameLeaderboard = async (
  scope: PuzzleLeaderboardScope,
  metric: PuzzleLeaderboardMetric,
  date?: Date,
  limit: number = 3,
): Promise<PuzzleLeaderboardEntry[]> => {
  const targetDate = date || new Date();
  const year = targetDate.getFullYear();
  const month = String(targetDate.getMonth() + 1).padStart(2, '0');
  const day = String(targetDate.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;

  const { data, error } = await supabase.rpc('get_puzzle_game_leaderboard', {
    p_scope: scope,
    p_metric: metric,
    p_date: dateStr,
    p_limit: limit,
  });

  if (error) {
    console.error('[fetchPuzzleGameLeaderboard] Failed to fetch puzzle leaderboard:', error.message);
    throw error;
  }

  return (data || []) as PuzzleLeaderboardEntry[];
};

export const recordWordStrikeRound = async (summary: WordStrikeGameSummary) => {
  const clientDate = getShanghaiDateString();

  const { data, error } = await supabase.rpc('record_word_strike_round', {
    p_total_score: summary.totalScore,
    p_accuracy_rate: summary.accuracyRate,
    p_speed_score: summary.speedScore,
    p_combo_score: summary.comboScore,
    p_time_used_seconds: summary.timeUsedSeconds,
    p_lives_lost: summary.livesLost,
    p_lives_remaining: summary.livesRemaining,
    p_max_combo: summary.maxCombo,
    p_letters_hit: summary.lettersHit,
    p_letters_fired: summary.lettersFired,
    p_words_total: summary.wordsTotal,
    p_words_correct: summary.wordsCorrect,
    p_selection_mode: summary.selectionMode,
    p_client_date: clientDate,
  });

  if (error) {
    console.error('[recordWordStrikeRound] Failed to record word strike round:', error.message);
    throw error;
  }

  return Array.isArray(data) && data.length > 0 ? data[0] : data;
};

export const fetchWordStrikeLeaderboard = async (
  scope: WordStrikeLeaderboardScope,
  metric: WordStrikeLeaderboardMetric,
  date?: Date,
  limit: number = 3,
): Promise<WordStrikeLeaderboardEntry[]> => {
  const targetDate = date || new Date();
  const year = targetDate.getFullYear();
  const month = String(targetDate.getMonth() + 1).padStart(2, '0');
  const day = String(targetDate.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;

  const { data, error } = await supabase.rpc('get_word_strike_leaderboard', {
    p_scope: scope,
    p_metric: metric,
    p_date: dateStr,
    p_limit: limit,
  });

  if (error) {
    console.error('[fetchWordStrikeLeaderboard] Failed to fetch word strike leaderboard:', error.message);
    throw error;
  }

  return (data || []) as WordStrikeLeaderboardEntry[];
};

export const updateWordStatus = async (wordId: string, correct: boolean) => {
  const { error } = await supabase
    .from('words')
    .update({ 
      correct: correct, 
      tested: true,
      last_tested: new Date().toISOString()
    })
    .eq('id', wordId);
    
  if (error) console.error("Error updating word status:", error.message);
  
  // Sync stats (Fire & Forget)
  syncDailyStats();
};

/**
 * Apply error decay mechanism: reduce error_count when user consistently answers correctly
 * Uses WORD_LEARNING_CONFIG.errorDecay for configuration
 * @param wordId - The word ID
 * @param currentErrorCount - Current error_count
 * @param currentConsecutiveCorrect - Current consecutive_correct count
 * @returns Updated error_count and consecutive_correct
 */
const applyErrorDecay = async (
  wordId: string,
  currentErrorCount: number,
  currentConsecutiveCorrect: number
): Promise<{ newErrorCount: number; newConsecutiveCorrect: number; shouldRemoveMistakeTag: boolean }> => {
  const errorDecayConfig = WORD_LEARNING_CONFIG.errorDecay;
  const newConsecutiveCorrect = currentConsecutiveCorrect + 1;
  let newErrorCount = currentErrorCount;
  let shouldRemoveMistakeTag = false;

  // Check if threshold reached (using config)
  if (newConsecutiveCorrect >= errorDecayConfig.consecutiveCorrectThreshold && currentErrorCount > 0) {
    newErrorCount = Math.max(0, currentErrorCount - errorDecayConfig.decrementAmount);
    // Reset consecutive_correct after successful decay
    const finalConsecutiveCorrect = 0;

    if (WORD_LEARNING_CONFIG.debug.logErrorDecay) {
      console.log('🎉 [Error Decay] Reducing error_count:', {
        wordId,
        oldErrorCount: currentErrorCount,
        newErrorCount: newErrorCount,
        threshold: errorDecayConfig.consecutiveCorrectThreshold
      });
    }

    // If error_count reached 0, mark for Mistake tag removal
    if (newErrorCount === 0) {
      shouldRemoveMistakeTag = true;
      if (WORD_LEARNING_CONFIG.debug.logErrorDecay) {
        console.log('✨ [Error Decay] Removing Mistake tag for word:', wordId);
      }
    }

    return { newErrorCount, newConsecutiveCorrect: finalConsecutiveCorrect, shouldRemoveMistakeTag };
  }

  return { newErrorCount, newConsecutiveCorrect: newConsecutiveCorrect, shouldRemoveMistakeTag };
};

/**
 * Remove Mistake tag from a word
 */
const removeMistakeTag = async (wordId: string): Promise<void> => {
  // First, get current tags
  const { data: currentWord } = await supabase
    .from('words')
    .select('tags')
    .eq('id', wordId)
    .single();

  if (!currentWord) return;

  const currentTags = currentWord.tags || ['Custom'];
  const newTags = currentTags.filter((t: string) => t !== 'Mistake');

  // Only update if tags changed
  if (newTags.length !== currentTags.length) {
    const { error } = await supabase
      .from('words')
      .update({ tags: newTags.length > 0 ? newTags : ['Custom'] })
      .eq('id', wordId);

    if (error) {
      console.error('[Error Decay] Failed to remove Mistake tag:', error.message);
    } else {
      console.log('✨ [Error Decay] Mistake tag removed successfully for word:', wordId);
    }
  }
};

export const updateWordStatusV2 = async (
  wordId: string,
  updates: {
    correct: boolean,
    score?: number,
    error_count_increment?: number,
    best_time_ms?: number,
    phonetic?: string,
    audio_url?: string,
    language?: string,
    definition_cn?: string,
    definition_en?: string,
    // New parameters for error decay
    hasUsedHint?: boolean,
    consecutiveCorrect?: number,
    hadMistake?: boolean,
    occurredAt?: number,
    reviewState?: ReviewState
  }
) => {
  const { data: currentWord, error: readError } = await supabase
    .from('words')
    .select('*')
    .eq('id', wordId)
    .single();

  if (readError || !currentWord) throw new Error(readError?.message || 'Word progress was not found');
  const reviewedAt = updates.occurredAt || Date.now();
  const reviewWord = { ...currentWord, last_tested: currentWord.last_tested ? new Date(currentWord.last_tested).getTime() : null };
  const nextReview = updates.reviewState || updateReviewState(reviewWord, !updates.correct ? 'incorrect' : updates.hasUsedHint || updates.hadMistake ? 'assisted' : 'independent', reviewedAt);
  const spacedRecall = nextReview.repetitions > (getReviewSchedule(reviewWord, reviewedAt).state?.repetitions || 0);

  const currentErrorCount = currentWord?.error_count || 0;
  const currentConsecutiveCorrect = currentWord?.consecutive_correct || 0;

  // Calculate new error_count (basic increment)
  let new_error_count = currentErrorCount + (updates.error_count_increment || 0);
  let new_consecutive_correct = currentConsecutiveCorrect;
  let shouldRemoveMistakeTag = false;

  // Error Decay Logic: Only apply if correct AND no hint was used
  if (updates.correct && !updates.hasUsedHint && !updates.hadMistake && updates.score && updates.score >= 3) {
    if (spacedRecall) {
      const decayResult = await applyErrorDecay(wordId, new_error_count, new_consecutive_correct);
      new_error_count = decayResult.newErrorCount;
      new_consecutive_correct = decayResult.newConsecutiveCorrect;
      shouldRemoveMistakeTag = decayResult.shouldRemoveMistakeTag;
    }
  } else {
    // Reset consecutive_correct on incorrect answer or hint usage
    if (new_consecutive_correct > 0) {
      console.log('🔄 [Error Decay] Resetting consecutive_correct:', {
        wordId,
        previousValue: new_consecutive_correct,
        reason: updates.hasUsedHint ? 'hint used' : 'incorrect answer'
      });
    }
    new_consecutive_correct = 0;
  }

  let new_best_time = currentWord?.best_time_ms;
  if (updates.correct && updates.best_time_ms) {
    new_best_time = new_best_time ? Math.min(new_best_time, updates.best_time_ms) : updates.best_time_ms;
  }

  const payload: any = {
    correct: updates.correct,
    score: updates.score,
    tested: true,
    last_tested: new Date(updates.occurredAt || Date.now()).toISOString(),
    error_count: new_error_count,
    best_time_ms: new_best_time,
    consecutive_correct: new_consecutive_correct
  };

  if (currentWord && Object.hasOwn(currentWord, 'review_state')) {
    payload.review_state = nextReview;
  }

  if (updates.phonetic) payload.phonetic = updates.phonetic;
  if (updates.audio_url) payload.audio_url = updates.audio_url;
  if (updates.language) payload.language = updates.language;
  if (updates.definition_cn) payload.definition_cn = updates.definition_cn;
  if (updates.definition_en) payload.definition_en = updates.definition_en;

  const { error } = await supabase
    .from('words')
    .update(payload)
    .eq('id', wordId);

  if (error) throw new Error(`Failed to save word progress: ${error.message}`);

  // Remove Mistake tag if error_count reached 0
  if (shouldRemoveMistakeTag) {
    await removeMistakeTag(wordId);
  }

  // NOTE: Stats sync is now handled at test session completion time
  // via recordTestAndSyncStats(), which records to daily_test_records
  // and aggregates to daily_stats incrementally.
  // Individual word updates no longer trigger immediate stats sync.
};

/**
 * Single row from any game mode's per-word results. Used by
 * syncGameResultsToWordStats to feed the same word-stats pipeline that
 * CLASSIC mode uses (error_count, consecutive_correct, last_tested),
 * so the adaptive word selector sees consistent data across ALL modes.
 */
export interface GameWordResult {
  wordId: string;
  correct: boolean;
  hintUsed: boolean;
  /** Solved duration in ms (used to update best_time_ms). Optional. */
  durationMs?: number | null;
}

/**
 * Sync per-word results from a game mode (Puzzle / Word Strike / future modes)
 * into the words table, triggering the SAME error-decay + consecutive_correct
 * + last_tested updates that CLASSIC mode performs via updateWordStatusV2.
 *
 * Why this exists: before this helper, only CLASSIC mode wrote word stats.
 * Games only recorded round-level scores to their leaderboard
 * tables, so the adaptive word selector kept picking the same high-error
 * words forever — answering them right in a game mode never lowered their
 * weight. This helper fixes that by giving every game mode a single line
 * to call: `await syncGameResultsToWordStats(summary.results.map(...))`.
 *
 * Contract for new game modes:
 *   1. Build your per-word result with { wordId, correct, hintUsed }
 *   2. Call this helper inside your `onComplete` BEFORE recording the round
 *   3. Don't call updateWordStatusV2 directly — go through this helper so
 *      the scoring rules (score=3 on correct, +1 error_count on wrong)
 *      stay uniform across modes.
 *
 * Errors are logged but non-fatal — a failed word-stats sync must not block
 * the round from being recorded.
 */
export const syncGameResultsToWordStats = async (results: GameWordResult[]): Promise<void> => {
  // Serial loop because updateWordStatusV2 does a read-then-write
  // (SELECT current error_count → compute new → UPDATE). Parallel calls
  // on the same user's words can race and lose increments.
  for (const r of results) {
    if (!r.wordId) continue;
    try {
      await updateWordStatusV2(r.wordId, {
        correct: r.correct,
        // Score 3 mirrors CLASSIC's "direct correct (no hint)" path, which
        // is the threshold for triggering error decay. Game modes today
        // don't expose a "hint" path that maps cleanly to score=2.4, so we
        // treat all correct answers as full-score. hintUsed still blocks
        // decay because hasUsedHint short-circuits it inside updateWordStatusV2.
        score: r.correct ? 3 : 0,
        error_count_increment: r.correct ? 0 : 1,
        hasUsedHint: r.hintUsed,
        best_time_ms: r.correct && r.durationMs ? r.durationMs : undefined,
      });
    } catch (err) {
      console.error('[syncGameResultsToWordStats] word sync failed:', r.wordId, err);
    }
  }
};

export const updateWordImage = async (wordId: string, imagePath: string) => {
  const { error } = await supabase
    .from('words')
    .update({ 
      image_path: imagePath
    })
    .eq('id', wordId);
    
  if (error) console.error("Error updating word image:", error.message);
};

/**
 * Update word metadata like audio URL and phonetic transcription
 */
export const updateWordMetadata = async (wordId: string, updates: { 
  audio_url?: string, 
  phonetic?: string,
  definition_cn?: string,
  definition_en?: string,
  language?: string,
  meaning_options?: WordMeaningOption[] | null,
  selected_meaning_key?: string | null,
}, expectedUserId?: string) => {
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user || (expectedUserId && user.id !== expectedUserId)) throw new Error('单词信息与当前账号不匹配。');
  const { data, error } = await executeWordsMutationWithCompatibility<Array<{ id: string }>>(
    () => supabase
      .from('words')
      .update(updates)
      .eq('id', wordId).eq('user_id', user.id).select('id'),
    () => supabase
      .from('words')
      .update(stripMeaningFields(updates))
      .eq('id', wordId).eq('user_id', user.id).select('id'),
    'updateWordMetadata'
  );
    
  if (error || !data?.length) throw new Error(error?.message || '单词信息未保存，可能已删除或账号发生变化。');
};

export const generateSRSQueue = (
    allWords: WordEntry[],
    selectedWordIds: string[],
    targetSize: number = 20
): WordEntry[] => {
    const ids = new Set(selectedWordIds);
    const pool = ids.size ? allWords.filter(word => ids.has(word.id)) : allWords;
    return adaptiveWordSelector.calculateQueue(allWords, pool, targetSize);
};

export interface DeleteProgress {
  step: 'fetching' | 'deleting-words' | 'deleting-sessions' | 'cleaning-tags' | 'complete';
  message: string;
  current?: number;
  total?: number;
}

export const deleteSessions = async (
  userId: string, 
  sessionIds: string[],
  onProgress?: (progress: DeleteProgress) => void
) => {
  console.log('[deleteSessions] START - userId:', userId, 'sessionIds:', sessionIds);
  
  if (!sessionIds || sessionIds.length === 0) {
    console.log('[deleteSessions] Early return: no session IDs');
    return;
  }

  onProgress?.({ step: 'fetching', message: 'Preparing to delete...' });

  // First, get the library tags of sessions being deleted
  const { data: sessionsToDelete, error: fetchError } = await supabase
    .from('sessions')
    .select('id, library_tag')
    .in('id', sessionIds)
    .eq('user_id', userId);

  if (fetchError) {
    console.error('[deleteSessions] Error fetching sessions:', fetchError);
  }
  console.log('[deleteSessions] Sessions to delete:', sessionsToDelete);

  const libraryTagsToClean = new Set<string>();
  sessionsToDelete?.forEach(s => {
    if (s.library_tag && s.library_tag !== 'Custom') {
      libraryTagsToClean.add(s.library_tag);
    }
  });

  // 1. Soft Delete words that belong to these sessions
  onProgress?.({ step: 'deleting-words', message: 'Deleting words...' });
  console.log('[deleteSessions] Step 1: Soft deleting words...');
  const { error: wordsError, data: wordsData, count: wordsCount } = await supabase
      .from('words')
      .update({ deleted: true, deleted_at: new Date().toISOString() })
      .in('session_id', sessionIds)
      .eq('user_id', userId)
      .select();

  if (wordsError) {
      console.error("[deleteSessions] Error deleting session words:", wordsError.message);
      throw wordsError;
  }
  const deletedWordsCount = wordsData?.length || 0;
  console.log('[deleteSessions] Words deleted:', deletedWordsCount);
  onProgress?.({ step: 'deleting-words', message: `Deleted ${deletedWordsCount} words`, current: deletedWordsCount, total: deletedWordsCount });

  _drainPronunciationStorageCleanupQueue().catch(err =>
    console.warn('[deleteSessions] Storage cleanup queue warning:', err?.message || err)
  );

  // 2. Soft Delete sessions
  onProgress?.({ step: 'deleting-sessions', message: 'Deleting sessions...' });
  console.log('[deleteSessions] Step 2: Soft deleting sessions...');
  const { error: sessionError, data: sessionData } = await supabase
      .from('sessions')
      .update({ deleted: true })
      .in('id', sessionIds)
      .eq('user_id', userId)
      .select();

  if (sessionError) {
      console.error("[deleteSessions] Error deleting sessions:", sessionError.message);
      throw sessionError;
  }
  console.log('[deleteSessions] Sessions deleted:', sessionData?.length || 0, sessionData);
  onProgress?.({ step: 'deleting-sessions', message: `Deleted ${sessionData?.length || 0} session(s)` });

  // 3. Clean up library tags from words in OTHER sessions
  // When deleting a library session (e.g., CET-6), we need to remove the CET-6 tag
  // from all words that have it, not just the words in the deleted session
  // 
  // PERFORMANCE FIX: Instead of updating each word individually (which caused 439+ requests),
  // we use a single RPC call or batch the updates efficiently.
  if (libraryTagsToClean.size > 0) {
    const tagsArray = Array.from(libraryTagsToClean);
    onProgress?.({ step: 'cleaning-tags', message: `Cleaning library tags: ${tagsArray.join(', ')}...` });
    console.log('[deleteSessions] Cleaning library tags:', tagsArray);
    
    for (const tag of libraryTagsToClean) {
      // Find all words with this tag (not deleted) - we need this to know which words to update
      const { data: wordsWithTag } = await supabase
        .from('words')
        .select('id, tags')
        .eq('user_id', userId)
        .or('deleted.eq.false,deleted.is.null')
        .contains('tags', [tag]);

      if (wordsWithTag && wordsWithTag.length > 0) {
        onProgress?.({ step: 'cleaning-tags', message: `Updating ${wordsWithTag.length} words with tag '${tag}'...`, current: 0, total: wordsWithTag.length });
        console.log(`[deleteSessions] Found ${wordsWithTag.length} words with tag '${tag}', updating in batches...`);
        
        // Group words by their resulting tags (after removing the current tag)
        const tagGroupMap = new Map<string, string[]>(); // key = sorted tags string, value = word ids
        
        for (const w of wordsWithTag) {
          const newTags = (w.tags || []).filter((t: string) => t !== tag);
          const finalTags = newTags.length > 0 ? newTags : ['Custom'];
          const key = JSON.stringify(finalTags.sort());
          
          if (!tagGroupMap.has(key)) {
            tagGroupMap.set(key, []);
          }
          tagGroupMap.get(key)!.push(w.id);
        }

        // Now batch update by tag group (words with same resulting tags)
        let totalUpdated = 0;
        for (const [tagsKey, wordIds] of tagGroupMap) {
          const newTags = JSON.parse(tagsKey);
          
          // Supabase supports updating multiple rows with .in()
          const { error: updateError } = await supabase
            .from('words')
            .update({ tags: newTags })
            .in('id', wordIds);
          
          if (updateError) {
            console.error(`[deleteSessions] Error updating batch:`, updateError);
          } else {
            totalUpdated += wordIds.length;
          }
        }

        console.log(`[deleteSessions] Removed tag '${tag}' from ${totalUpdated} words (${tagGroupMap.size} batch updates)`);
        onProgress?.({ step: 'cleaning-tags', message: `Cleaned tag '${tag}' from ${totalUpdated} words`, current: totalUpdated, total: totalUpdated });
      }
    }
  }
  
  onProgress?.({ step: 'complete', message: 'Delete completed!' });
  console.log('[deleteSessions] COMPLETE');
};

/**
 * Soft-delete individual words by their IDs.
 * Used by Library Mode to delete specific words without touching sessions.
 * After deletion, asynchronously drains queued pronunciation storage cleanup jobs.
 */
export const deleteWordsByIds = async (
  userId: string,
  wordIds: string[]
): Promise<void> => {
  if (!wordIds || wordIds.length === 0) return;
  console.log('[deleteWordsByIds] Soft-deleting words:', wordIds);

  const { error } = await supabase
    .from('words')
    .update({ deleted: true, deleted_at: new Date().toISOString() })
    .in('id', wordIds)
    .eq('user_id', userId);

  if (error) {
    console.error('[deleteWordsByIds] Error:', error.message);
    throw error;
  }
  console.log('[deleteWordsByIds] Done, deleted', wordIds.length, 'words');

  _drainPronunciationStorageCleanupQueue().catch(err =>
    console.warn('[deleteWordsByIds] Storage cleanup queue warning:', err?.message || err)
  );
};

/**
 * Fire-and-forget helper: drains queued pronunciation storage cleanup jobs.
 * DB triggers remove orphaned global audio rows immediately and enqueue
 * storage object deletion here.
 */
async function _drainPronunciationStorageCleanupQueue(): Promise<void> {
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const anonKey = process.env.SUPABASE_ANON_KEY || '';
  if (!supabaseUrl) return;

  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) return;

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/pronunciation-rebuild`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey': anonKey,
      },
      body: JSON.stringify({ action: 'drain_storage_cleanup_queue' }),
    });
    if (res.ok) {
      const body = await res.json();
      if ((body?.deleted_storage_objects || 0) > 0) {
        console.log(
          `[global-word-cleanup] Storage cleanup: removed ${body.deleted_storage_objects} file(s)`
        );
      } else {
        console.log('[global-word-cleanup] Storage cleanup: no queued files.');
      }
    } else {
      console.warn('[global-word-cleanup] Storage cleanup returned', res.status);
    }
  } catch (e: any) {
    console.warn('[global-word-cleanup] Storage cleanup fetch error:', e?.message);
  }
}

export const fetchUserAchievements = async (userId: string): Promise<string[]> => {
  const { data, error } = await supabase
    .from('user_achievements')
    .select('achievement_id')
    .eq('user_id', userId);

  if (error) {
    console.error('Error fetching achievements:', error);
    throw new Error(`Failed to load achievements: ${error.message}`);
  }

  return data.map(row => row.achievement_id);
};

export const saveUserAchievement = async (userId: string, achievementId: string): Promise<void> => {
  const { error } = await supabase
    .from('user_achievements')
    .upsert(
      { user_id: userId, achievement_id: achievementId },
      { onConflict: 'user_id, achievement_id', ignoreDuplicates: true }
    );

  if (error) {
    console.error('Error saving achievement:', error);
  }
};

export const getWordsMissingImage = async (userId: string) => {
  const { data, error } = await supabase
      .from('words')
      .select('*')
      .eq('user_id', userId)
      .or('deleted.eq.false,deleted.is.null')
      .is('image_path', null)
      .is('image_asset_id', null);

  if (error) {
      console.error("Error fetching words missing images:", error.message);
      return [];
  }
  return data || [];
};


export const importDictionaryWords = async (userId: string, words: string[], tag: string) => {
  // 1. Get or create a library-specific session
  // Each library (CET-4, CET-6, TOEFL, etc.) gets its own session
  // This allows proper organization and library-specific deduplication
  let sessionId: string;
  
  const { data: existingSessions } = await supabase
    .from('sessions')
    .select('id')
    .eq('user_id', userId)
    .eq('library_tag', tag)
    .or('deleted.eq.false,deleted.is.null') // Only active sessions
    .limit(1);

  if (existingSessions && existingSessions.length > 0) {
     sessionId = existingSessions[0].id;
  } else {
     const { data: newSession, error } = await supabase
        .from('sessions')
        .insert({
            user_id: userId,
            word_count: 0,
            target_count: -999,
            library_tag: tag
        })
        .select()
        .single();
     
     if (error) throw error;
     sessionId = newSession.id;
  }

  // 1.5 Validate Words (Filter single letters and check spelling)
  console.log(`[importDictionaryWords] Validating ${words.length} words...`);
  const validatedWords: string[] = [];
  for (const w of words) {
    const cleanText = w.trim();
    if (!cleanText) continue;

    // Rule 1: Single letter words (except 'a', 'i')
    if (cleanText.length < 2 && cleanText.toLowerCase() !== 'a' && cleanText.toLowerCase() !== 'i') continue;

    // Rule 2: Spell check
    // We use the local provider first via aiService
    // Skip LLM for bulk imports to ensure speed and prevent API throttling
    const result = await aiService.validateSpelling(cleanText, undefined, undefined, { skipLLM: true });
    if (result.isValid) {
        validatedWords.push(cleanText);
    } else if (result.suggestion) {
        // If it's a clear typo, use the suggestion
        validatedWords.push(result.suggestion);
    }
  }
  
  // Use validated words instead of original words
  const wordsToProcess = validatedWords;

  // 2. Fetch all existing ACTIVE words for deduplication and tagging
  // IMPORTANT: Supabase has a default limit of 1000 rows, so we need to paginate
  const wordMap = new Map<string, { id: string, tags: string[] }>();
  
  let page = 0;
  const PAGE_SIZE = 1000;
  let hasMore = true;
  
  while (hasMore) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    
    const { data: userWords, error: fetchError } = await supabase
      .from('words')
      .select('id, text, tags')
      .eq('user_id', userId)
      .or('deleted.eq.false,deleted.is.null')
      .range(from, to);
    
    if (fetchError) {
      console.error('[importDictionaryWords] Error fetching words page:', fetchError);
      break;
    }
    
    if (!userWords || userWords.length === 0) {
      hasMore = false;
    } else {
      userWords.forEach((w: any) => wordMap.set(w.text.toLowerCase().trim(), { id: w.id, tags: w.tags || [] }));
      hasMore = userWords.length === PAGE_SIZE;
      page++;
    }
  }
  
  console.log(`[importDictionaryWords] Loaded ${wordMap.size} existing words for deduplication`);
  
  const updates: any[] = [];
  const inserts: any[] = [];
  const processedTexts = new Set<string>();

  for (const w of wordsToProcess) {
    const cleanText = w.trim();
    if (!cleanText) continue;
    
    // Skip if we've already seen this word in this batch
    const lowerText = cleanText.toLowerCase();
    if (processedTexts.has(lowerText)) continue;
    processedTexts.add(lowerText);
    
    if (wordMap.has(lowerText)) {
      const existing = wordMap.get(lowerText)!;
      // Only update if tag doesn't exist
      if (!existing.tags.includes(tag)) {
        updates.push({
          id: existing.id,
          tags: [...existing.tags, tag]
        });
      }
    } else {
      inserts.push({
        user_id: userId,
        session_id: sessionId,
        text: cleanText, // Preserve case from list? Or lower?
        // Most lists are lowercase, but some might be Capitalized. 
        // We'll keep input case but use lower for comparison.
        tags: [tag],
        correct: false,
        tested: false,
        error_count: 0
      });
    }
  }

  console.log(`[importDictionaryWords] ${tag}: ${words.length} input words, ${inserts.length} to insert, ${updates.length} to update tags, ${words.length - inserts.length - updates.length} already complete`);

  // 3. Process Inserts (Batch Insert with smaller chunks to avoid limits)
  let insertedCount = 0;
  if (inserts.length > 0) {
      const CHUNK_SIZE = 500; // Smaller batch size to avoid Supabase limits
      for (let i = 0; i < inserts.length; i += CHUNK_SIZE) {
          const chunk = inserts.slice(i, i + CHUNK_SIZE);
          const { error } = await supabase.from('words').insert(chunk);
          
          if (error) {
            console.error(`[importDictionaryWords] Error inserting chunk ${Math.floor(i / CHUNK_SIZE) + 1}:`, error);
            // Don't throw, continue with next batch
          } else {
            insertedCount += chunk.length;
            console.log(`[importDictionaryWords] ✓ Inserted batch ${Math.floor(i / CHUNK_SIZE) + 1}: ${chunk.length} words (total: ${insertedCount}/${inserts.length})`);
            triggerPronunciationBatch(chunk.map((w: any) => ({ text: w.text, language: w.language })));
          }
      }
      console.log(`[importDictionaryWords] ✅ Completed: Inserted ${insertedCount}/${inserts.length} new words for ${tag}`);
  }
  
  // 4. Process Updates (Batch update tags)
  let updatedCount = 0;
  if (updates.length > 0) {
      const UPDATE_BATCH_SIZE = 100;
      for (let i = 0; i < updates.length; i += UPDATE_BATCH_SIZE) {
          const chunk = updates.slice(i, i + UPDATE_BATCH_SIZE);
          
          // Update in parallel within batch
          const results = await Promise.allSettled(
            chunk.map(u => 
              supabase.from('words').update({ tags: u.tags }).eq('id', u.id)
            )
          );
          
          const successful = results.filter(r => r.status === 'fulfilled').length;
          updatedCount += successful;
          console.log(`[importDictionaryWords] ✓ Updated batch ${Math.floor(i / UPDATE_BATCH_SIZE) + 1}: ${successful}/${chunk.length} words (total: ${updatedCount}/${updates.length})`);
      }
      console.log(`[importDictionaryWords] ✅ Completed: Updated tags for ${updatedCount}/${updates.length} existing words for ${tag}`);
  }
  
  return { updated: updatedCount, inserted: insertedCount };
};

/**
 * Dictionary configuration - uses local pre-cleaned wordlist files
 * These files are stored in /public/dictionaries/wordlists/ as "gold standard"
 * Format: one word per line, lowercase, sorted, deduplicated
 */
export const DICTIONARY_CONFIG = [
  { name: 'Primary School (小学)', localPath: '/dictionaries/wordlists/primary.txt', tag: 'Primary', wordCount: 439 },
  { name: 'Junior High (初中)', localPath: '/dictionaries/wordlists/junior.txt', tag: 'Junior', wordCount: 1887 },
  { name: 'Senior High (高中)', localPath: '/dictionaries/wordlists/senior.txt', tag: 'Senior', wordCount: 3429 },
  { name: 'CET-4 (四级)', localPath: '/dictionaries/wordlists/cet4.txt', tag: 'CET-4', wordCount: 4551 },
  { name: 'CET-6 (六级)', localPath: '/dictionaries/wordlists/cet6.txt', tag: 'CET-6', wordCount: 2219 },
];

/**
 * Parse pre-cleaned word list (one word per line, already lowercase)
 */
const parseCleanWordList = (text: string): string[] => {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
};

/**
 * Fetch word list from local file
 */
export const fetchLocalWordList = async (localPath: string): Promise<string[]> => {
  try {
    const response = await fetch(localPath);
    if (!response.ok) {
      throw new Error(`Failed to fetch local wordlist: ${response.status}`);
    }
    const text = await response.text();
    return parseCleanWordList(text);
  } catch (error) {
    console.error(`[fetchLocalWordList] Error fetching ${localPath}:`, error);
    return [];
  }
};

/**
 * Library verification result
 */
export interface LibraryVerificationResult {
  tag: string;
  name: string;
  isComplete: boolean;
  userWordCount: number;       // How many words user has with this tag
  sourceWordCount: number;     // How many words in source
  completionRate: number;      // Percentage (0-100)
  missingWords: string[];      // Sample of missing words (max 10)
  status: 'complete' | 'incomplete' | 'empty' | 'error';
}

/**
 * Verify library completeness by comparing with local gold standard
 * This performs a full comparison with the pre-cleaned word list
 */
export const verifyLibraryCompleteness = async (
  userId: string, 
  tag: string
): Promise<LibraryVerificationResult> => {
  const config = DICTIONARY_CONFIG.find(d => d.tag === tag);
  
  if (!config) {
    return {
      tag,
      name: tag,
      isComplete: false,
      userWordCount: 0,
      sourceWordCount: 0,
      completionRate: 0,
      missingWords: [],
      status: 'error'
    };
  }

  try {
    // 1. Fetch source word list from local gold standard file
    const sourceWords = await fetchLocalWordList(config.localPath);
    if (sourceWords.length === 0) {
      throw new Error(`Failed to load local wordlist: ${config.localPath}`);
    }
    const sourceWordSet = new Set(sourceWords);
    
    // 2. Fetch user's words with this tag (with pagination to handle > 1000 words)
    const userWords: any[] = [];
    let page = 0;
    const PAGE_SIZE = 1000;
    let hasMore = true;
    
    while (hasMore) {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      
      const { data: pageData, error } = await supabase
        .from('words')
        .select('text, tags')
        .eq('user_id', userId)
        .or('deleted.eq.false,deleted.is.null')
        .contains('tags', [tag])
        .range(from, to);

      if (error) {
        throw error;
      }
      
      if (!pageData || pageData.length === 0) {
        hasMore = false;
      } else {
        userWords.push(...pageData);
        hasMore = pageData.length === PAGE_SIZE;
        page++;
      }
    }
    const userWordSet = new Set(userWords.map((w: any) => w.text.toLowerCase().trim()));
    
    // 3. Calculate missing words
    const missingWords: string[] = [];
    for (const sourceWord of sourceWords) {
      if (!userWordSet.has(sourceWord)) {
        missingWords.push(sourceWord);
        if (missingWords.length >= 10) break; // Only sample first 10
      }
    }

    // 4. Calculate completion rate
    const matchedCount = sourceWords.filter(w => userWordSet.has(w)).length;
    const completionRate = sourceWords.length > 0 
      ? Math.round((matchedCount / sourceWords.length) * 100) 
      : 0;

    // Library is considered "complete" if 95%+ of source words exist
    const COMPLETENESS_THRESHOLD = 95;
    const isComplete = completionRate >= COMPLETENESS_THRESHOLD;

    console.log(`[verifyLibraryCompleteness] ${tag}: ${matchedCount}/${sourceWords.length} = ${completionRate}%`);

    return {
      tag,
      name: config.name,
      isComplete,
      userWordCount: userWords.length,
      sourceWordCount: sourceWords.length,
      completionRate,
      missingWords,
      status: userWords.length === 0 ? 'empty' : (isComplete ? 'complete' : 'incomplete')
    };

  } catch (error: any) {
    console.error(`[verifyLibraryCompleteness] Error for ${tag}:`, error);
    return {
      tag,
      name: config.name,
      isComplete: false,
      userWordCount: 0,
      sourceWordCount: 0,
      completionRate: 0,
      missingWords: [],
      status: 'error'
    };
  }
};

/**
 * Verify all libraries at once
 */
export const verifyAllLibraries = async (userId: string): Promise<Record<string, LibraryVerificationResult>> => {
  const results: Record<string, LibraryVerificationResult> = {};
  
  // Verify all dictionaries in parallel
  const verifications = await Promise.all(
    DICTIONARY_CONFIG.map(config => verifyLibraryCompleteness(userId, config.tag))
  );
  
  verifications.forEach(result => {
    results[result.tag] = result;
  });
  
  return results;
};

/**
 * Simple verification - just counts words (fast, no network)
 * Returns a map of library tags to their word counts
 */
export const verifyLibraryStatus = async (userId: string, libraryTags: string[]): Promise<Record<string, number>> => {
  const result: Record<string, number> = {};
  
  // Query all words for this user with the specified tags
  const { data: words, error } = await supabase
    .from('words')
    .select('tags')
    .eq('user_id', userId)
    .or('deleted.eq.false,deleted.is.null');
  
  if (error) {
    console.error("Error verifying library status:", error.message);
    return result;
  }
  
  // Initialize all tags to 0
  libraryTags.forEach(tag => result[tag] = 0);
  
  // Count words per tag
  words?.forEach((w: any) => {
    const tags = w.tags || ['Custom'];
    tags.forEach((tag: string) => {
      if (libraryTags.includes(tag)) {
        result[tag] = (result[tag] || 0) + 1;
      }
    });
  });
  
  return result;
};

/**
 * Custom error for version conflicts (Phase B)
 */
export class VersionConflictError extends Error {
    constructor(
        message: string,
        public readonly clientVersion: number
    ) {
        super(message);
        this.name = 'VersionConflictError';
    }
}
