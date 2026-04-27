import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';

export type ImageGenerationProviderId = 'newapi' | 'tokendance' | 'edge';

export type ImageGenerationEdgeRequest = {
  word: string;
  language?: string;
  promptOverride?: string;
};

export type ImageGenerationEdgeResult = {
  dataUrl: string;
  providerId: ImageGenerationProviderId;
  model?: string | null;
};

const IMAGE_GENERATION_TIMEOUT_MS = 45_000;

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
    },
  });

  const { data, error } = await withTimeout(invokePromise, IMAGE_GENERATION_TIMEOUT_MS);

  if (error) {
    throw new Error(error.message || 'image-generate invoke failed');
  }

  if (typeof data?.dataUrl !== 'string' || data.dataUrl.length === 0) {
    throw new Error('image-generate returned empty dataUrl');
  }

  const providerId = typeof data?.providerId === 'string' && data.providerId.length > 0
    ? data.providerId as ImageGenerationProviderId
    : 'edge';

  return {
    dataUrl: data.dataUrl,
    providerId,
    model: typeof data?.model === 'string' ? data.model : null,
  };
};

export const getImageGenerationEdgeDebugInfo = () => ({
  mode: 'supabase-edge-function',
  functionName: 'image-generate',
  supabaseConfigured: isSupabaseConfigured,
  timestamp: new Date().toISOString(),
});
