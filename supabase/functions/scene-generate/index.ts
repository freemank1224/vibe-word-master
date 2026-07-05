// @ts-nocheck
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  buildSceneDirectorSystemPrompt,
  buildSceneDirectorUserPayload,
  buildFusionResult,
  deriveRegionsFromElements,
  parseSceneDesign,
  parseSceneDesignWithDiagnostics,
  replaceMascotPlaceholder,
  MASCOT_PLACEHOLDER,
  zoneToBbox,
  DEFAULT_ZONE,
} from './sceneDesign.ts';

// ================================================================
// scene-generate edge function — refreshed pipeline (design doc v2 §3)
//
// ① Scene director (strong text LLM) → core; conceives ONE coherent scene
//    holding all N words + the day monster, assigns each a positionZone,
//    returns a structuredPrompt. Config: SCENE_DESIGN_* secrets only.
// ② Render (image model)              → uses ①' structuredPrompt. Config:
//    PRIMARY_IMAGE_GEN_* secrets (reuses the image-generate provider chain).
// ③ Region refinement (multimodal LLM) → OPTIONAL, default OFF. Config:
//    SCENE_VISION_* secrets (falls back to ①'s design endpoint/key).
//
// ① and ③ are server-side only (Supabase Edge Secrets). The front end never
// sees or sends these keys. Vision ③ runs only when enabled and tightens
// boxes per word; failures fall back to the zone-derived regions.
//
// A `probe` action lets the Admin Console verify the SCENE_DESIGN_* secret
// is wired correctly without generating any image or touching scene_assets.
//
// Cache is per-user (scene_assets.user_id) keyed by
// (user_id, word_set_hash, day_index, language).
// ================================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const NEW_BUCKET = 'word-images';

const getSupabaseClient = () =>
  createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

// ----------------------------------------------------------------
// Day-of-week monster prose (kept in sync with utils/mascotDescriptions.ts)
// ----------------------------------------------------------------
const MASCOT_DESCRIPTIONS: Record<number, string> = {
  0: 'A cute, round, red-orange warm monster tailored for Sunday, embodying relaxation and sun warmth. It has soft fur and a friendly smile.',
  1: 'A small, energetic, electric-blue monster for Monday, symbolizing a fresh start and energy. It has lightning-bolt shaped antennae.',
  2: 'A focused, green-leaf patterned monster for Tuesday, representing growth and steady progress. It wears glasses and looks smart.',
  3: 'A cheerful, yellow bubble-like monster for Wednesday, representing the peak of the week. It is floating and glowing softly.',
  4: 'A calm, reliable, purple monster for Thursday, symbolizing wisdom and anticipation. It has a magical aura.',
  5: 'A fun-loving, pink, party-ready monster for Friday, representing excitement for the weekend. It has confetti-like spots.',
  6: 'A partially lazy, sloth-like turquoise monster for Saturday, representing leisure and play. It is holding a pillow or toy.',
};

/**
 * SHORT fallback description used to substitute [TODAYS_MASCOT] inside the
 * structuredPrompt when the image-generation provider does NOT support
 * reference images. We intentionally keep this brief and noun-phrase-style so
 * it slots into the LLM's natural-language sentence without breaking grammar.
 */
const MASCOT_SHORT_DESCRIPTION: Record<number, string> = {
  0: 'a round red-orange warm monster with soft fur and a friendly smile',
  1: 'a small electric-blue monster with lightning-bolt antennae',
  2: 'a focused green-leaf-patterned monster wearing glasses',
  3: 'a cheerful floating yellow bubble-like monster glowing softly',
  4: 'a calm purple monster with a magical aura',
  5: 'a fun-loving pink party-ready monster with confetti-like spots',
  6: 'a sloth-like turquoise monster holding a pillow',
};

const MASCOT_STORAGE_PATH = (dayIndex: number) => `mascots/M${dayIndex}.webp`;

/**
 * Fetch the canonical mascot image for the given day as a data URL.
 *
 * Source: Supabase Storage `word-images/mascots/M{0-6}.webp` (uploaded once
 * via scripts/upload-mascots.mjs). Reads from the public URL when the bucket
 * is public; falls back to a signed-url fetch with the service role key
 * otherwise. Result is cached in-memory per process for the lifetime of the
 * edge function instance.
 *
 * Returns null on any failure — callers MUST handle gracefully by falling
 * back to text-only image generation with MASCOT_SHORT_DESCRIPTION.
 */
const mascotCache = new Map<number, { dataUrl: string | null; fetchedAt: number }>();
const MASCOT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const fetchMascotDataUrl = async (dayIndex: number): Promise<{ dataUrl: string | null; source: string }> => {
  const cached = mascotCache.get(dayIndex);
  if (cached && Date.now() - cached.fetchedAt < MASCOT_CACHE_TTL_MS && cached.dataUrl) {
    return { dataUrl: cached.dataUrl, source: 'cache' };
  }
  const objectPath = MASCOT_STORAGE_PATH(dayIndex);
  // Prefer public URL (works when bucket is public).
  const publicUrl = `${supabaseUrl}/storage/v1/object/public/${NEW_BUCKET}/${objectPath}`;
  try {
    const res = await fetch(publicUrl, { method: 'GET' });
    if (res.ok) {
      const contentType = res.headers.get('content-type') || 'image/webp';
      const buf = new Uint8Array(await res.arrayBuffer());
      const b64 = encodeBase64(buf);
      const dataUrl = `data:${contentType};base64,${b64}`;
      mascotCache.set(dayIndex, { dataUrl, fetchedAt: Date.now() });
      console.log(`[scene-generate] mascot loaded from public URL (day=${dayIndex}, ${buf.length} bytes)`);
      return { dataUrl, source: 'public-url' };
    }
    console.warn(`[scene-generate] mascot public fetch returned ${res.status}`);
  } catch (err) {
    console.warn(`[scene-generate] mascot public fetch threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Fallback: signed URL via service role client.
  try {
    const sb = getSupabaseClient();
    const { data, error } = await sb.storage.from(NEW_BUCKET).createSignedUrl(objectPath, 60);
    if (error || !data?.signedUrl) {
      console.warn(`[scene-generate] mascot signed URL failed: ${error?.message || 'no signedUrl'}`);
    } else {
      const res = await fetch(data.signedUrl, { method: 'GET' });
      if (res.ok) {
        const contentType = res.headers.get('content-type') || 'image/webp';
        const buf = new Uint8Array(await res.arrayBuffer());
        const b64 = encodeBase64(buf);
        const dataUrl = `data:${contentType};base64,${b64}`;
        mascotCache.set(dayIndex, { dataUrl, fetchedAt: Date.now() });
        console.log(`[scene-generate] mascot loaded via signed URL (day=${dayIndex}, ${buf.length} bytes)`);
        return { dataUrl, source: 'signed-url' };
      }
    }
  } catch (err) {
    console.warn(`[scene-generate] mascot signed fetch threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  mascotCache.set(dayIndex, { dataUrl: null, fetchedAt: Date.now() });
  return { dataUrl: null, source: 'missing' };
};

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
const normalizeWord = (text: string): string =>
  text.toLowerCase().trim().replace(/\s+/g, ' ');

const normalizeUrl = (url: string): string => url.trim().replace(/\/$/, '');

const sha1Hex = async (data: string): Promise<string> => {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, timeoutError: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(timeoutError)), timeoutMs)),
  ]);

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

// ----------------------------------------------------------------
// Image-generation provider fallback chain (mirrors image-generate)
// ----------------------------------------------------------------
type ProviderId = 'letsmakesail' | 'newapi' | 'tokendance' | string;
interface ProviderConfig { id: ProviderId; baseUrl: string; apiKey: string; model: string; }
interface ProviderAttemptFailure { providerId: ProviderId; url: string; message: string; status?: number; }

const resolveProviderId = (baseUrl: string, fallback: ProviderId): ProviderId => {
  const n = baseUrl.trim().toLowerCase();
  if (n.includes('letsmakesail')) return 'letsmakesail';
  if (n.includes('omgteam') || n.includes('newapi')) return 'newapi';
  if (n.includes('tokendance')) return 'tokendance';
  return fallback;
};

const getImageGenerationUrls = (baseUrl: string): string[] => {
  const s = normalizeUrl(baseUrl);
  if (!s) return [];
  if (s.endsWith('/images/generations')) return [s];
  return [`${s}/v1/images/generations`, `${s}/images/generations`];
};

/**
 * Build the corresponding `/v1/images/edits` endpoint URL(s) for a given
 * provider base URL. Used when we have a reference image (the day's mascot)
 * and want true image-to-image generation rather than text-only.
 */
const getImageEditsUrls = (baseUrl: string): string[] => {
  const s = normalizeUrl(baseUrl);
  if (!s) return [];
  if (s.endsWith('/images/generations')) {
    return [s.replace(/\/images\/generations$/, '/images/edits')];
  }
  if (s.endsWith('/images/edits')) return [s];
  return [`${s}/v1/images/edits`, `${s}/images/edits`];
};

/**
 * Convert a `data:<mime>;base64,...` URL into a Blob suitable for multipart
 * form upload. Returns null on malformed input.
 */
const dataUrlToBlob = (dataUrl: string): Blob | null => {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  const contentType = m[1] || 'application/octet-stream';
  const binaryString = atob(m[2]);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return new Blob([bytes], { type: contentType });
};

/**
 * Decide whether to attempt img2img (`/v1/images/edits`) for this run.
 *
 * Opt-out via `SCENE_IMG2IMG_DISABLED=true` for providers / gateways that
 * reject multipart. Default: enabled.
 */
const isImg2ImgEnabled = (): boolean =>
  (Deno.env.get('SCENE_IMG2IMG_DISABLED') || '').toLowerCase() !== 'true';

const getProviderConfigs = (): ProviderConfig[] => {
  const primaryBaseUrl = Deno.env.get('PRIMARY_IMAGE_GEN_BASE_URL') || Deno.env.get('IMAGE_GEN_ENDPOINT') || '';
  const primaryApiKey = Deno.env.get('PRIMARY_IMAGE_GEN_API_KEY') || Deno.env.get('IMAGE_GEN_API_KEY') || '';
  const primaryModel = Deno.env.get('PRIMARY_IMAGE_GEN_MODEL') || Deno.env.get('IMAGE_GEN_MODEL') || 'gpt-image-2';
  const secondaryBaseUrl = Deno.env.get('SECONDARY_IMAGE_GEN_BASE_URL') || '';
  const secondaryApiKey = Deno.env.get('SECONDARY_IMAGE_GEN_API_KEY') || '';
  const secondaryModel = Deno.env.get('SECONDARY_IMAGE_GEN_MODEL') || 'gpt-image-2';
  const backupBaseUrl = Deno.env.get('BACKUP_IMAGE_GEN_BASE_URL') || 'https://tokendance.space/gateway/v1/images/generations';
  const backupApiKey = Deno.env.get('BACKUP_IMAGE_GEN_API_KEY') || '';
  const backupModel = Deno.env.get('BACKUP_IMAGE_GEN_MODEL') || 'ernie-image';

  const providers: ProviderConfig[] = [];
  if (primaryBaseUrl && primaryApiKey) providers.push({ id: resolveProviderId(primaryBaseUrl, 'letsmakesail'), baseUrl: primaryBaseUrl, apiKey: primaryApiKey, model: primaryModel });
  if (secondaryBaseUrl && secondaryApiKey) providers.push({ id: resolveProviderId(secondaryBaseUrl, 'newapi'), baseUrl: secondaryBaseUrl, apiKey: secondaryApiKey, model: secondaryModel });
  if (backupBaseUrl && backupApiKey) providers.push({ id: resolveProviderId(backupBaseUrl, 'tokendance'), baseUrl: backupBaseUrl, apiKey: backupApiKey, model: backupModel });
  return providers;
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

const parseResponseJson = async (response: Response) =>
  response.json().catch(async () => ({ error: { message: await response.text().catch(() => response.statusText) } }));

const tryGenerateByProvider = async (
  provider: ProviderConfig,
  prompt: string,
  isPrimary: boolean,
  options?: {
    /** Optional reference image (data URL) for img2img via /v1/images/edits. */
    referenceImage?: { dataUrl: string; label?: string } | null;
  },
): Promise<{ dataUrl: string; providerId: ProviderId; model: string; attemptedUrl: string; img2Img: boolean } | { error: ProviderAttemptFailure }> => {
  const urls = getImageGenerationUrls(provider.baseUrl);
  if (urls.length === 0) return { error: { providerId: provider.id, url: provider.baseUrl, message: 'Invalid provider base URL' } };

  // When a reference image is supplied AND img2img isn't disabled, FIRST try
  // /v1/images/edits (multipart). On any failure (4xx / network / endpoint
  // not present), fall back to the text-only generations call below — this
  // keeps the pipeline robust against gateways that don't proxy edits.
  if (options?.referenceImage && isImg2ImgEnabled()) {
    const blob = dataUrlToBlob(options.referenceImage.dataUrl);
    const editUrls = getImageEditsUrls(provider.baseUrl);
    if (blob && editUrls.length > 0) {
      for (const url of editUrls) {
        try {
          const timeoutMs = isPrimary ? 115000 : 80000;
          const form = new FormData();
          // Some OpenAI-compatible gateways expect "image", others "image[]".
          // We attach under both names is rejected by strict servers, so we
          // try "image" first (OpenAI canonical).
          form.append('image', blob, `${options.referenceImage.label || 'mascot'}.webp`);
          form.append('prompt', prompt);
          form.append('n', '1');
          form.append('size', '1024x1024');
          form.append('response_format', 'b64_json');
          // Include the model field — most gateways require it.
          form.append('model', provider.model);
          console.log(`[scene-generate] image ${provider.id} (img2img) @ ${url} timeout=${timeoutMs}ms`);
          const response = await withTimeout(
            fetch(url, {
              method: 'POST',
              headers: { Authorization: `Bearer ${provider.apiKey}`, 'User-Agent': 'Supabase-Edge-Function' },
              body: form,
            }),
            timeoutMs,
            `Provider ${provider.id} img2img timeout after ${timeoutMs}ms`,
          );
          const data = await parseResponseJson(response);
          if (response.ok) {
            const b64 = data?.data?.[0]?.b64_json;
            if (typeof b64 === 'string' && b64.length > 0) {
              return { dataUrl: `data:image/png;base64,${b64}`, providerId: provider.id, model: provider.model, attemptedUrl: url, img2Img: true };
            }
            const imageUrl = data?.data?.[0]?.url;
            if (typeof imageUrl === 'string' && imageUrl.length > 0) {
              const dataUrl = await convertImageUrlToDataUrl(imageUrl);
              if (dataUrl) return { dataUrl, providerId: provider.id, model: provider.model, attemptedUrl: url, img2Img: true };
            }
            console.warn(`[scene-generate] img2img @ ${url} OK but no image; falling back to text-only`);
          } else {
            console.warn(`[scene-generate] img2img @ ${url} HTTP ${response.status}: ${JSON.stringify(data?.error || data)?.substring(0, 200)}; falling back to text-only`);
          }
        } catch (error) {
          const isTimeout = error instanceof Error && error.message.includes('timeout');
          console.warn(`[scene-generate] img2img @ ${url} threw: ${isTimeout ? 'timeout' : (error instanceof Error ? error.message : String(error))}; falling back to text-only`);
        }
      }
    }
  }

  let lastFailure: ProviderAttemptFailure | null = null;
  for (const url of urls) {
    try {
      const timeoutMs = isPrimary ? 115000 : 80000;
      const requestBody = JSON.stringify({ model: provider.model, prompt, n: 1, size: '1024x1024', response_format: 'b64_json' });
      console.log(`[scene-generate] image ${provider.id} @ ${url} timeout=${timeoutMs}ms`);
      const response = await withTimeout(
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}`, 'User-Agent': 'Supabase-Edge-Function' },
          body: requestBody,
        }),
        timeoutMs,
        `Provider ${provider.id} timeout after ${timeoutMs}ms`,
      );

      const data = await parseResponseJson(response);
      if (!response.ok) {
        lastFailure = { providerId: provider.id, url, status: response.status, message: data?.error?.message || `${response.status} ${response.statusText}` };
        continue;
      }

      const b64 = data?.data?.[0]?.b64_json;
      if (typeof b64 === 'string' && b64.length > 0) {
        return { dataUrl: `data:image/png;base64,${b64}`, providerId: provider.id, model: provider.model, attemptedUrl: url, img2Img: false };
      }
      const imageUrl = data?.data?.[0]?.url;
      if (typeof imageUrl === 'string' && imageUrl.length > 0) {
        const dataUrl = await convertImageUrlToDataUrl(imageUrl);
        if (dataUrl) return { dataUrl, providerId: provider.id, model: provider.model, attemptedUrl: url, img2Img: false };
      }
      lastFailure = { providerId: provider.id, url, message: 'response has no b64_json/url' };
    } catch (error) {
      const isTimeout = error instanceof Error && error.message.includes('timeout');
      lastFailure = { providerId: provider.id, url, message: isTimeout ? `Request timeout after ${isPrimary ? '115s' : '80s'}` : (error instanceof Error ? error.message : String(error)) };
    }
  }
  return { error: lastFailure || { providerId: provider.id, url: provider.baseUrl, message: 'generation failed' } };
};

// ----------------------------------------------------------------
// ① Scene director (text LLM) — §4 contract
//
// NOTE: the deterministic fallback (storyboard-first refactor) lives in
// sceneDesign.ts as `buildFusionResult`, which returns BOTH the image prompt
// AND a storyboard + per-word cloze sentences so the cloze UI is never
// degraded to "Picture only" just because the director failed.
// ----------------------------------------------------------------
interface SceneWordMetaInput { text: string; pos: string; definitionCn: string; }
interface DesignLLMConfig { baseUrl: string; apiKey: string; model: string; }

const chatCompletionsUrl = (baseUrl: string): string => {
  const s = normalizeUrl(baseUrl);
  if (!s) return '';
  return s.endsWith('/chat/completions') ? s : `${s}/v1/chat/completions`;
};

const designScene = async (
  words: SceneWordMetaInput[],
  dayIndex: number,
  cfg: DesignLLMConfig,
): Promise<{ design: { structuredPrompt: string; elements: any[]; sceneConcept?: string; sceneTitle?: string } | null; diagnostics: any | null; failReason: string | null; httpStatus?: number; rawHead?: string }> => {
  if (!cfg.apiKey || !cfg.baseUrl) {
    console.warn('[scene-generate] design skipped: no design LLM key/endpoint');
    return { design: null, diagnostics: null, failReason: 'no-key-or-endpoint' };
  }

  const mascot = MASCOT_DESCRIPTIONS[dayIndex] || MASCOT_DESCRIPTIONS[0];
  const systemPrompt = buildSceneDirectorSystemPrompt();
  const userPayload = buildSceneDirectorUserPayload(words, dayIndex, mascot);

  let lastHttpStatus: number | undefined;
  let lastHttpError: string | undefined;
  let lastRawHead: string | undefined;
  let lastException: string | undefined;

  const call = async (useJsonMode: boolean): Promise<string> => {
    const url = chatCompletionsUrl(cfg.baseUrl);
    if (!url) return '';
    const userContent = JSON.stringify(userPayload) +
      '\n\nRespond with a SINGLE JSON object only. No markdown fences, no prose before/after. ' +
      'Do NOT emit <think> tags or any chain-of-thought preamble — output the JSON object directly. ' +
      'The object MUST contain keys: storyboard (string), sceneTitle (string), sceneConcept (string), structuredPrompt (string), elements (array). ' +
      'EVERY entry in elements[] MUST include a non-empty "sentence" string — this is the cloze clue shown to the learner and there is no fallback inside the element. ' +
      `The structuredPrompt MUST contain EXACTLY ONE ${MASCOT_PLACEHOLDER} token. ` +
      `The storyboard MUST contain ⌈N/2⌉–N sentences; every sentence must include 1–2 of the input target words verbatim, and every input word must appear at least once across the storyboard.`;
    const body: Record<string, unknown> = {
      model: cfg.model,
      // Reasoning-style models (DeepSeek-R1, MiniMax-M1, Qwen-QwQ, etc.)
      // emit a <think>...</think> block BEFORE the JSON answer, and that
      // block counts toward max_tokens. With max_tokens=1800 the response
      // was being truncated MID-reasoning, so the JSON never emerged and
      // the parser saw unparseable prose. 4000 leaves comfortable room for
      // both reasoning (~2-3k tokens) and the JSON payload (~1-1.5k).
      max_tokens: 4000,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    };
    // Some OpenAI-compatible gateways truncate the stream / return ~1 token when
    // response_format is forwarded to non-OpenAI models. Default OFF; only enable
    // when the model is known to support it (opt-in via SCENE_DESIGN_JSON_MODE=true).
    if (useJsonMode) body['response_format'] = { type: 'json_object' };
    try {
      const response = await withTimeout(
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}`, 'User-Agent': 'Supabase-Edge-Function' },
          body: JSON.stringify(body),
        }),
        55000,
        'design timeout after 55s',
      );
      const data = await parseResponseJson(response);
      if (!response.ok) {
        lastHttpStatus = response.status;
        lastHttpError = JSON.stringify(data?.error || data)?.substring(0, 200);
        console.warn(`[scene-generate] design http ${response.status}: ${lastHttpError}`);
        return '';
      }
      const content = typeof data?.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content : '';
      lastRawHead = JSON.stringify(content.substring(0, 500));
      console.log(`[scene-generate] design raw len=${content.length} head=${lastRawHead}`);
      return content;
    } catch (err) {
      lastException = err instanceof Error ? err.message : String(err);
      console.warn(`[scene-generate] design error: ${lastException}`);
      return '';
    }
  };

  // Strategy: ask for plain-text JSON first (works for any instruction-following
  // model, avoids gateway response_format truncation). Only retry WITH json_object
  // if the model clearly needs it AND opted in. Short/garbage output short-circuits
  // so we never burn the full timeout budget on a broken response.
  const wantsJsonMode = (Deno.env.get('SCENE_DESIGN_JSON_MODE') || '').toLowerCase() === 'true';
  let content = await call(wantsJsonMode);
  let parsed = content && content.trim().length >= 40 ? parseSceneDesignWithDiagnostics(content, words) : { design: null, diagnostics: null };
  if (!parsed.design && wantsJsonMode) {
    // opted-in json mode failed -> one retry without it.
    console.log('[scene-generate] design retry (json_mode -> plain JSON)');
    content = await call(false);
    parsed = content && content.trim().length >= 40 ? parseSceneDesignWithDiagnostics(content, words) : { design: null, diagnostics: null };
  }
  if (!parsed.design) {
    let failReason: string;
    if (lastException) {
      failReason = `exception: ${lastException}`;
    } else if (lastHttpStatus) {
      failReason = `http ${lastHttpStatus}: ${lastHttpError || 'unknown'}`;
    } else if (!content) {
      failReason = 'empty response';
    } else if (content.trim().length < 40) {
      failReason = `short response (${content.trim().length} chars): ${lastRawHead || content.substring(0, 60)}`;
    } else {
      failReason = `unparseable JSON: ${lastRawHead || content.substring(0, 80)}`;
    }
    console.warn(`[scene-generate] design failed (${failReason}) -> buildFusionResult fallback`);
    if (parsed.diagnostics) {
      console.log(`[scene-generate] design diagnostics: ${JSON.stringify(parsed.diagnostics)}`);
    }
    return { design: null, diagnostics: parsed.diagnostics, failReason, httpStatus: lastHttpStatus, rawHead: lastRawHead };
  }

  const design = parsed.design;
  const diagnostics = parsed.diagnostics;
  console.log(`[scene-generate] design ok: ${design.elements.length}/${words.length} elements, ${diagnostics.zonesAssigned} zones, ${diagnostics.validSentences}/${diagnostics.inputWordCount} sentences valid, mascotPlaceholder=${diagnostics.mascotPlaceholder.count}, title="${(design.sceneTitle || '').substring(0, 40)}"`);
  console.log(`[scene-generate] design diagnostics: ${JSON.stringify(diagnostics)}`);
  return { design, diagnostics, failReason: null };
};

// ----------------------------------------------------------------
// ③ Vision region refinement (multimodal LLM) — OPTIONAL, default OFF
// ----------------------------------------------------------------
interface DetectedRegion { word: string; x: number; y: number; w: number; h: number; confidence: number; }

const detectRegions = async (
  dataUrl: string,
  words: SceneWordMetaInput[],
  cfg: DesignLLMConfig,
  zoneHints: Map<string, string>,
): Promise<DetectedRegion[]> => {
  if (!cfg.apiKey || !cfg.baseUrl) {
    console.warn('[scene-generate] vision skipped: no vision LLM key/endpoint');
    return [];
  }

  const enumerated = words.map((w, i) => {
    const zone = zoneHints.get(w.text.toLowerCase());
    const zoneHint = zone ? ` (expected near ${zone})` : '';
    return `${i + 1}. ${w.text} (${w.definitionCn || '—'})${zoneHint}`;
  }).join('\n');
  const instruction = [
    'You are given an isometric cartoon scene that contains exactly these visual elements:',
    enumerated,
    '',
    'Find each element\'s tight bounding box in the image. Coordinates are NORMALIZED to [0,1] where (0,0) is top-left and (1,1) is bottom-right.',
    'Respond as JSON: {"regions":[{"word":"<exact word>","x":<top-left x>,"y":<top-left y>,"w":<width>,"h":<height>,"confidence":<0..1>}]}.',
    '- Every word in the list MUST appear exactly once in "regions".',
    '- If an element is genuinely not visible, still emit a region with a best-guess location and set confidence <= 0.3.',
    '- Output ONLY the JSON object, no prose.',
  ].join('\n');

  const url = chatCompletionsUrl(cfg.baseUrl);
  if (!url) return [];

  const attempt = async (useJsonMode: boolean): Promise<any | null> => {
    try {
      const response = await withTimeout(
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}`, 'User-Agent': 'Supabase-Edge-Function' },
          body: JSON.stringify({
            model: cfg.model,
            max_tokens: 1000,
            ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}),
            messages: [
              { role: 'user', content: [
                { type: 'text', text: instruction },
                { type: 'image_url', image_url: { url: dataUrl } },
              ] },
            ],
          }),
        }),
        60000,
        'vision timeout after 60s',
      );
      const data = await parseResponseJson(response);
      if (!response.ok) {
        console.warn(`[scene-generate] vision http ${response.status}: ${JSON.stringify(data?.error || data)?.substring(0, 200)}`);
        return null;
      }
      return data;
    } catch (err) {
      console.warn(`[scene-generate] vision error: ${err}`);
      return null;
    }
  };

  let data = await attempt(true);
  if (!data) data = await attempt(false);
  if (!data) return [];

  const rawContent: string = data?.choices?.[0]?.message?.content || '';
  if (!rawContent) return [];

  let parsed: any = null;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    const match = rawContent.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { /* ignore */ }
    }
  }
  if (!parsed || !Array.isArray(parsed.regions)) return [];

  const validWords = new Set(words.map((w) => w.text.toLowerCase()));
  const regions: DetectedRegion[] = [];
  for (const r of parsed.regions) {
    if (!r || typeof r.word !== 'string') continue;
    const word = r.word.trim();
    if (!validWords.has(word.toLowerCase())) continue;
    const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    regions.push({
      word,
      x: Math.max(0, Math.min(1, num(r.x))),
      y: Math.max(0, Math.min(1, num(r.y))),
      w: Math.max(0, Math.min(1, num(r.w))),
      h: Math.max(0, Math.min(1, num(r.h))),
      confidence: Math.max(0, Math.min(1, num(r.confidence))),
    });
  }
  return regions;
};

// ----------------------------------------------------------------
// Persist image + regions (per-user cache + scene_design JSONB)
// ----------------------------------------------------------------
const persistScene = async (
  sb: ReturnType<typeof getSupabaseClient>,
  params: {
    userId: string;
    wordSetHash: string;
    dayIndex: number;
    language: string;
    words: SceneWordMetaInput[];
    dataUrl: string;
    prompt: string;
    model: string;
    regions: any[];
    sceneDesign: any;
    status: 'ready' | 'failed';
    errorMessage: string | null;
  },
) => {
  // Decode original image bytes (no WebP conversion — see note below).
  // Earlier code called convertToWebP here, but Deno's
  // OffscreenCanvas.convertToBlob({type:'image/webp'}) silently falls back to
  // PNG, leaving storage with mimetype:image/png + a .webp filename. Until
  // front-end WebP conversion (a la image-generate@1eacefc) is added, persist
  // raw PNG with a matching .png extension so mimetype == extension.
  const base64Match = params.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!base64Match) throw new Error('Invalid image dataUrl');
  const contentType = base64Match[1] || 'image/png';
  const binaryString = atob(base64Match[2]);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  const blob = new Blob([bytes], { type: contentType });

  const storagePath = `scenes/${params.userId}/${params.dayIndex}/${params.wordSetHash}.png`;
  const { error: ulErr } = await sb.storage.from(NEW_BUCKET).upload(storagePath, blob, {
    contentType: blob.type || 'image/png',
    cacheControl: '31536000',
    upsert: true,
  });
  if (ulErr) {
    console.error(`[scene-generate] storage upload failed: ${ulErr.message}`);
    throw new Error(`storage upload failed: ${ulErr.message}`);
  }

  const { data: urlData } = sb.storage.from(NEW_BUCKET).getPublicUrl(storagePath);
  const publicUrl = urlData.publicUrl;
  if (!publicUrl) throw new Error('storage getPublicUrl returned empty');

  // regions always carry one entry per word (zone/default/vision); keep source for debugging.
  // Carry through `sentence` when present (added by the v2 director pipeline).
  const fullRegions = params.words.map((w) => {
    const found = params.regions.find((r) => r.word && r.word.toLowerCase() === w.text.toLowerCase());
    const sentence = found && typeof found.sentence === 'string' && found.sentence.trim()
      ? found.sentence.trim()
      : null;
    if (!found) {
      const c = zoneToBbox(DEFAULT_ZONE);
      const base = { word: w.text, x: c.x, y: c.y, w: c.w, h: c.h, confidence: 0.5, source: 'default' };
      return sentence ? { ...base, sentence } : base;
    }
    const base = {
      word: w.text,
      x: found.x,
      y: found.y,
      w: found.w,
      h: found.h,
      confidence: found.confidence,
      source: found.source || 'zone',
    };
    return sentence ? { ...base, sentence } : base;
  });

  const row = {
    user_id: params.userId,
    word_set_hash: params.wordSetHash,
    day_index: params.dayIndex,
    language: params.language,
    words: JSON.stringify(params.words),
    storage_bucket: NEW_BUCKET,
    storage_path: storagePath,
    public_url: publicUrl,
    prompt: params.prompt,
    regions: JSON.stringify(fullRegions),
    scene_design: params.sceneDesign ? JSON.stringify(params.sceneDesign) : null,
    model: params.model,
    status: params.status,
    error_message: params.errorMessage,
  };

  const { data: asset, error } = await sb
    .from('scene_assets')
    .upsert(row, { onConflict: 'user_id,word_set_hash,day_index,language' })
    .select('id, created_at')
    .single();

  if (error) throw new Error(`scene_assets upsert failed: ${error.message}`);

  return {
    id: asset.id,
    wordSetHash: params.wordSetHash,
    dayIndex: params.dayIndex,
    language: params.language,
    imageUrl: publicUrl,
    storagePath: storagePath,
    prompt: params.prompt,
    regions: fullRegions,
    sceneDesign: params.sceneDesign || null,
    model: params.model,
    status: params.status,
    createdAt: asset.created_at,
  };
};

// ----------------------------------------------------------------
// Auth: resolve the caller's user id from the forwarded JWT (per-user cache)
// ----------------------------------------------------------------
const resolveUserId = async (req: Request): Promise<string | null> => {
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  if (!anonKey || !supabaseUrl) return null;
  try {
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data } = await userClient.auth.getUser();
    return data?.user?.id || null;
  } catch (err) {
    console.warn(`[scene-generate] auth resolve failed: ${err}`);
    return null;
  }
};

// ----------------------------------------------------------------
// LLM config resolution — server-side only (Supabase Edge Secrets).
// ① director reads SCENE_DESIGN_*; ③ vision reads SCENE_VISION_* and falls
// back to the director's endpoint/key (but NOT to PRIMARY_IMAGE_GEN_* — that
// chain is for ② image rendering only).
// ----------------------------------------------------------------
interface LLMConfig { baseUrl: string; apiKey: string; model: string; }

const envStr = (name: string): string => {
  const v = Deno.env.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

const resolveDesignConfig = (): LLMConfig => ({
  baseUrl: envStr('SCENE_DESIGN_BASE_URL'),
  apiKey: envStr('SCENE_DESIGN_API_KEY'),
  model: envStr('SCENE_DESIGN_MODEL') || 'gpt-4o',
});

const resolveVisionEnabled = (bodyVisionEnabled: boolean): boolean =>
  bodyVisionEnabled === true || Deno.env.get('SCENE_VISION_ENABLED') === 'true';

const resolveVisionConfig = (designCfg: LLMConfig): LLMConfig => ({
  baseUrl: envStr('SCENE_VISION_BASE_URL') || designCfg.baseUrl,
  apiKey: envStr('SCENE_VISION_API_KEY') || designCfg.apiKey,
  model: envStr('SCENE_VISION_MODEL') || 'gpt-4o',
});

// ----------------------------------------------------------------
// Handler
// ----------------------------------------------------------------
const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

// NDJSON streaming response. Each event is enqueued as a single JSON line + '\n'.
// The frontend reads via res.body.getReader() + TextDecoder, parsing line-by-line.
//
// Event protocol (see plan §1):
//   { stage: 'designed',  prompt, source: 'director'|'fallback', sceneTitle? }
//   { stage: 'rendered',  providerId }
//   { stage: 'persisted' }
//   { stage: 'done',      source: 'generated'|'cache-hit', asset, degraded, pipeline? }
//   { stage: 'error',     failedStage: 'designed'|'rendered'|'persisted'|'unknown', error, failures? }
//
// `Cache-Control: no-cache, no-transform` + `X-Accel-Buffering: no` ask intermediaries
// (Nginx, CDN) not to buffer the whole stream before forwarding.
const ndjsonResponse = (
  pipelineRunner: (send: (event: any) => void) => Promise<void>,
): Response => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: any) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        } catch (e) {
          console.warn('[scene-generate] enqueue failed (stream closed?):', e);
        }
      };
      try {
        await pipelineRunner(send);
      } catch (err) {
        // Unexpected error not handled by stage-specific catches.
        console.error('[scene-generate] pipeline uncaught:', err);
        try {
          send({ stage: 'error', failedStage: 'unknown', error: err instanceof Error ? err.message : String(err) });
        } catch { /* stream already closed */ }
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const action = typeof body?.action === 'string' ? body.action.trim() : '';
    const wordsRaw = Array.isArray(body?.words) ? body.words : [];
    const dayIndex = Number(body?.dayIndex);
    const language = typeof body?.language === 'string' ? body.language.trim() : 'en';
    const force = body?.force === true || body?.force === '1';
    // ③ vision on/off may be toggled from the Admin Console (non-sensitive).
    const visionEnabledBody = body?.visionEnabled === true;

    // ---- probe: verify the director can actually produce cloze sentences ----
    // Old probe sent `max_tokens:1, content:'ping'` — that only checked API key
    // validity, which gave false-positive "ok" on directors that were silently
    // dropping the `sentence` field. The new probe sends a real 3-word design
    // request, parses the response, and reports whether elements[0].sentence
    // came back. This makes the Admin Console button reflect real director
    // health, not just gateway connectivity.
    if (action === 'probe') {
      const userId = await resolveUserId(req);
      if (!userId) return json({ ok: false, error: 'Authentication required' }, 401);
      const cfg = resolveDesignConfig();
      if (!cfg.baseUrl || !cfg.apiKey) {
        return json({ ok: false, error: 'SCENE_DESIGN_* secret not configured (BASE_URL/API_KEY missing)' }, 502);
      }
      const url = chatCompletionsUrl(cfg.baseUrl);
      const startedAt = Date.now();
      const masked = cfg.baseUrl.length > 24 ? `${cfg.baseUrl.slice(0, 12)}…${cfg.baseUrl.slice(-8)}` : cfg.baseUrl;
      try {
        const testWords: SceneWordMetaInput[] = [
          { text: 'apple', pos: 'noun', definitionCn: '苹果' },
          { text: 'run', pos: 'verb', definitionCn: '跑' },
          { text: 'moon', pos: 'noun', definitionCn: '月亮' },
        ];
        const mascot = MASCOT_DESCRIPTIONS[0];
        const sysPrompt = buildSceneDirectorSystemPrompt();
        const userPayload = JSON.stringify(buildSceneDirectorUserPayload(testWords, 0, mascot)) +
          '\n\nRespond with a SINGLE JSON object only. EVERY element MUST include "sentence".';
        const response = await withTimeout(
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}`, 'User-Agent': 'Supabase-Edge-Function' },
            body: JSON.stringify({
              model: cfg.model,
              max_tokens: 800,
              temperature: 0.7,
              messages: [
                { role: 'system', content: sysPrompt },
                { role: 'user', content: userPayload },
              ],
            }),
          }),
          30000,
          'probe timeout after 30s',
        );
        const latencyMs = Date.now() - startedAt;
        if (!response.ok) {
          const data = await parseResponseJson(response);
          return json({ ok: false, error: data?.error?.message || `director HTTP ${response.status}`, status: 502, latencyMs, model: cfg.model, baseUrl: masked }, 502);
        }
        const data = await parseResponseJson(response);
        const content = typeof data?.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content : '';
        if (content.trim().length < 40) {
          return json({
            ok: false,
            error: `director returned short response (len=${content.length}): ${content.slice(0, 120)}`,
            latencyMs, model: cfg.model, baseUrl: masked,
          }, 502);
        }
        const parsed = parseSceneDesignWithDiagnostics(content, testWords);
        const design = parsed.design;
        const diag = parsed.diagnostics;
        const sentencesProduced = design ? design.elements.filter((e: any) => typeof e.sentence === 'string' && e.sentence.trim().length > 0).length : 0;
        const sampleSentence = design?.elements?.[0]?.sentence || '';
        return json({
          ok: !!design && sentencesProduced >= 1,
          probe: 'design',
          model: cfg.model,
          latencyMs,
          baseUrl: masked,
          parsed: !!design,
          hasStoryboard: !!diag?.storyboardPresent,
          storyboardViolation: diag?.storyboardViolation || null,
          elementCount: design?.elements?.length || 0,
          sentencesProduced,
          failReason: diag?.failReason || null,
          rawContentHead: diag?.rawContentHead || content.slice(0, 200),
          sampleSentence,
        });
      } catch (err) {
        return json({ ok: false, error: err instanceof Error ? err.message : String(err), status: 502, latencyMs: Date.now() - startedAt, model: cfg.model, baseUrl: masked }, 502);
      }
    }

    if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex > 6) return json({ error: 'Invalid dayIndex (0-6)' }, 400);

    const words: SceneWordMetaInput[] = [];
    for (const w of wordsRaw) {
      if (!w || typeof w.text !== 'string') continue;
      words.push({
        text: w.text.trim(),
        pos: typeof w.pos === 'string' ? w.pos.trim().toLowerCase() : 'noun',
        definitionCn: typeof w.definitionCn === 'string' ? w.definitionCn.trim() : '',
      });
    }
    if (words.length < 5 || words.length > 10) return json({ error: 'words must contain 5-10 entries' }, 400);

    const userId = await resolveUserId(req);
    if (!userId) return json({ error: 'Authentication required' }, 401);

    // SCENE_HASH_VERSION prefixes the word-set hash to invalidate cached scene
    // assets when the data contract changes (e.g. adding the `sentence` field).
    // Bump this whenever you need every user to regenerate fresh scenes.
    // v3 (storyboard-first refactor): scene_assets now carries scene_design.storyboard
    // and a guaranteed sentence per element (via buildFusionResult fallback path).
    // v4 (sentence-first prompt + diagnostics): prompt restructured so cloze
    // sentences are the PRIMARY deliverable, fallback no longer emits Chinese
    // translation, diagnostics persisted in scene_design on fallback for
    // debuggability. Bumps cache because old rows carry the broken fallback.
    // v5 (reasoning-model fix): max_tokens 1800->4000 + explicit "no <think>"
    // directive in user payload. Reasoning models (DeepSeek-R1, MiniMax-M1)
    // were eating the whole budget on chain-of-thought and getting truncated
    // before emitting any JSON. Bumps cache because v4 records all hit the
    // reasoning-truncation fallback.
    const SCENE_HASH_VERSION = 'v5';
    const normalizedWords = words.map((w) => normalizeWord(w.text)).sort();
    const wordSetHash = `${SCENE_HASH_VERSION}-${(await sha1Hex(normalizedWords.join('|'))).slice(0, 12)}`;

    const sb = getSupabaseClient();

    // === From here on, all responses are NDJSON streams. ===
    // Input-validation errors above still return JSON (400/401). Pipeline
    // progress, mid-pipeline failures, and the final asset all flow as NDJSON
    // events so the client can drive its preparing-stage UI off real signals.
    return ndjsonResponse(async (send) => {
      // Cache check (per-user). A hit emits a single `done` event and closes.
      // If public_url is empty (defensive — should never happen), treat as miss.
      if (!force) {
        const { data: cached } = await sb
          .from('scene_assets')
          .select('*')
          .eq('user_id', userId)
          .eq('word_set_hash', wordSetHash)
          .eq('day_index', dayIndex)
          .eq('language', language)
          .eq('status', 'ready')
          .maybeSingle();
        if (cached) {
          if (!cached.public_url) {
            console.warn(`[scene-generate] cache hit ${wordSetHash} but public_url empty -> regenerate`);
          } else {
            console.log(`[scene-generate] cache hit ${wordSetHash} day=${dayIndex} user=${userId.substring(0, 8)}`);
            send({
              stage: 'done',
              source: 'cache-hit',
              asset: {
                id: cached.id,
                wordSetHash: cached.word_set_hash,
                dayIndex: cached.day_index,
                language: cached.language,
                imageUrl: cached.public_url,
                storagePath: cached.storage_path,
                prompt: cached.prompt || '',
                regions: cached.regions || [],
                sceneDesign: cached.scene_design || null,
                model: cached.model || '',
                status: cached.status,
                createdAt: cached.created_at,
              },
              degraded: false,
            });
            return;
          }
        }
      }

      // ① Scene director
      const designCfg = resolveDesignConfig();
      let designResult: { design: { structuredPrompt: string; elements: any[]; sceneConcept?: string; sceneTitle?: string } | null; diagnostics: any | null; failReason: string | null; httpStatus?: number; rawHead?: string } = { design: null, diagnostics: null, failReason: 'not-called' };
      try {
        designResult = await designScene(words, dayIndex, designCfg);
      } catch (err) {
        send({ stage: 'error', failedStage: 'designed', error: `director threw: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      const design = designResult.design;
      const designDiagnostics = designResult.diagnostics;

      // Fetch the canonical mascot image (data URL or null) up-front. We need
      // it both for [TODAYS_MASCOT] text-substitution diagnostics AND for the
      // img2img reference-image path.
      const mascotFetch = await fetchMascotDataUrl(dayIndex);
      const mascotDataUrl = mascotFetch.dataUrl;
      const mascotShortText = MASCOT_SHORT_DESCRIPTION[dayIndex] || MASCOT_SHORT_DESCRIPTION[0];

      let prompt: string;
      let structuredPromptRaw: string | null = null; // pre-substitution form, stored on scene_design
      let placeholderSubstitution: { replacedCount: number; usingTextFallback: boolean } | null = null;
      let sceneDesignPayload: any = null;
      let fellBack = false;
      let fallbackResult: ReturnType<typeof buildFusionResult> | null = null;
      if (design) {
        structuredPromptRaw = design.structuredPrompt;
        // Replace the [TODAYS_MASCOT] placeholder. When we have a real mascot
        // image AND img2img is enabled, we still replace it with the short text
        // description so the text-only fallback path (and any image-gen provider
        // that ends up not supporting edits) still has a coherent sentence.
        // The actual reference image is sent alongside via multipart.
        const substitution = replaceMascotPlaceholder(design.structuredPrompt, mascotShortText);
        prompt = substitution.prompt;
        placeholderSubstitution = {
          replacedCount: substitution.replacedCount,
          usingTextFallback: !mascotDataUrl,
        };
        if (designDiagnostics) {
          designDiagnostics.mascotPlaceholder.replacedInStructuredPrompt = substitution.replacedCount > 0;
        }
        sceneDesignPayload = {
          sceneTitle: design.sceneTitle || null,
          sceneConcept: design.sceneConcept || null,
          // Storyboard-first: forward the LLM-authored storyboard so the
          // PREPARING stage UI can preview the scene idea and the DB schema
          // carries the same contract as the fallback path.
          storyboard: design.storyboard || null,
          structuredPrompt: design.structuredPrompt, // preserve original (with placeholder) for reproducibility
          elements: design.elements,
          source: 'director',
        };
      } else {
        // buildFusionResult always emits a valid storyboard + one sentence per
        // word (verified by parseStoryboard), so the cloze UI never degrades to
        // "Picture only" when the director fails.
        fallbackResult = buildFusionResult(words, dayIndex);
        prompt = fallbackResult.prompt;
        fellBack = true;
        console.log(`[scene-generate] director failed/absent -> buildFusionResult fallback (reason: ${designResult.failReason})`);
        // Persist the diagnostics so the next failure is debuggable from the DB
        // alone (no need to grep edge-function console logs). `rawContentHead`
        // is the first ~200 chars of what the LLM actually returned — this is
        // the evidence trail that was missing before.
        const fbDiagnostics = designResult.diagnostics;
        sceneDesignPayload = {
          sceneTitle: null,
          sceneConcept: null,
          storyboard: fallbackResult.storyboard,
          structuredPrompt: null,
          elements: fallbackResult.sentences.map((s) => ({
            word: s.word,
            sentence: s.sentence,
            positionZone: null,
          })),
          sentences: fallbackResult.sentences,
          source: 'fallback',
          fallbackReason: designResult.failReason,
          diagnostics: fbDiagnostics
            ? {
                failReason: fbDiagnostics.failReason,
                rawContentLength: fbDiagnostics.rawContentLength,
                rawContentHead: fbDiagnostics.rawContentHead,
                thinkBlockStripped: fbDiagnostics.thinkBlockStripped,
                fenceBlockStripped: fbDiagnostics.fenceBlockStripped,
                jsonExtractedFromProse: fbDiagnostics.jsonExtractedFromProse,
                storyboardPresent: fbDiagnostics.storyboardPresent,
                storyboardViolation: fbDiagnostics.storyboardViolation,
                validSentences: fbDiagnostics.validSentences,
                droppedSentences: fbDiagnostics.droppedSentences,
                missingSentenceFields: fbDiagnostics.missingSentenceFields,
              }
            : { failReason: designResult.failReason },
        };
      }
      // → emit designed (real evidence: prompt string exists)
      // When fell back, include the failure reason so the client can surface it.
      const storyboardForEvent =
        (design?.storyboard && design.storyboard.trim()) ||
        (fellBack ? fallbackResult?.storyboard : null) ||
        null;
      send({
        stage: 'designed',
        prompt,
        source: fellBack ? 'fallback' : 'director',
        sceneTitle: design?.sceneTitle || null,
        storyboard: storyboardForEvent,
        diagnostics: designDiagnostics || undefined,
        mascot: {
          referenceImageAvailable: !!mascotDataUrl,
          source: mascotFetch.source,
          placeholderReplacedCount: placeholderSubstitution?.replacedCount ?? 0,
          usingTextFallback: placeholderSubstitution?.usingTextFallback ?? false,
        },
        ...(fellBack && designResult.failReason ? { fallbackReason: designResult.failReason } : {}),
      });

      // ② Render
      const providers = getProviderConfigs();
      if (providers.length === 0) {
        send({ stage: 'error', failedStage: 'rendered', error: 'No image generation providers configured' });
        return;
      }

      const referenceImage = mascotDataUrl
        ? { dataUrl: mascotDataUrl, label: `mascot-day-${dayIndex}` }
        : null;

      const failures: ProviderAttemptFailure[] = [];
      let generated: { dataUrl: string; providerId: ProviderId; model: string; img2Img: boolean } | null = null;
      for (let i = 0; i < providers.length; i++) {
        const result = await tryGenerateByProvider(providers[i], prompt, providers.length > 1 && i === 0, { referenceImage });
        if ('error' in result) { failures.push(result.error); continue; }
        generated = { dataUrl: result.dataUrl, providerId: result.providerId, model: result.model, img2Img: result.img2Img };
        break;
      }
      if (!generated) {
        send({ stage: 'error', failedStage: 'rendered', error: 'All image providers failed', failures });
        return;
      }
      // → emit rendered (real evidence: image dataUrl exists)
      send({ stage: 'rendered', providerId: generated.providerId, img2Img: generated.img2Img });

      // Regions — DEFAULT path: derive from director zones (no extra model call).
      let regions = deriveRegionsFromElements(
        design ? { structuredPrompt: design.structuredPrompt, elements: design.elements } : { structuredPrompt: '', elements: [] },
        words,
      );
      // Fallback path: no director elements → inject the deterministic fallback
      // sentences so each region carries its cloze sentence just like the
      // director path does.
      if (fellBack && fallbackResult) {
        const fallbackByWord = new Map(
          fallbackResult.sentences.map((s) => [s.word.toLowerCase(), s.sentence]),
        );
        regions = regions.map((r) => {
          const sentence = fallbackByWord.get(r.word.toLowerCase());
          return sentence ? { ...r, sentence } : r;
        });
      }
      let regionsSource: string = fellBack ? 'default' : 'zone';

      // ③ Optional vision refinement (only when enabled)
      const visionEnabled = resolveVisionEnabled(visionEnabledBody);
      let visionModelUsed = '';
      if (visionEnabled) {
        const visionCfg = resolveVisionConfig(designCfg);
        const zoneHints = new Map<string, string>();
        for (const el of design?.elements || []) {
          if (el.positionZone) zoneHints.set(String(el.word).toLowerCase(), el.positionZone);
        }
        let detected: DetectedRegion[] = [];
        try {
          detected = await detectRegions(generated.dataUrl, words, visionCfg, zoneHints);
        } catch (err) {
          console.warn(`[scene-generate] vision detection threw: ${err}`);
        }
        visionModelUsed = visionCfg.model;
        if (detected.length > 0) {
          const byWord = new Map(detected.map((r) => [r.word.toLowerCase(), r]));
          let visionCount = 0;
          regions = regions.map((r) => {
            const v = byWord.get(r.word.toLowerCase());
            if (v) {
              visionCount += 1;
              return { word: r.word, x: v.x, y: v.y, w: v.w, h: v.h, confidence: v.confidence, source: 'vision' as const };
            }
            return r;
          });
          regionsSource = visionCount === regions.length ? 'vision' : 'mixed';
          console.log(`[scene-generate] vision refined ${visionCount}/${words.length} regions`);
        } else {
          console.log('[scene-generate] vision enabled but returned 0 regions -> keeping zone/default regions');
        }
      }

      // persistScene (upload + DB upsert)
      let asset;
      try {
        asset = await persistScene(sb, {
          userId,
          wordSetHash,
          dayIndex,
          language,
          words,
          dataUrl: generated.dataUrl,
          prompt,
          model: generated.model,
          regions,
          sceneDesign: sceneDesignPayload,
          status: 'ready',
          errorMessage: null,
        });
      } catch (err) {
        send({ stage: 'error', failedStage: 'persisted', error: err instanceof Error ? err.message : String(err) });
        return;
      }
      // → emit persisted (real evidence: scene_assets row written, publicUrl non-empty)
      send({ stage: 'persisted' });

      console.log(`[scene-generate] generated ${wordSetHash} day=${dayIndex} user=${userId.substring(0, 8)} design=${design ? 'director' : 'fallback'} regions=${regionsSource} vision=${visionEnabled ? 'on' : 'off'} img2img=${generated.img2Img} mascotSrc=${mascotFetch.source}`);

      // → emit done (final asset; client switches to MODE_SELECT)
      send({
        stage: 'done',
        source: 'generated',
        degraded: false,
        asset,
        diagnostics: designDiagnostics || undefined,
        pipeline: {
          design: design ? 'director' : 'fallback',
          regions: regionsSource,
          vision: visionEnabled ? (visionModelUsed || 'on') : 'off',
          img2img: generated.img2Img,
          mascot: mascotFetch.source,
          placeholderReplacedCount: placeholderSubstitution?.replacedCount ?? 0,
        },
      });
    });
  } catch (error) {
    console.error('[scene-generate] handler error:', error);
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
