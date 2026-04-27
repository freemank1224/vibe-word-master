// @ts-nocheck
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type ProviderId = 'newapi' | 'tokendance';

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

const normalizeUrl = (url: string): string => url.trim().replace(/\/$/, '');

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

  const backupBaseUrl = Deno.env.get('BACKUP_IMAGE_GEN_BASE_URL')
    || 'https://tokendance.space/gateway/v1/images/generations';
  const backupApiKey = Deno.env.get('BACKUP_IMAGE_GEN_API_KEY') || '';
  const backupModel = Deno.env.get('BACKUP_IMAGE_GEN_MODEL') || 'ernie-image';

  const providers: ProviderConfig[] = [];

  if (primaryBaseUrl && primaryApiKey) {
    providers.push({
      id: 'newapi',
      baseUrl: primaryBaseUrl,
      apiKey: primaryApiKey,
      model: primaryModel,
    });
  }

  if (backupBaseUrl && backupApiKey) {
    providers.push({
      id: 'tokendance',
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

const tryGenerateByProvider = async (
  provider: ProviderConfig,
  prompt: string,
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
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model,
          prompt,
          n: 1,
          size: '1024x1024',
          response_format: 'b64_json',
        }),
      });

      const data = await parseResponseJson(response);
      if (!response.ok) {
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
      lastFailure = {
        providerId: provider.id,
        url,
        message: error instanceof Error ? error.message : String(error),
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

  try {
    const body = await req.json().catch(() => ({}));
    const word = typeof body?.word === 'string' ? body.word.trim() : '';
    const promptOverride = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    const language = typeof body?.language === 'string' ? body.language.trim() : 'en';

    if (!word) {
      return new Response(JSON.stringify({ error: 'Missing word' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const providers = getProviderConfigs();
    if (providers.length === 0) {
      return new Response(JSON.stringify({ error: 'No image generation providers configured in Edge Function env' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const prompt = promptOverride || buildPrompt(word);
    const failures: ProviderAttemptFailure[] = [];

    for (const provider of providers) {
      const result = await tryGenerateByProvider(provider, prompt);
      if ('error' in result) {
        failures.push(result.error);
        continue;
      }

      return new Response(JSON.stringify({
        ok: true,
        word,
        language,
        providerId: result.providerId,
        model: result.model,
        attemptedUrl: result.attemptedUrl,
        dataUrl: result.dataUrl,
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
