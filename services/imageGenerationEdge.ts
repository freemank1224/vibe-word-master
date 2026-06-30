import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import { processAndUploadImage } from './imageProcessAndUpload';

export type ImageGenerationProviderId = 'letsmakesail' | 'newapi' | 'tokendance' | 'edge' | 'cache';

export type ImageGenerationEdgeRequest = {
  word: string;
  language?: string;
  promptOverride?: string;
  force?: boolean; // Force regeneration, skip cache
};

export type ImageGenerationEdgeResult = {
  dataUrl: string | null; // null for cache hits
  providerId: ImageGenerationProviderId;
  model?: string | null;
  // New fields for shared image storage
  publicUrl?: string | null;
  assetId?: string | null;
  source?: 'cache-hit' | 'generated';
  persistMode?: 'client' | 'server';
};

const IMAGE_GENERATION_TIMEOUT_MS = 120_000; // 2 minutes - allow primary + backup timeout

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`image-generate invoke timeout after ${timeoutMs}ms`)), timeoutMs)),
  ]);
};

export const requestImageGenerationViaEdge = async (
  request: ImageGenerationEdgeRequest,
): Promise<ImageGenerationEdgeResult> => {
  const word = (request.word || '').trim();
  if (!word) {
    throw new Error('Word is empty');
  }

  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured for image generation');
  }

  const invokePromise = supabase.functions.invoke('image-generate', {
    body: {
      word,
      language: request.language || 'en',
      prompt: request.promptOverride,
      force: request.force || false,
      clientPersist: true,
    },
  });

  const { data, error } = await withTimeout(invokePromise, IMAGE_GENERATION_TIMEOUT_MS);

  if (error) {
    throw new Error(error.message || 'image-generate invoke failed');
  }

  const providerId = typeof data?.providerId === 'string' && data.providerId.length > 0
    ? data.providerId as ImageGenerationProviderId
    : 'edge';

  // Cache hit: dataUrl is null but publicUrl is set
  if (data?.source === 'cache-hit' && data?.publicUrl) {
    return {
      dataUrl: null,
      providerId: providerId,
      model: data.model || 'cached',
      publicUrl: data.publicUrl,
      assetId: data.assetId || null,
      source: 'cache-hit',
    };
  }

  // Generated: dataUrl is present (backward compatible)
  if (typeof data?.dataUrl !== 'string' || data.dataUrl.length === 0) {
    throw new Error('image-generate returned empty dataUrl');
  }

  // Client-managed persistence: convert to WebP in-browser and upload.
  // This is the reliable path (edge-function WebP encoding is unreliable).
  if (data?.persistMode === 'client') {
    try {
      const uploaded = await processAndUploadImage({
        dataUrl: data.dataUrl,
        displayWord: word,
        language: request.language || 'en',
        model: typeof data?.model === 'string' ? data.model : null,
      });
      return {
        dataUrl: data.dataUrl,
        providerId,
        model: typeof data?.model === 'string' ? data.model : null,
        publicUrl: uploaded.publicUrl,
        assetId: uploaded.assetId,
        source: 'generated',
        persistMode: 'client',
      };
    } catch (e) {
      // Fallback: keep dataUrl for display, no publicUrl persisted yet.
      console.warn('[imageGenerationEdge] client persist failed:', e);
      return {
        dataUrl: data.dataUrl,
        providerId,
        model: typeof data?.model === 'string' ? data.model : null,
        publicUrl: null,
        assetId: null,
        source: 'generated',
        persistMode: 'client',
      };
    }
  }

  // Legacy server-managed persistence.
  return {
    dataUrl: data.dataUrl,
    providerId,
    model: typeof data?.model === 'string' ? data.model : null,
    publicUrl: data.publicUrl || null,
    assetId: data.assetId || null,
    source: 'generated',
    persistMode: 'server',
  };
};

export const getImageGenerationEdgeDebugInfo = () => ({
  mode: 'supabase-edge-function',
  functionName: 'image-generate',
  supabaseConfigured: isSupabaseConfigured,
  timestamp: new Date().toISOString(),
});
