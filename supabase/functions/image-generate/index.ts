// @ts-nocheck
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

type ProviderId = 'letsmakesail' | 'newapi' | 'tokendance';

type ProviderConfig = {
  id: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
};

type ProviderAttemptFailure = {
  providerId: ProviderId;
  url: string;
  message: string;
  status?: number;
};

const NEW_BUCKET = 'word-images';

const normalizeWord = (text: string): string =>
  text.toLowerCase().trim().replace(/\s+/g, ' ');

const getSupabaseClient = () =>
  createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const normalizeUrl = (url: string): string => url.trim().replace(/\/$/, '');

const resolveProviderId = (baseUrl: string, fallback: ProviderId): ProviderId => {
  const normalized = baseUrl.trim().toLowerCase();
  if (normalized.includes('letsmakesail')) return 'letsmakesail';
  if (normalized.includes('omgteam') || normalized.includes('newapi')) return 'newapi';
  if (normalized.includes('tokendance')) return 'tokendance';
  return fallback;
};

const getImageGenerationUrls = (baseUrl: string): string[] => {
  const sanitized = normalizeUrl(baseUrl);
  if (!sanitized) return [];
  if (sanitized.endsWith('/images/generations')) return [sanitized];
  return [`${sanitized}/v1/images/generations`, `${sanitized}/images/generations`];
};

const buildPrompt = (word: string): string => {
  const normalized = word.trim();
  return [
    `Target word or phrase: "${normalized}".`,
    'Create a cartoon-style illustration that is highly intuitive and semantically accurate for this exact target.',
    'Critical requirement: key semantic details must be realistic enough to clearly express the meaning.',
    'If the target is a noun, make that noun the central subject.',
    'If the target is a verb or phrase, design a clear action scene that conveys the meaning.',
    'Do not add artificial overlay subtitles, UI labels, watermark-like text, or unrelated floating captions.',
    'Natural text that belongs to objects in the scene is allowed and should be preserved when semantically necessary, such as blackboard writing, book covers/pages, street signs, or packaging text.',
    'Single scene, clean composition, vivid colors, high clarity, educational illustration quality.',
  ].join(' ');
};

const getProviderConfigs = (): ProviderConfig[] => {
  const primaryBaseUrl = Deno.env.get('PRIMARY_IMAGE_GEN_BASE_URL')
    || Deno.env.get('IMAGE_GEN_ENDPOINT')
    || '';
  const primaryApiKey = Deno.env.get('PRIMARY_IMAGE_GEN_API_KEY')
    || Deno.env.get('IMAGE_GEN_API_KEY')
    || '';
  const primaryModel = Deno.env.get('PRIMARY_IMAGE_GEN_MODEL')
    || Deno.env.get('IMAGE_GEN_MODEL')
    || 'gpt-image-2';

  const secondaryBaseUrl = Deno.env.get('SECONDARY_IMAGE_GEN_BASE_URL') || '';
  const secondaryApiKey = Deno.env.get('SECONDARY_IMAGE_GEN_API_KEY') || '';
  const secondaryModel = Deno.env.get('SECONDARY_IMAGE_GEN_MODEL') || 'gpt-image-2';

  const backupBaseUrl = Deno.env.get('BACKUP_IMAGE_GEN_BASE_URL')
    || 'https://tokendance.space/gateway/v1/images/generations';
  const backupApiKey = Deno.env.get('BACKUP_IMAGE_GEN_API_KEY') || '';
  const backupModel = Deno.env.get('BACKUP_IMAGE_GEN_MODEL') || 'ernie-image';

  const providers: ProviderConfig[] = [];

  if (primaryBaseUrl && primaryApiKey) {
    providers.push({
      id: resolveProviderId(primaryBaseUrl, 'letsmakesail'),
      baseUrl: primaryBaseUrl,
      apiKey: primaryApiKey,
      model: primaryModel,
    });
  }

  if (secondaryBaseUrl && secondaryApiKey) {
    providers.push({
      id: resolveProviderId(secondaryBaseUrl, 'newapi'),
      baseUrl: secondaryBaseUrl,
      apiKey: secondaryApiKey,
      model: secondaryModel,
    });
  }

  if (backupBaseUrl && backupApiKey) {
    providers.push({
      id: resolveProviderId(backupBaseUrl, 'tokendance'),
      baseUrl: backupBaseUrl,
      apiKey: backupApiKey,
      model: backupModel,
    });
  }

  return providers;
};

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const convertImageUrlToDataUrl = async (imageUrl: string): Promise<string | null> => {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') || 'image/png';
    const arrayBuffer = await response.arrayBuffer();
    const base64 = encodeBase64(new Uint8Array(arrayBuffer));
    return `data:${contentType};base64,${base64}`;
  } catch {
    return null;
  }
};

const parseResponseJson = async (response: Response) => {
  return await response.json().catch(async () => ({
    error: { message: await response.text().catch(() => response.statusText) },
  }));
};

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, timeoutError: string): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(timeoutError)), timeoutMs)
    ),
  ]);
};

const tryGenerateByProvider = async (
  provider: ProviderConfig,
  prompt: string,
  isPrimary: boolean,
): Promise<{ dataUrl: string; providerId: ProviderId; model: string; attemptedUrl: string } | { error: ProviderAttemptFailure }> => {
  const urls = getImageGenerationUrls(provider.baseUrl);
  if (urls.length === 0) {
    return {
      error: {
        providerId: provider.id,
        url: provider.baseUrl,
        message: 'Invalid provider base URL',
      },
    };
  }

  let lastFailure: ProviderAttemptFailure | null = null;

  for (const url of urls) {
    try {
      const timeoutMs = isPrimary ? 90000 : 60000;
      const requestBody = JSON.stringify({
        model: provider.model,
        prompt,
        n: 1,
        size: '1024x1024',
        response_format: 'b64_json',
      });

      console.log(`[image-generate] Attempting ${provider.id} at ${url}, timeout: ${timeoutMs}ms, body length: ${requestBody.length}`);

      const response = await withTimeout(
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${provider.apiKey}`,
            'User-Agent': 'Supabase-Edge-Function',
          },
          body: requestBody,
        }),
        timeoutMs,
        `Provider ${provider.id} timeout after ${timeoutMs}ms`
      );

      console.log(`[image-generate] ${provider.id} response status: ${response.status}`);

      const data = await parseResponseJson(response);
      if (!response.ok) {
        console.log(`[image-generate] ${provider.id} failed: ${response.status}, error: ${JSON.stringify(data)?.substring(0, 200)}`);
        lastFailure = {
          providerId: provider.id,
          url,
          status: response.status,
          message: data?.error?.message || `${response.status} ${response.statusText}`,
        };
        continue;
      }

      const b64 = data?.data?.[0]?.b64_json;
      if (typeof b64 === 'string' && b64.length > 0) {
        return {
          dataUrl: `data:image/png;base64,${b64}`,
          providerId: provider.id,
          model: provider.model,
          attemptedUrl: url,
        };
      }

      const imageUrl = data?.data?.[0]?.url;
      if (typeof imageUrl === 'string' && imageUrl.length > 0) {
        const dataUrl = await convertImageUrlToDataUrl(imageUrl);
        if (dataUrl) {
          return {
            dataUrl,
            providerId: provider.id,
            model: provider.model,
            attemptedUrl: url,
          };
        }
      }

      lastFailure = {
        providerId: provider.id,
        url,
        message: 'response has no b64_json/url',
      };
    } catch (error) {
      const isTimeout = error instanceof Error && error.message.includes('timeout');
      lastFailure = {
        providerId: provider.id,
        url,
        message: isTimeout
          ? `Request timeout after ${isPrimary ? '90s' : '60s'}`
          : (error instanceof Error ? error.message : String(error)),
      };
    }
  }

  return {
    error: lastFailure || {
      providerId: provider.id,
      url: provider.baseUrl,
      message: 'generation failed',
    },
  };
};

// -------------------------------------------------------
// Convert image blob to WebP using OffscreenCanvas (Deno supports it)
// Falls back to original blob if conversion is unavailable
// -------------------------------------------------------
const convertToWebP = async (
  blob: Blob,
  maxWidth: number = 1024,
  maxHeight: number = 1024,
  quality: number = 0.8,
): Promise<Blob> => {
  try {
    // Create ImageBitmap from blob
    const bitmap = await createImageBitmap(blob);

    // Calculate new dimensions maintaining aspect ratio
    let width = bitmap.width;
    let height = bitmap.height;
    if (width > maxWidth || height > maxHeight) {
      const ratio = Math.min(maxWidth / width, maxHeight / height);
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
    }

    // Draw to OffscreenCanvas and export as WebP
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      console.warn('[image-generate] OffscreenCanvas 2d context unavailable, storing original');
      return blob;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    // Convert to WebP blob
    const webpBlob = await canvas.convertToBlob({ type: 'image/webp', quality });
    console.log(`[image-generate] Converted to WebP: ${blob.size} -> ${webpBlob.size} bytes (${width}x${height})`);
    return webpBlob;
  } catch (err) {
    console.warn(`[image-generate] WebP conversion failed, storing original: ${err}`);
    return blob;
  }
};

// -------------------------------------------------------
// New: Persist image to shared storage + link words
// -------------------------------------------------------
const persistAndLink = async (
  normalizedWord: string,
  displayWord: string,
  language: string,
  dataUrl: string,
  providerId: ProviderId,
  model: string,
): Promise<{ assetId: string; publicUrl: string } | null> => {
  const sb = getSupabaseClient();

  try {
    // Convert data URL to blob
    const base64Match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!base64Match) {
      console.error('[image-generate] Invalid dataUrl format');
      return null;
    }
    const contentType = base64Match[1] || 'image/png';
    const base64Data = base64Match[2];

    // Decode base64
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const rawBlob = new Blob([bytes], { type: contentType });

    // Convert to WebP for optimal storage (always store as .webp)
    const blob = await convertToWebP(rawBlob, 1024, 1024, 0.8);
    const isWebP = blob.type === 'image/webp';

    // Always use .webp extension after conversion
    const storagePath = `images/${language}/${encodeURIComponent(normalizedWord)}.webp`;

    // Upload to shared storage
    const { error: ulErr } = await sb.storage
      .from(NEW_BUCKET)
      .upload(storagePath, blob, {
        contentType: blob.type || 'image/webp',
        cacheControl: '31536000',
        upsert: true,
      });

    if (ulErr) {
      console.error(`[image-generate] Storage upload failed: ${ulErr.message}`);
      return null;
    }

    // Get public URL
    const { data: urlData } = sb.storage.from(NEW_BUCKET).getPublicUrl(storagePath);
    const publicUrl = urlData.publicUrl;

    // Upsert image_assets row
    const { data: asset, error: iaErr } = await sb
      .from('image_assets')
      .upsert(
        {
          normalized_word: normalizedWord,
          display_word: displayWord,
          language,
          model,
          storage_bucket: NEW_BUCKET,
          storage_path: storagePath,
          public_url: publicUrl,
          file_size_bytes: blob.size,
          status: 'ready',
          error_message: null,
        },
        { onConflict: 'normalized_word,language' }
      )
      .select('id')
      .single();

    if (iaErr) {
      console.error(`[image-generate] image_assets upsert failed: ${iaErr.message}`);
      return null;
    }

    // Link all matching words
    // Use RPC or direct query - match by normalize_word_key(text) = normalizedWord
    // Since we can't use custom SQL functions easily from the client, use a broader match
    const { data: matchingWords } = await sb
      .from('words')
      .select('id')
      .or('deleted.is.false,deleted.is.null')
      .ilike('text', displayWord)
      .eq('language', language);

    if (matchingWords && matchingWords.length > 0) {
      await sb
        .from('words')
        .update({ image_asset_id: asset.id })
        .in('id', matchingWords.map((w: any) => w.id));
    }

    return { assetId: asset.id, publicUrl };
  } catch (err) {
    console.error(`[image-generate] persistAndLink error: ${err}`);
    return null;
  }
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Network test endpoint (kept for backward compatibility)
  if (req.method === 'GET' && new URL(req.url).searchParams.get('test') === 'network') {
    const testResults = [];

    try {
      const start = Date.now();
      const resp = await fetch('https://httpbin.org/get', { signal: AbortSignal.timeout(5000) });
      const elapsed = Date.now() - start;
      testResults.push({ name: 'httpbin', status: resp.status, elapsed: `${elapsed}ms`, success: true });
    } catch (e) {
      testResults.push({ name: 'httpbin', error: String(e), success: false });
    }

    try {
      const start = Date.now();
      const resp = await fetch('https://newapi.letsmakesail.xyz/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', prompt: 'test' }),
        signal: AbortSignal.timeout(5000),
      });
      const elapsed = Date.now() - start;
      testResults.push({ name: 'letsmakesail', status: resp.status, elapsed: `${elapsed}ms`, success: resp.status < 500 });
    } catch (e) {
      testResults.push({ name: 'letsmakesail', error: String(e), success: false });
    }

    try {
      const start = Date.now();
      const resp = await fetch('https://newapi.omgteam.me/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', prompt: 'test' }),
        signal: AbortSignal.timeout(5000),
      });
      const elapsed = Date.now() - start;
      testResults.push({ name: 'newapi', status: resp.status, elapsed: `${elapsed}ms`, success: resp.status < 500 });
    } catch (e) {
      testResults.push({ name: 'newapi', error: String(e), success: false });
    }

    try {
      const start = Date.now();
      const resp = await fetch('https://tokendance.space/gateway/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', prompt: 'test' }),
        signal: AbortSignal.timeout(5000),
      });
      const elapsed = Date.now() - start;
      testResults.push({ name: 'tokendance', status: resp.status, elapsed: `${elapsed}ms`, success: resp.status < 500 });
    } catch (e) {
      testResults.push({ name: 'tokendance', error: String(e), success: false });
    }

    return new Response(JSON.stringify({ testResults, timestamp: new Date().toISOString() }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const word = typeof body?.word === 'string' ? body.word.trim() : '';
    const promptOverride = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    const language = typeof body?.language === 'string' ? body.language.trim() : 'en';
    const force = body?.force === true || body?.force === '1';

    if (!word) {
      return new Response(JSON.stringify({ error: 'Missing word' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const normalizedWord = normalizeWord(word);

    // ---- NEW: Check cache in image_assets ----
    if (!force) {
      const sb = getSupabaseClient();
      const { data: cached } = await sb
        .from('image_assets')
        .select('id, public_url')
        .eq('normalized_word', normalizedWord)
        .eq('language', language)
        .eq('status', 'ready')
        .maybeSingle();

      if (cached && cached.public_url) {
        console.log(`[image-generate] Cache hit for "${normalizedWord}" (${language})`);
        return new Response(JSON.stringify({
          ok: true,
          word,
          language,
          providerId: 'cache',
          model: 'cached',
          source: 'cache-hit',
          publicUrl: cached.public_url,
          assetId: cached.id,
          dataUrl: null, // No dataUrl needed for cache hits - client uses publicUrl directly
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // ---- Cache miss: Generate image ----
    const providers = getProviderConfigs();
    if (providers.length === 0) {
      return new Response(JSON.stringify({ error: 'No image generation providers configured in Edge Function env' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const prompt = promptOverride || buildPrompt(word);
    const failures: ProviderAttemptFailure[] = [];

    // clientPersist=true (default): edge only returns the raw PNG dataUrl and the
    // client (browser) converts to WebP via Canvas and uploads. This is reliable.
    // clientPersist=false: legacy path, edge converts+uploads (unreliable WebP).
    const clientPersist = body?.clientPersist !== false;

    const providerCount = providers.length;
    for (let i = 0; i < providerCount; i++) {
      const provider = providers[i];
      const isPrimary = providerCount > 1 && i === 0;
      const result = await tryGenerateByProvider(provider, prompt, isPrimary);
      if ('error' in result) {
        failures.push(result.error);
        continue;
      }

      // Client-managed persistence: return raw PNG dataUrl, client converts to
      // WebP (reliable Canvas API) and uploads to storage + writes image_assets.
      if (clientPersist) {
        return new Response(JSON.stringify({
          ok: true,
          word,
          language,
          providerId: result.providerId,
          model: result.model,
          attemptedUrl: result.attemptedUrl,
          dataUrl: result.dataUrl,
          publicUrl: null,
          assetId: null,
          source: 'generated',
          persistMode: 'client',
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Legacy server-side persistence (kept as fallback).
      const persisted = await persistAndLink(
        normalizedWord,
        word,
        language,
        result.dataUrl,
        result.providerId,
        result.model,
      );

      return new Response(JSON.stringify({
        ok: true,
        word,
        language,
        providerId: result.providerId,
        model: result.model,
        attemptedUrl: result.attemptedUrl,
        dataUrl: result.dataUrl,
        publicUrl: persisted?.publicUrl || null,
        assetId: persisted?.assetId || null,
        source: 'generated',
        persistMode: 'server',
        persistError: persisted ? null : 'Failed to persist to shared storage',
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      error: 'All image providers failed',
      failures,
    }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
