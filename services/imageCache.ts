import { WordEntry } from '../types';

const CACHE_NAME = 'vibe-word-image-cache-v1';
const META_KEY = 'vibe_word_image_cache_meta_v1';

type CacheMeta = Record<string, {
  cacheKey: string;
  updatedAt: number;
}>;

const canUseBrowserCache = (): boolean => {
  return typeof window !== 'undefined' && typeof caches !== 'undefined' && typeof localStorage !== 'undefined';
};

const normalizeCacheKey = (text: string, language: string = 'en'): string => {
  return `${language.toLowerCase()}::${text.trim().toLowerCase().replace(/\s+/g, ' ')}`;
};

const getRequestUrl = (cacheKey: string): string => {
  return `/__vibe_word_image_cache__/${encodeURIComponent(cacheKey)}`;
};

const readMeta = (): CacheMeta => {
  if (!canUseBrowserCache()) return {};
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as CacheMeta;
  } catch {
    return {};
  }
};

const writeMeta = (meta: CacheMeta): void => {
  if (!canUseBrowserCache()) return;
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
  }
};

const blobToDataUrl = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to convert blob to data URL'));
    reader.readAsDataURL(blob);
  });
};

export const getCachedImageWordIds = (): Set<string> => {
  const meta = readMeta();
  return new Set(Object.keys(meta));
};

export const hasCachedImageForWord = (wordId: string): boolean => {
  if (!wordId) return false;
  const meta = readMeta();
  return !!meta[wordId];
};

export const cacheGeneratedImageForWord = async (
  word: Pick<WordEntry, 'id' | 'text' | 'language'>,
  imageDataUrl: string
): Promise<boolean> => {
  if (!canUseBrowserCache()) return false;
  if (!word.id || !word.text || !imageDataUrl) return false;

  try {
    const cacheKey = normalizeCacheKey(word.text, word.language || 'en');
    const request = new Request(getRequestUrl(cacheKey));
    const blob = await (await fetch(imageDataUrl)).blob();
    const response = new Response(blob, {
      headers: {
        'Content-Type': blob.type || 'image/png',
        'X-Word-Id': word.id,
        'X-Updated-At': String(Date.now()),
      },
    });

    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response);

    const meta = readMeta();
    meta[word.id] = {
      cacheKey,
      updatedAt: Date.now(),
    };
    writeMeta(meta);

    return true;
  } catch (error) {
    console.warn('[image-cache] Failed to cache generated image:', error);
    return false;
  }
};

export const getCachedImageDataUrl = async (wordId: string): Promise<string | null> => {
  if (!canUseBrowserCache() || !wordId) return null;

  try {
    const meta = readMeta();
    const item = meta[wordId];
    if (!item?.cacheKey) return null;

    const cache = await caches.open(CACHE_NAME);
    const matched = await cache.match(new Request(getRequestUrl(item.cacheKey)));
    if (!matched) return null;

    const blob = await matched.blob();
    return await blobToDataUrl(blob);
  } catch (error) {
    console.warn('[image-cache] Failed to read cached image:', error);
    return null;
  }
};
