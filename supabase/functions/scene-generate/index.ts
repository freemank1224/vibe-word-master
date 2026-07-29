// @ts-nocheck
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  buildSceneDirectorSystemPrompt,
  buildSceneDirectorUserPayload,
  buildFusionResult,
  backfillMissingSentences,
  buildClozeGroups,
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
// Day-of-week mascot context for the director LLM.
//
// IMPORTANT: the actual per-day visual identity (color, accessory, belly text)
// is NOT described in text — it comes from the M{dayIndex}.webp reference image
// attached via multipart during img2img generation. The text only needs to give
// the director LLM a generic noun to write natural scene actions around.
//
// The 7 mascots are the same species (a "round plush cartoon monster" —
// think 7 brothers with different colors). One description fits all days.
const MASCOT_GENERIC_DESCRIPTION = 'a small round plush cartoon monster with a soft chubby body and a friendly expression';
const MASCOT_DESCRIPTIONS: Record<number, string> = {
  0: MASCOT_GENERIC_DESCRIPTION,
  1: MASCOT_GENERIC_DESCRIPTION,
  2: MASCOT_GENERIC_DESCRIPTION,
  3: MASCOT_GENERIC_DESCRIPTION,
  4: MASCOT_GENERIC_DESCRIPTION,
  5: MASCOT_GENERIC_DESCRIPTION,
  6: MASCOT_GENERIC_DESCRIPTION,
};

/**
 * SHORT phrase that replaces the `[TODAYS_MASCOT]` token inside the
 * structuredPrompt before sending it to the image model. Same for all 7 days
 * — the day-specific visual identity comes from the M{dayIndex}.webp
 * reference image attached via multipart, not from this text. The phrase just
 * gives the image model a grammatical noun so the prompt reads naturally.
 */
const MASCOT_SHORT_PHRASE = 'a small round plush monster';
const MASCOT_SHORT_DESCRIPTION: Record<number, string> = {
  0: MASCOT_SHORT_PHRASE,
  1: MASCOT_SHORT_PHRASE,
  2: MASCOT_SHORT_PHRASE,
  3: MASCOT_SHORT_PHRASE,
  4: MASCOT_SHORT_PHRASE,
  5: MASCOT_SHORT_PHRASE,
  6: MASCOT_SHORT_PHRASE,
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
  const primaryModel = Deno.env.get('PRIMARY_IMAGE_GEN_MODEL') || Deno.env.get('IMAGE_GEN_MODEL') || 'codex-gpt-image-2';
  const secondaryBaseUrl = Deno.env.get('SECONDARY_IMAGE_GEN_BASE_URL') || '';
  const secondaryApiKey = Deno.env.get('SECONDARY_IMAGE_GEN_API_KEY') || '';
  const secondaryModel = Deno.env.get('SECONDARY_IMAGE_GEN_MODEL') || 'codex-gpt-image-2';
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

// Extract the assistant text from a chat-completions response across providers.
// Most gateways speak OpenAI shape (choices[0].message.content), but some do not:
//   • Aliyun Bailian MaaS at .../compatible-mode/v1/chat/completions returns a
//     flat {"text": "...", "finish_reason": "stop"} (no `choices` array).
//   • DashScope native returns {"output": {"text": "..."}}.
// Try the standard shape first, then fall back to the others so a single
// director call works regardless of which provider the admin selected.
const extractChatContent = (data: any): string => {
  if (!data || typeof data !== 'object') return '';
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const c0 = choices[0];
  if (c0 && typeof c0 === 'object') {
    const msg = c0.message;
    if (msg && typeof msg?.content === 'string') return msg.content;
    if (typeof c0.text === 'string') return c0.text; // legacy completion shape
  }
  if (typeof data.text === 'string') return data.text;             // Aliyun flat
  const output = data.output;
  if (output && typeof output === 'object') {
    if (typeof output.text === 'string') return output.text;        // DashScope native
    const ochoices = Array.isArray(output.choices) ? output.choices : [];
    if (ochoices[0]?.message && typeof ochoices[0].message.content === 'string') {
      return ochoices[0].message.content;                           // DashScope compat
    }
  }
  return '';
};

const tryGenerateByProvider = async (
  provider: ProviderConfig,
  prompt: string,
  isPrimary: boolean,
  options?: {
    /** Optional reference image (data URL) for img2img via /v1/images/edits. */
    referenceImage?: { dataUrl: string; label?: string } | null;
  },
): Promise<{ dataUrl: string; providerId: ProviderId; model: string; attemptedUrl: string; img2Img: boolean; img2imgNote: string } | { error: ProviderAttemptFailure }> => {
  const urls = getImageGenerationUrls(provider.baseUrl);
  if (urls.length === 0) return { error: { providerId: provider.id, url: provider.baseUrl, message: 'Invalid provider base URL' } };

  // Track WHY img2img did or didn't run, so the client can surface it (e.g.
  // "fell-back:http-404" tells us the gateway doesn't implement /v1/images/edits).
  let img2imgNote = options?.referenceImage
    ? (isImg2ImgEnabled() ? 'fell-back:unspecified' : 'not-attempted:disabled')
    : 'not-attempted:no-reference-image';

  // When a reference image is supplied AND img2img isn't disabled, FIRST try
  // /v1/images/edits (multipart). On any failure (4xx / network / endpoint
  // not present), fall back to the text-only generations call below — this
  // keeps the pipeline robust against gateways that don't proxy edits.
  if (options?.referenceImage && isImg2ImgEnabled()) {
    const blob = dataUrlToBlob(options.referenceImage.dataUrl);
    const editUrls = getImageEditsUrls(provider.baseUrl);
    if (!blob) {
      img2imgNote = 'not-attempted:blob-conversion-failed';
    } else if (editUrls.length === 0) {
      img2imgNote = 'not-attempted:no-edit-url';
    } else {
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
              img2imgNote = 'used';
              return { dataUrl: `data:image/png;base64,${b64}`, providerId: provider.id, model: provider.model, attemptedUrl: url, img2Img: true, img2imgNote };
            }
            const imageUrl = data?.data?.[0]?.url;
            if (typeof imageUrl === 'string' && imageUrl.length > 0) {
              const dataUrl = await convertImageUrlToDataUrl(imageUrl);
              if (dataUrl) { img2imgNote = 'used'; return { dataUrl, providerId: provider.id, model: provider.model, attemptedUrl: url, img2Img: true, img2imgNote }; }
            }
            img2imgNote = 'fell-back:ok-no-image';
            console.warn(`[scene-generate] img2img @ ${url} OK but no image; falling back to text-only`);
          } else {
            img2imgNote = `fell-back:http-${response.status}`;
            console.warn(`[scene-generate] img2img @ ${url} HTTP ${response.status}: ${JSON.stringify(data?.error || data)?.substring(0, 200)}; falling back to text-only`);
          }
        } catch (error) {
          const isTimeout = error instanceof Error && error.message.includes('timeout');
          img2imgNote = isTimeout ? 'fell-back:timeout' : 'fell-back:exception';
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
      console.log(`[scene-generate] image ${provider.id} @ ${url} timeout=${timeoutMs}ms (img2img=${img2imgNote})`);
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
      const bodySnippet = JSON.stringify(data).slice(0, 180);
      if (!response.ok) {
        lastFailure = { providerId: provider.id, url, status: response.status, message: data?.error?.message || `${response.status} ${response.statusText}` + ` (body: ${bodySnippet})` };
        continue;
      }

      const b64 = data?.data?.[0]?.b64_json;
      if (typeof b64 === 'string' && b64.length > 0) {
        return { dataUrl: `data:image/png;base64,${b64}`, providerId: provider.id, model: provider.model, attemptedUrl: url, img2Img: false, img2imgNote };
      }
      const imageUrl = data?.data?.[0]?.url;
      if (typeof imageUrl === 'string' && imageUrl.length > 0) {
        const dataUrl = await convertImageUrlToDataUrl(imageUrl);
        if (dataUrl) return { dataUrl, providerId: provider.id, model: provider.model, attemptedUrl: url, img2Img: false, img2imgNote };
      }
      // 200 but no image — usually means we hit the WRONG endpoint (the host
      // returned an HTML page / status JSON / empty data instead of the image
      // API). Surface what actually came back so it's diagnosable.
      lastFailure = { providerId: provider.id, url, message: `response has no b64_json/url (body: ${bodySnippet})` };
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
  if (s.endsWith('/chat/completions')) return s;
  // Some providers document the OpenAI-compatible base WITH the version segment
  // already included (e.g. Aliyun Bailian: ".../compatible-mode/v1", or OpenAI's
  // own "https://api.openai.com/v1"). Appending "/v1/chat/completions" to those
  // would double the "/v1" and 404. If the base already ends in a "/vN" segment,
  // append only "/chat/completions"; otherwise add the "/v1" ourselves.
  const base = s.replace(/\/+$/, '');
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
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

  const call = async (useJsonMode: boolean, feedback?: string): Promise<string> => {
    const url = chatCompletionsUrl(cfg.baseUrl);
    if (!url) return '';
    const userContent = JSON.stringify(userPayload) +
      '\n\nRespond with a SINGLE JSON object only. No markdown fences, no prose before/after. ' +
      'Do NOT emit <think> tags or any chain-of-thought preamble — output the JSON object directly. ' +
      'The object MUST contain keys: storyboard (string), sceneTitle (string), sceneConcept (string), structuredPrompt (string), elements (array). ' +
      'EVERY entry in elements[] MUST include a non-empty "sentence" string — this is the cloze clue shown to the learner and there is no fallback inside the element. ' +
      'Every sentence MUST use ONLY common CEFR A1–A2 English words (except the target word), be 6–12 words long, and use simple Subject-Verb-Object grammar. ' +
      'CRITICAL: every elements[].sentence MUST be mutually distinct (never reuse the same sentence for two words) and each target word MUST appear EXACTLY ONCE in its own sentence (at the blank position — never elsewhere). ' +
      `The structuredPrompt MUST contain EXACTLY ONE ${MASCOT_PLACEHOLDER} token. ` +
      `The storyboard MUST contain ⌈N/2⌉–N sentences; every sentence must include 1–2 of the input target words verbatim, and every input word must appear at least once across the storyboard.` +
      (feedback ? `\n\n${feedback}` : '');
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
      const content = extractChatContent(data);
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

  // NOTE: we deliberately do NOT retry the director here. An earlier version
  // re-prompted up to 2× when sentences had drops, but each extra director call
  // (~10–55s) pushed the whole function past Supabase's wall-clock max_duration
  // and got it killed mid-stream (client saw ERR_CONNECTION_CLOSED). The director
  // PROMPT is now the primary mechanism for first-try compliance (three hard
  // rules + POS-by-POS guide + anti-duplicate example). Cheap, no-extra-call
  // safety nets handle the rare miss: duplicate sentences → merged into a
  // two-blank pair; any word still without a sentence → POS-aware backfill below.

  const design = parsed.design;
  const diagnostics = parsed.diagnostics;
  if ((diagnostics?.droppedSentences || 0) > 0) {
    // GUARANTEE no "picture-only": backfill a simple, POS-aware, distinct
    // sentence for every element the LLM still left without one. Adjectives
    // (e.g. "red") get "Something in the picture is red.", nouns get "Look at
    // the {word}.", verbs get "You can see someone {word}." — grammatical and
    // mutually distinct. This is the floor; the LLM (via the prompt) is the ceiling.
    const filled = backfillMissingSentences(design, words);
    if (filled > 0) {
      console.log(`[scene-generate] backfilled ${filled} sentence(s) the LLM could not produce → eliminating picture-only (e.g. adjective "red" → "Something in the picture is red.")`);
    }
  }
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

  const rawContent: string = extractChatContent(data);
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
    // NOTE: do NOT JSON.stringify these — supabase-js already JSON-encodes the
    // body, so pre-stringifying produces a JSONB STRING ("[...]") instead of a
    // JSONB ARRAY. Pass the raw arrays/objects and let PostgREST handle it.
    words: params.words,
    storage_bucket: NEW_BUCKET,
    storage_path: storagePath,
    public_url: publicUrl,
    prompt: params.prompt,
    regions: fullRegions,
    scene_design: params.sceneDesign ?? null,
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

// Director provider selection — switchable at runtime from the Admin Console
// ("~" panel). Both providers' keys live ONLY server-side as Edge Secrets; the
// frontend sends just the non-sensitive `directorProvider` string, never keys.
// This is an extension of §10's "keys server-side only" rule: the selector
// carries no secret material.
type DirectorProvider = 'default' | 'aliyun';
const readDirectorProvider = (body: any): DirectorProvider => {
  const p = typeof body?.directorProvider === 'string' ? body.directorProvider.trim().toLowerCase() : 'default';
  return p === 'aliyun' ? 'aliyun' : 'default';
};

const envStr = (name: string): string => {
  const v = Deno.env.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

// `default` = the original director (Minimax-m3 via SCENE_DESIGN_*).
// `aliyun`  = Tongyi/Qwen (e.g. qwen-max) via SCENE_DESIGN_ALIYUN_*, using the
//             OpenAI-compatible Aliyun MaaS endpoint — same /v1/chat/completions
//             protocol, so chatCompletionsUrl() needs no changes.
const resolveDesignConfig = (provider: DirectorProvider = 'default'): LLMConfig => {
  if (provider === 'aliyun') {
    return {
      baseUrl: envStr('SCENE_DESIGN_ALIYUN_BASE_URL'),
      apiKey: envStr('SCENE_DESIGN_ALIYUN_API_KEY'),
      model: envStr('SCENE_DESIGN_ALIYUN_MODEL') || 'qwen-max',
    };
  }
  return {
    baseUrl: envStr('SCENE_DESIGN_BASE_URL'),
    apiKey: envStr('SCENE_DESIGN_API_KEY'),
    model: envStr('SCENE_DESIGN_MODEL') || 'gpt-4o',
  };
};

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
    // clientPersist=true → edge returns raw PNG dataUrl in the `done` event;
    // client runs compressToWebP, uploads to storage, then calls finalize to
    // write scene_assets. Mirrors image-generate@1eacefc client-persist pattern.
    // Default ON (matches Pipeline A). Pass false to keep legacy server upload.
    const clientPersist = body?.clientPersist !== false;

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
      const directorProvider = readDirectorProvider(body);
      const cfg = resolveDesignConfig(directorProvider);
      const secretPrefix = directorProvider === 'aliyun' ? 'SCENE_DESIGN_ALIYUN_*' : 'SCENE_DESIGN_*';
      if (!cfg.baseUrl || !cfg.apiKey) {
        return json({ ok: false, error: `${secretPrefix} secret not configured (BASE_URL/API_KEY missing)`, provider: directorProvider }, 502);
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
              // Must mirror the main pipeline's 4000-token budget: reasoning
              // directors (Minimax-m3, DeepSeek-R1, MiniMax-M1, Qwen-QwQ) emit a
              // <think>…</think> block BEFORE the JSON, and that block counts toward
              // max_tokens. With 800 the reasoning ate the whole budget and the JSON
              // was truncated → "unparseable-json" (non-reasoning models like
              // qwen-max were unaffected, which is why Aliyun passed but Minimax
              // failed). 4000 leaves room for reasoning + the small probe JSON.
              max_tokens: 4000,
              temperature: 0.7,
              messages: [
                { role: 'system', content: sysPrompt },
                { role: 'user', content: userPayload },
              ],
            }),
          }),
          55000,
          'probe timeout after 55s',
        );
        const latencyMs = Date.now() - startedAt;
        if (!response.ok) {
          const data = await parseResponseJson(response);
          return json({ ok: false, error: data?.error?.message || `director HTTP ${response.status}`, status: 502, latencyMs, model: cfg.model, baseUrl: masked, provider: directorProvider }, 502);
        }
        const data = await parseResponseJson(response);
        const content = extractChatContent(data);
        if (content.trim().length < 40) {
          return json({
            ok: false,
            error: `director returned short response (len=${content.length}): ${content.slice(0, 120)}`,
            latencyMs, model: cfg.model, baseUrl: masked, provider: directorProvider,
          }, 502);
        }
        const parsed = parseSceneDesignWithDiagnostics(content, testWords);
        const design = parsed.design;
        const diag = parsed.diagnostics;
        const sentencesProduced = design ? design.elements.filter((e: any) => typeof e.sentence === 'string' && e.sentence.trim().length > 0).length : 0;
        const sampleSentence = design?.elements?.[0]?.sentence || '';
        const probeOk = !!design && sentencesProduced >= 1;
        return json({
          ok: probeOk,
          // Surface a human-readable reason even on the 200 path so the Admin
          // Console shows WHY a "probe failed" happened, not just that it did.
          error: probeOk
            ? undefined
            : `director responded (len=${content.length}) but produced no valid cloze sentences${diag?.failReason ? `: ${diag.failReason}` : ''}`,
          probe: 'design',
          model: cfg.model,
          provider: directorProvider,
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
        return json({ ok: false, error: err instanceof Error ? err.message : String(err), status: 502, latencyMs: Date.now() - startedAt, model: cfg.model, baseUrl: masked, provider: directorProvider }, 502);
      }
    }

    // ---- finalize: client finished browser-side WebP conversion + upload ----
    // After `clientPersist:true` flow, the edge skipped persistScene. The client
    // ran compressToWebP, uploaded to storage, and now calls finalize to write
    // the scene_assets row. Server stays authoritative for the table schema.
    if (action === 'finalize') {
      const userId = await resolveUserId(req);
      if (!userId) return json({ ok: false, error: 'Authentication required' }, 401);
      const storagePath = typeof body?.storagePath === 'string' ? body.storagePath.trim() : '';
      const publicUrl = typeof body?.publicUrl === 'string' ? body.publicUrl.trim() : '';
      const wordSetHash = typeof body?.wordSetHash === 'string' ? body.wordSetHash.trim() : '';
      const fiDayIndex = Number(body?.dayIndex);
      const fiLanguage = typeof body?.language === 'string' ? body.language.trim() : 'en';
      const fileSizeBytes = Number(body?.fileSizeBytes) || 0;
      if (!storagePath || !publicUrl || !wordSetHash) {
        return json({ ok: false, error: 'finalize requires storagePath, publicUrl, wordSetHash' }, 400);
      }
      if (!Number.isInteger(fiDayIndex) || fiDayIndex < 0 || fiDayIndex > 6) {
        return json({ ok: false, error: 'Invalid dayIndex (0-6)' }, 400);
      }
      const fiWordsRaw = Array.isArray(body?.words) ? body.words : [];
      const fiWords: SceneWordMetaInput[] = [];
      for (const w of fiWordsRaw) {
        if (!w || typeof w.text !== 'string') continue;
        fiWords.push({
          text: w.text.trim(),
          pos: typeof w.pos === 'string' ? w.pos.trim().toLowerCase() : 'noun',
          definitionCn: typeof w.definitionCn === 'string' ? w.definitionCn.trim() : '',
        });
      }
      if (fiWords.length < 5 || fiWords.length > 10) return json({ ok: false, error: 'words must contain 5-10 entries' }, 400);
      const fiRegions = Array.isArray(body?.regions) ? body.regions : [];
      const fiPrompt = typeof body?.prompt === 'string' ? body.prompt : '';
      const fiModel = typeof body?.model === 'string' ? body.model : '';
      const fiVisionModel = typeof body?.visionModel === 'string' ? body.visionModel : '';
      const fiSceneDesign = body?.sceneDesign ?? null;
      // roundRef was generated by the generation flow and must be echoed back
      // unchanged. It is the idempotency key for the charge. Validate its prefix
      // matches this request's (userId, wordSetHash, dayIndex) so a client can't
      // reuse another scene's already-paid roundRef to finalize for free.
      const roundRef = typeof body?.roundRef === 'string' ? body.roundRef.trim() : '';
      const expectedPrefix = `${userId}:${wordSetHash}:${fiDayIndex}:`;
      if (!roundRef.startsWith(expectedPrefix)) {
        return json({ ok: false, error: 'roundRef does not match this scene (prefix mismatch)' }, 400);
      }
      const sb = getSupabaseClient();

      // ── Charge BEFORE writing the asset row ────────────────────────────
      // Mirrors the original generation-flow pattern (spend → persist → refund
      // on persist failure). Idempotent on (user, 'scene_game_spend', roundRef):
      // a retried finalize with the same roundRef yields duplicate_round, which
      // we treat as "already charged, continue to (re)write the asset". We track
      // whether THIS call actually charged so we only refund our own charge if
      // the upsert below fails (never refund a prior call's successful charge).
      const SCENE_COIN_COST = 25;
      let chargedThisCall = false;
      const { data: spendResult, error: spendErr } = await sb.rpc('spend_scene_game_coins', {
        p_user_id: userId,
        p_round_ref: roundRef,
        p_amount: SCENE_COIN_COST,
      }).single();
      if (spendErr || !spendResult?.success) {
        const reason = spendResult?.reason || (spendErr ? 'rpc_error' : 'spend_error');
        if (reason !== 'duplicate_round') {
          console.log(`[scene-generate] finalize charge denied roundRef=${roundRef} reason=${reason}`);
          // Return HTTP 200 with ok:false (not 4xx/5xx) so supabase.functions.invoke
          // delivers the body to `data` instead of swallowing it into `error` —
          // the client reads `data.code === 'insufficient_balance'` to open the
          // coin modal.
          return json({
            ok: false,
            code: reason,
            new_balance: typeof spendResult?.new_balance === 'number' ? spendResult.new_balance : 0,
            error: reason === 'insufficient_balance' ? 'Not enough coins for scene game' : `Charge failed: ${reason}`,
          });
        }
        console.log(`[scene-generate] finalize duplicate_round (retry) roundRef=${roundRef} -> continue`);
      } else {
        chargedThisCall = true;
        console.log(`[scene-generate] finalize charged roundRef=${roundRef} new_balance=${spendResult.new_balance}`);
      }
      const newBalance = typeof spendResult?.new_balance === 'number' ? spendResult.new_balance : null;
      const row = {
        user_id: userId,
        word_set_hash: wordSetHash,
        day_index: fiDayIndex,
        language: fiLanguage,
        // Pass raw values — supabase-js handles JSON encoding for JSONB columns.
        // Pre-stringifying would double-encode (see persistScene fix above).
        words: fiWords,
        storage_bucket: NEW_BUCKET,
        storage_path: storagePath,
        public_url: publicUrl,
        prompt: fiPrompt,
        regions: fiRegions,
        scene_design: fiSceneDesign ?? null,
        model: fiModel,
        vision_model: fiVisionModel,
        file_size_bytes: fileSizeBytes || null,
        status: 'ready' as const,
        error_message: null,
      };
      const { data: asset, error } = await sb
        .from('scene_assets')
        .upsert(row, { onConflict: 'user_id,word_set_hash,day_index,language' })
        .select('*')
        .maybeSingle();
      if (error) {
        // Reverse our own charge so a failed save never costs the user. Only
        // refund when THIS call charged (skipped for duplicate_round retries,
        // where a prior call already paid and we must not reverse it).
        if (chargedThisCall) {
          const { error: refundErr } = await sb.rpc('refund_scene_game_coins', {
            p_user_id: userId,
            p_round_ref: roundRef,
            p_amount: SCENE_COIN_COST,
          });
          if (refundErr) console.error(`[scene-generate] finalize refund-after-upsert-fail rpc error:`, refundErr.message);
          else console.log(`[scene-generate] finalize refunded after upsert fail roundRef=${roundRef}`);
        }
        return json({ ok: false, error: `scene_assets upsert failed: ${error.message}` }, 500);
      }
      console.log(`[scene-generate] finalize wrote scene_assets id=${asset?.id} path=${storagePath} size=${fileSizeBytes} roundRef=${roundRef}`);
      return json({ ok: true, asset, roundRef, new_balance: newBalance });
    }

    // ---- refund_charge: reverse a scene charge when the saved image fails to ----
    // ---- load on the test page (or otherwise never reaches the user).        ----
    // Called by the client from the PLAYING image's onError handler. Refunds the
    // spend (idempotent) AND marks the scene_assets row status='failed' so a
    // refunded image cannot be replayed as a free cache hit later.
    if (action === 'refund_charge') {
      const userId = await resolveUserId(req);
      if (!userId) return json({ ok: false, error: 'Authentication required' }, 401);
      const roundRef = typeof body?.roundRef === 'string' ? body.roundRef.trim() : '';
      const wordSetHash = typeof body?.wordSetHash === 'string' ? body.wordSetHash.trim() : '';
      const rcDayIndex = Number(body?.dayIndex);
      const rcLanguage = typeof body?.language === 'string' ? body.language.trim() : 'en';
      if (!roundRef || !wordSetHash || !Number.isInteger(rcDayIndex) || rcDayIndex < 0 || rcDayIndex > 6) {
        return json({ ok: false, error: 'refund_charge requires roundRef, wordSetHash, dayIndex (0-6)' }, 400);
      }
      // Same prefix guard as finalize — prevents refunding an arbitrary roundRef.
      const expectedPrefix = `${userId}:${wordSetHash}:${rcDayIndex}:`;
      if (!roundRef.startsWith(expectedPrefix)) {
        return json({ ok: false, error: 'roundRef does not match this scene (prefix mismatch)' }, 400);
      }
      const sb = getSupabaseClient();
      const SCENE_COIN_COST = 25;
      const { data: refundResult, error: refundErr } = await sb.rpc('refund_scene_game_coins', {
        p_user_id: userId,
        p_round_ref: roundRef,
        p_amount: SCENE_COIN_COST,
      }).single();
      if (refundErr) {
        console.error(`[scene-generate] refund_charge rpc error roundRef=${roundRef}:`, refundErr.message);
        return json({ ok: false, error: refundErr.message }, 500);
      }
      // Mark the asset failed regardless of whether THIS refund applied (an
      // idempotent refund may report already_refunded on a double-call). The
      // invariant we want: this image must not be served again for free.
      const { error: markErr } = await sb.from('scene_assets')
        .update({ status: 'failed', error_message: 'image failed to load on test page; charge refunded' })
        .eq('user_id', userId)
        .eq('word_set_hash', wordSetHash)
        .eq('day_index', rcDayIndex)
        .eq('language', rcLanguage);
      if (markErr) console.error(`[scene-generate] refund_charge mark-failed error roundRef=${roundRef}:`, markErr.message);
      console.log(`[scene-generate] refund_charge roundRef=${roundRef} refunded=${refundResult?.refunded} already=${refundResult?.already_refunded ?? false} reason=${refundResult?.reason ?? ''} new_balance=${refundResult?.new_balance}`);
      return json({
        ok: true,
        refunded: refundResult?.refunded ?? false,
        already_refunded: refundResult?.already_refunded ?? false,
        new_balance: typeof refundResult?.new_balance === 'number' ? refundResult.new_balance : null,
      });
    }

    // ---- migrate-list: enumerate all scene_assets rows whose storage_path is .png ----
    // Client iterates this list, downloads each PNG, runs compressToWebP, uploads
    // the WebP, then calls migrate-replace to swap the row + delete the old PNG.
    if (action === 'migrate-list') {
      const userId = await resolveUserId(req);
      if (!userId) return json({ ok: false, error: 'Authentication required' }, 401);
      const sb = getSupabaseClient();
      const { data, error } = await sb
        .from('scene_assets')
        .select('id, word_set_hash, day_index, language, storage_path, public_url, user_id')
        .filter('storage_path', 'ilike', '%.png');
      if (error) return json({ ok: false, error: error.message }, 500);
      const rows = (data || []).map((r: any) => ({
        id: String(r.id),
        wordSetHash: String(r.word_set_hash || ''),
        dayIndex: Number(r.day_index ?? 0),
        language: String(r.language || 'en'),
        storagePath: String(r.storage_path || ''),
        publicUrl: String(r.public_url || ''),
        userId: String(r.user_id || ''),
      }));
      return json({ ok: true, count: rows.length, rows });
    }

    // ---- migrate-replace: client converted a PNG to WebP and asks us to swap ----
    // Body: { id, webpStoragePath, webpPublicUrl, fileSizeBytes }
    // Server updates the row and deletes the old .png from storage.
    if (action === 'migrate-replace') {
      const userId = await resolveUserId(req);
      if (!userId) return json({ ok: false, error: 'Authentication required' }, 401);
      const rowId = typeof body?.id === 'string' ? body.id.trim() : '';
      const webpStoragePath = typeof body?.webpStoragePath === 'string' ? body.webpStoragePath.trim() : '';
      const webpPublicUrl = typeof body?.webpPublicUrl === 'string' ? body.webpPublicUrl.trim() : '';
      const fileSizeBytes = Number(body?.fileSizeBytes) || 0;
      if (!rowId || !webpStoragePath || !webpPublicUrl) {
        return json({ ok: false, error: 'migrate-replace requires id, webpStoragePath, webpPublicUrl' }, 400);
      }
      const sb = getSupabaseClient();
      const { data: existing, error: selErr } = await sb
        .from('scene_assets')
        .select('id, user_id, storage_path')
        .eq('id', rowId)
        .maybeSingle();
      if (selErr) return json({ ok: false, error: selErr.message }, 500);
      if (!existing) return json({ ok: false, error: 'row not found' }, 404);
      const oldPath = String(existing.storage_path || '');
      const { error: updErr } = await sb
        .from('scene_assets')
        .update({
          storage_path: webpStoragePath,
          public_url: webpPublicUrl,
          file_size_bytes: fileSizeBytes || null,
        })
        .eq('id', rowId);
      if (updErr) return json({ ok: false, error: updErr.message }, 500);
      // Delete the old PNG file from storage (best-effort — don't fail the
      // whole migration if the storage delete is rate-limited or already gone).
      if (oldPath && oldPath.toLowerCase().endsWith('.png') && oldPath !== webpStoragePath) {
        const { error: delErr } = await sb.storage.from(NEW_BUCKET).remove([oldPath]);
        if (delErr) console.warn(`[scene-generate] migrate-replace: storage.remove(${oldPath}) failed: ${delErr.message}`);
      }
      console.log(`[scene-generate] migrate-replace ${rowId}: ${oldPath} -> ${webpStoragePath} (${fileSizeBytes}B)`);
      return json({ ok: true, id: rowId, oldPath, newPath: webpStoragePath });
    }

    // ---- orphan-cleanup: delete scene_assets rows that lack usable sentence info ----
    // A row is "orphan" if scene_design IS NULL or has no elements with a sentence.
    // Also deletes the corresponding PNG file from storage. body.onlyReturn=true
    // does a dry-run (returns what would be deleted without touching anything).
    if (action === 'orphan-cleanup') {
      const userId = await resolveUserId(req);
      if (!userId) return json({ ok: false, error: 'Authentication required' }, 401);
      const dryRun = body?.onlyReturn === true || body?.dryRun === true;
      const sb = getSupabaseClient();
      const { data, error } = await sb.from('scene_assets').select('*');
      if (error) return json({ ok: false, error: error.message }, 500);
      const orphans: any[] = [];
      for (const row of data || []) {
        const design = row.scene_design;
        let parsed: any = null;
        try {
          parsed = typeof design === 'string' ? JSON.parse(design) : design;
        } catch { /* leave parsed null */ }
        const elements = Array.isArray(parsed?.elements) ? parsed.elements : [];
        const hasSentence = elements.some((e: any) => typeof e?.sentence === 'string' && e.sentence.trim());
        if (!hasSentence) orphans.push(row);
      }
      if (dryRun) {
        return json({ ok: true, dryRun: true, count: orphans.length, rows: orphans.map((r) => ({ id: r.id, storage_path: r.storage_path, public_url: r.public_url })) });
      }
      const deleted: string[] = [];
      const storagePathsToDelete: string[] = [];
      for (const row of orphans) {
        const { error: delErr } = await sb.from('scene_assets').delete().eq('id', row.id);
        if (delErr) {
          console.warn(`[scene-generate] orphan-cleanup: row delete failed for ${row.id}: ${delErr.message}`);
          continue;
        }
        deleted.push(String(row.id));
        if (typeof row.storage_path === 'string' && row.storage_path) storagePathsToDelete.push(row.storage_path);
      }
      if (storagePathsToDelete.length > 0) {
        const { error: sdErr } = await sb.storage.from(NEW_BUCKET).remove(storagePathsToDelete);
        if (sdErr) console.warn(`[scene-generate] orphan-cleanup: storage.remove failed: ${sdErr.message}`);
      }
      console.log(`[scene-generate] orphan-cleanup deleted ${deleted.length} rows + ${storagePathsToDelete.length} files`);
      return json({ ok: true, count: deleted.length, deletedIds: deleted });
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

      // ─── Balance pre-check (NO charge yet) ──────────────────────
      // Coins are NOT deducted here. We only verify the wallet can cover the
      // cost so we can fail fast with `insufficient_balance` before burning GPU
      // time on director + render. The actual charge happens later — inside the
      // `finalize` action (clientPersist path, the active one) or right after
      // persistScene (server path) — so a user is only charged once the image is
      // successfully SAVED. If the saved image then fails to load on the test
      // page, the client calls the `refund_charge` action to reverse it.
      //
      // `roundRef` is generated here (unique per generation via Date.now()) and
      // echoed back by the client during finalize/refund as the idempotency key
      // for spend_scene_game_coins / refund_scene_game_coins. It is NOT charged
      // here — repeated here only for logging + downstream payload threading.
      const roundRef = `${userId}:${wordSetHash}:${dayIndex}:${Date.now()}`;
      const SCENE_COIN_COST = 25;
      {
        const { data: wallet } = await sb
          .from('user_wallets')
          .select('balance')
          .eq('user_id', userId)
          .maybeSingle();
        const balance = typeof wallet?.balance === 'number' ? wallet.balance : 0;
        if (balance < SCENE_COIN_COST) {
          console.log(`[scene-generate] balance_precheck denied user=${userId.substring(0, 8)} balance=${balance} cost=${SCENE_COIN_COST}`);
          send({
            stage: 'error',
            failedStage: 'coin_gate',
            code: 'insufficient_balance',
            error: 'Not enough coins for scene game',
          });
          return;
        }
        console.log(`[scene-generate] balance_precheck ok user=${userId.substring(0, 8)} balance=${balance} roundRef=${roundRef}`);
      }
      // ─── End balance pre-check ──────────────────────────────────

      // ① Scene director
      const directorProvider = readDirectorProvider(body);
      const designCfg = resolveDesignConfig(directorProvider);
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
          // One row per element; a paired element (pairWords) → one 2-word group
          // → client renders ONE row with two blanks (no answer leak).
          clozeGroups: buildClozeGroups(design),
          source: 'director',
          // Which director actually produced this design (purely additive to
          // the JSONB — no schema change). Lets us audit which model ran even
          // when the director failed and the fallback was used.
          directorProvider,
          directorModel: designCfg.model,
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
          clozeGroups: [], // fallback sentences are empty (picture-only) — no groups
          source: 'fallback',
          fallbackReason: designResult.failReason,
          // Record which director was *attempted* before falling back.
          directorProvider,
          directorModel: designCfg.model,
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
      // Forward per-element {word, sentence} so the client can prefetch TTS
      // audio in parallel with image rendering. Only `word` + `sentence` are
      // forwarded — no zones, prompts, or other metadata (keep payload small,
      // avoid spoiling image prompt in client logs).
      const elementsForEvent: { word: string; sentence: string }[] = ((
        design?.elements
        || fallbackResult?.sentences.map((s) => ({ word: s.word, sentence: s.sentence }))
        || []
      ) as any[])
        .map((e: any) => ({ word: String(e.word || ''), sentence: String(e.sentence || '').trim() }))
        .filter((e: { word: string; sentence: string }) => e.word && e.sentence);
      send({
        stage: 'designed',
        prompt,
        source: fellBack ? 'fallback' : 'director',
        directorProvider,
        directorModel: designCfg.model,
        sceneTitle: design?.sceneTitle || null,
        storyboard: storyboardForEvent,
        elements: elementsForEvent,
        // Cloze rows (1 or 2 words each). Forwarded early so a client could
        // preview pairs during PREPARING; the authoritative copy rides in
        // pendingAsset.sceneDesign / DB scene_design.
        clozeGroups: buildClozeGroups(design),
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
      let generated: { dataUrl: string; providerId: ProviderId; model: string; img2Img: boolean; img2imgNote: string } | null = null;
      for (let i = 0; i < providers.length; i++) {
        const result = await tryGenerateByProvider(providers[i], prompt, providers.length > 1 && i === 0, { referenceImage });
        if ('error' in result) { failures.push(result.error); continue; }
        generated = { dataUrl: result.dataUrl, providerId: result.providerId, model: result.model, img2Img: result.img2Img, img2imgNote: result.img2imgNote };
        break;
      }
      if (!generated) {
        // Surface per-provider failure detail in the message itself so the UI
        // (and the player) can see WHICH provider failed and HOW (HTTP status or
        // short reason) — instead of a generic "all failed". e.g.
        // "All image providers failed: newapi→HTTP 403; letsmakesail→HTTP 429; tokendance→Request timeout after 80s"
        const detail = failures
          .map((f) => {
            const shortUrl = f.url ? ' @ ' + f.url.replace(/^https?:\/\//, '').slice(0, 48) : '';
            return `${f.providerId}→${f.status ? `HTTP ${f.status}` : (f.message || 'unknown error')}${shortUrl}`;
          })
          .join('; ');
        send({
          stage: 'error',
          failedStage: 'rendered',
          error: `All image providers failed${detail ? `: ${detail}` : ''}`,
          failures,
        });
        return;
      }
      // → emit rendered (real evidence: image dataUrl exists). Surface the img2img
      // outcome so a wrong-mascot result is diagnosable: if img2img fell back to
      // text-only (gateway doesn't support /v1/images/edits), the monster is drawn
      // from the text prompt only — not the canonical reference image.
      send({ stage: 'rendered', providerId: generated.providerId, img2Img: generated.img2Img, img2imgNote: generated.img2imgNote });

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

      // persistScene (upload + DB upsert) — server path, used when clientPersist=false
      // OR client path: skip upload entirely, return raw PNG dataUrl in done event.
      let asset;
      if (!clientPersist) {
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
        // Server-persist path (clientPersist=false, currently dormant) is the
        // ONLY path that charges inside the generation flow — the asset is
        // already saved server-side here, so "saved successfully" == this point.
        // The active clientPersist path defers the charge to the `finalize`
        // action instead. If the spend is denied (rare race: balance dropped
        // between the pre-check and now), mark the just-written asset failed so
        // it cannot be replayed as a free cache hit later.
        const { data: spendResult, error: spendErr } = await sb.rpc('spend_scene_game_coins', {
          p_user_id: userId,
          p_round_ref: roundRef,
          p_amount: SCENE_COIN_COST,
        }).single();
        if (spendErr || !spendResult?.success) {
          const reason = spendResult?.reason || (spendErr ? 'rpc_error' : 'spend_error');
          console.log(`[scene-generate] server-persist charge denied roundRef=${roundRef} reason=${reason}`);
          await sb.from('scene_assets')
            .update({ status: 'failed', error_message: `charge denied: ${reason}` })
            .eq('user_id', userId)
            .eq('word_set_hash', wordSetHash)
            .eq('day_index', dayIndex)
            .eq('language', language);
          send({
            stage: 'error',
            failedStage: 'coin_gate',
            code: reason,
            error: reason === 'insufficient_balance' ? 'Not enough coins for scene game' : `Charge failed: ${reason}`,
          });
          return;
        }
        console.log(`[scene-generate] server-persist charged roundRef=${roundRef} new_balance=${spendResult.new_balance}`);
        // → emit persisted (real evidence: scene_assets row written, publicUrl non-empty)
        send({ stage: 'persisted' });
      }

      console.log(`[scene-generate] generated ${wordSetHash} day=${dayIndex} user=${userId.substring(0, 8)} design=${design ? 'director' : 'fallback'} regions=${regionsSource} vision=${visionEnabled ? 'on' : 'off'} img2img=${generated.img2Img} mascotSrc=${mascotFetch.source} clientPersist=${clientPersist}`);

      if (clientPersist) {
        // Client-side WebP conversion path. The edge skips persistScene; the
        // client receives the raw PNG dataUrl + all metadata needed to call
        // finalize after running compressToWebP + supabase.storage.upload.
        send({
          stage: 'done',
          source: 'generated',
          degraded: false,
          clientPersist: true,
          imageDataUrl: generated.dataUrl,
          pendingAsset: {
            wordSetHash,
            dayIndex,
            language,
            words,
            regions,
            sceneDesign: sceneDesignPayload,
            prompt,
            model: generated.model,
            visionModel: visionModelUsed || '',
            userId,
            // Idempotency key for the charge that `finalize` will run. Echoed
            // back unchanged so finalize retries don't double-charge (same
            // roundRef → duplicate_round → no-op).
            roundRef,
          },
          diagnostics: designDiagnostics || undefined,
          pipeline: {
            design: design ? 'director' : 'fallback',
            regions: regionsSource,
            vision: visionEnabled ? (visionModelUsed || 'on') : 'off',
            img2img: generated.img2Img,
            img2imgNote: generated.img2imgNote,
            mascot: mascotFetch.source,
            placeholderReplacedCount: placeholderSubstitution?.replacedCount ?? 0,
          },
        });
        return;
      }

      // → emit done (final asset; client switches to MODE_SELECT)
      send({
        stage: 'done',
        source: 'generated',
        degraded: false,
        asset,
        // Server-persist path already charged above; roundRef is forwarded so the
        // client can call `refund_charge` if this image fails to load on the
        // test page.
        roundRef,
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
