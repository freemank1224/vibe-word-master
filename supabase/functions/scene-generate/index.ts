// @ts-nocheck
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  buildSceneDirectorSystemPrompt,
  buildSceneDirectorUserPayload,
  deriveRegionsFromElements,
  parseSceneDesign,
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
): Promise<{ dataUrl: string; providerId: ProviderId; model: string; attemptedUrl: string } | { error: ProviderAttemptFailure }> => {
  const urls = getImageGenerationUrls(provider.baseUrl);
  if (urls.length === 0) return { error: { providerId: provider.id, url: provider.baseUrl, message: 'Invalid provider base URL' } };

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
        return { dataUrl: `data:image/png;base64,${b64}`, providerId: provider.id, model: provider.model, attemptedUrl: url };
      }
      const imageUrl = data?.data?.[0]?.url;
      if (typeof imageUrl === 'string' && imageUrl.length > 0) {
        const dataUrl = await convertImageUrlToDataUrl(imageUrl);
        if (dataUrl) return { dataUrl, providerId: provider.id, model: provider.model, attemptedUrl: url };
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
// WebP conversion (mirrors image-generate)
// ----------------------------------------------------------------
const convertToWebP = async (blob: Blob, maxWidth = 1024, maxHeight = 1024, quality = 0.8): Promise<Blob> => {
  try {
    const bitmap = await createImageBitmap(blob);
    let width = bitmap.width;
    let height = bitmap.height;
    if (width > maxWidth || height > maxHeight) {
      const ratio = Math.min(maxWidth / width, maxHeight / height);
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
    }
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return blob;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const webpBlob = await canvas.convertToBlob({ type: 'image/webp', quality });
    console.log(`[scene-generate] webp ${blob.size} -> ${webpBlob.size} bytes (${width}x${height})`);
    return webpBlob;
  } catch (err) {
    console.warn(`[scene-generate] webp conversion failed: ${err}`);
    return blob;
  }
};

// ----------------------------------------------------------------
// Fusion prompt builder (deterministic FALLBACK when ① fails — §3.3)
// ----------------------------------------------------------------
const POS_RULES: Record<string, (w: SceneWordMetaInput) => string> = {
  noun: (w) => `Clearly render the object or character for the noun "${w.text}" (sense: ${w.definitionCn || '—'}) as a distinct, isolated element with clear visual margin around it.`,
  adjective: (w) => `Express the adjective "${w.text}" (sense: ${w.definitionCn || '—'}) through a character's visible trait — facial expression, body language, or costume (for example "angry" means an angry red face and furrowed brows). Place that character at its own spot in the scene.`,
  verb: (w) => `Depict the action "${w.text}" (sense: ${w.definitionCn || '—'}) as a character mid-action, placed at its own spot in the scene.`,
  adverb: (w) => `Render a character behaving "${w.text}" (sense: ${w.definitionCn || '—'}); make the manner clearly visible at its own spot in the scene.`,
};

interface SceneWordMetaInput { text: string; pos: string; definitionCn: string; }

const buildFusionPrompt = (words: SceneWordMetaInput[], dayIndex: number): string => {
  const mascot = MASCOT_DESCRIPTIONS[dayIndex] || MASCOT_DESCRIPTIONS[0];
  const parts: string[] = [];

  parts.push('Isometric-perspective cartoon illustration, HD, highly detailed, vibrant saturated colors, clean studio lighting, soft global illumination, 1:1 square composition.');
  parts.push(`ALWAYS include this exact mascot somewhere in the scene as a visible, clearly identifiable, unoccluded character: ${mascot}`);

  for (const w of words) {
    const rule = POS_RULES[w.pos] || POS_RULES.noun;
    parts.push(rule(w));
  }

  parts.push(`Lay out the ${words.length} word-elements plus the mascot on a rough grid so none overlap and each word-element occupies its own distinct bounding region. Avoid stacking elements on top of each other.`);
  parts.push('Do NOT add floating captions, subtitles, UI labels, watermarks, or any text that spells out the target words. Diegetic text that belongs to objects (book covers, street signs, packaging) is allowed.');
  const enumerated = words.map((w, i) => `${i + 1}. ${w.text}`).join(', ');
  parts.push(`The scene MUST contain exactly these ${words.length} distinct visual elements corresponding to the English words: ${enumerated}. The order of this list is arbitrary; placement in the image is up to you.`);

  return parts.join(' ');
};

// ----------------------------------------------------------------
// ① Scene director (text LLM) — §4 contract
// ----------------------------------------------------------------
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
): Promise<{ structuredPrompt: string; elements: any[]; sceneConcept?: string; sceneTitle?: string } | null> => {
  if (!cfg.apiKey || !cfg.baseUrl) {
    console.warn('[scene-generate] design skipped: no design LLM key/endpoint');
    return null;
  }

  const mascot = MASCOT_DESCRIPTIONS[dayIndex] || MASCOT_DESCRIPTIONS[0];
  const systemPrompt = buildSceneDirectorSystemPrompt();
  const userPayload = buildSceneDirectorUserPayload(words, dayIndex, mascot);

  const call = async (useJsonMode: boolean): Promise<string> => {
    const url = chatCompletionsUrl(cfg.baseUrl);
    if (!url) return '';
    const userContent = JSON.stringify(userPayload) +
      '\n\nRespond with a SINGLE JSON object only. No markdown fences, no prose before/after. ' +
      'The object MUST contain keys: sceneTitle (string), sceneConcept (string), structuredPrompt (string), elements (array).';
    const body: Record<string, unknown> = {
      model: cfg.model,
      max_tokens: 1500,
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
        console.warn(`[scene-generate] design http ${response.status}: ${JSON.stringify(data?.error || data)?.substring(0, 200)}`);
        return '';
      }
      const content = typeof data?.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content : '';
      console.log(`[scene-generate] design raw len=${content.length} head=${JSON.stringify(content.substring(0, 80))}`);
      return content;
    } catch (err) {
      console.warn(`[scene-generate] design error: ${err}`);
      return '';
    }
  };

  // Strategy: ask for plain-text JSON first (works for any instruction-following
  // model, avoids gateway response_format truncation). Only retry WITH json_object
  // if the model clearly needs it AND opted in. Short/garbage output short-circuits
  // so we never burn the full timeout budget on a broken response.
  const wantsJsonMode = (Deno.env.get('SCENE_DESIGN_JSON_MODE') || '').toLowerCase() === 'true';
  let content = await call(wantsJsonMode);
  let design = content && content.trim().length >= 40 ? parseSceneDesign(content, words) : null;
  if (!design && wantsJsonMode) {
    // opted-in json mode failed -> one retry without it.
    console.log('[scene-generate] design retry (json_mode -> plain JSON)');
    content = await call(false);
    design = content && content.trim().length >= 40 ? parseSceneDesign(content, words) : null;
  }
  if (!design) {
    console.warn('[scene-generate] design failed -> buildFusionPrompt fallback');
    return null;
  }

  console.log(`[scene-generate] design ok: ${design.elements.length}/${words.length} elements zoned, title="${(design.sceneTitle || '').substring(0, 40)}"`);
  return design;
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
  // Decode + WebP
  const base64Match = params.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!base64Match) throw new Error('Invalid image dataUrl');
  const contentType = base64Match[1] || 'image/png';
  const binaryString = atob(base64Match[2]);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  const rawBlob = new Blob([bytes], { type: contentType });
  const blob = await convertToWebP(rawBlob, 1024, 1024, 0.8);

  const storagePath = `scenes/${params.userId}/${params.dayIndex}/${params.wordSetHash}.webp`;
  const { error: ulErr } = await sb.storage.from(NEW_BUCKET).upload(storagePath, blob, {
    contentType: blob.type || 'image/webp',
    cacheControl: '31536000',
    upsert: true,
  });
  if (ulErr) {
    console.error(`[scene-generate] storage upload failed: ${ulErr.message}`);
    throw new Error(`storage upload failed: ${ulErr.message}`);
  }

  const { data: urlData } = sb.storage.from(NEW_BUCKET).getPublicUrl(storagePath);
  const publicUrl = urlData.publicUrl;

  // regions always carry one entry per word (zone/default/vision); keep source for debugging.
  const fullRegions = params.words.map((w) => {
    const found = params.regions.find((r) => r.word && r.word.toLowerCase() === w.text.toLowerCase());
    if (!found) {
      const c = zoneToBbox(DEFAULT_ZONE);
      return { word: w.text, x: c.x, y: c.y, w: c.w, h: c.h, confidence: 0.5, source: 'default' };
    }
    return {
      word: w.text,
      x: found.x,
      y: found.y,
      w: found.w,
      h: found.h,
      confidence: found.confidence,
      source: found.source || 'zone',
    };
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

    // ---- probe: verify SCENE_DESIGN_* secret without any image/DB work ----
    if (action === 'probe') {
      const userId = await resolveUserId(req);
      if (!userId) return json({ ok: false, error: 'Authentication required' }, 401);
      const cfg = resolveDesignConfig();
      if (!cfg.baseUrl || !cfg.apiKey) {
        return json({ ok: false, error: 'SCENE_DESIGN_* secret not configured (BASE_URL/API_KEY missing)' }, 502);
      }
      const url = chatCompletionsUrl(cfg.baseUrl);
      const startedAt = Date.now();
      try {
        const response = await withTimeout(
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}`, 'User-Agent': 'Supabase-Edge-Function' },
            body: JSON.stringify({
              model: cfg.model,
              max_tokens: 1,
              messages: [{ role: 'user', content: 'ping' }],
            }),
          }),
          20000,
          'probe timeout after 20s',
        );
        const latencyMs = Date.now() - startedAt;
        if (!response.ok) {
          const data = await parseResponseJson(response);
          return json({ ok: false, error: data?.error?.message || `director HTTP ${response.status}`, status: 502 }, 502);
        }
        const masked = cfg.baseUrl.length > 24 ? `${cfg.baseUrl.slice(0, 12)}…${cfg.baseUrl.slice(-8)}` : cfg.baseUrl;
        return json({ ok: true, probe: 'design', model: cfg.model, latencyMs, baseUrl: masked });
      } catch (err) {
        return json({ ok: false, error: err instanceof Error ? err.message : String(err), status: 502 }, 502);
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

    const normalizedWords = words.map((w) => normalizeWord(w.text)).sort();
    const wordSetHash = (await sha1Hex(normalizedWords.join('|'))).slice(0, 16);

    const sb = getSupabaseClient();

    // Cache check (per-user)
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
        console.log(`[scene-generate] cache hit ${wordSetHash} day=${dayIndex} user=${userId.substring(0, 8)}`);
        return json({
          ok: true,
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
        });
      }
    }

    // ① Scene director
    const designCfg = resolveDesignConfig();
    const design = await designScene(words, dayIndex, designCfg);

    let prompt: string;
    let sceneDesignPayload: any = null;
    let fellBack = false;
    if (design) {
      prompt = design.structuredPrompt;
      sceneDesignPayload = {
        sceneTitle: design.sceneTitle || null,
        sceneConcept: design.sceneConcept || null,
        structuredPrompt: design.structuredPrompt,
        elements: design.elements,
        source: 'director',
      };
    } else {
      prompt = buildFusionPrompt(words, dayIndex);
      fellBack = true;
      console.log('[scene-generate] director failed/absent -> buildFusionPrompt fallback');
    }

    // ② Render
    const providers = getProviderConfigs();
    if (providers.length === 0) return json({ error: 'No image generation providers configured' }, 500);

    const failures: ProviderAttemptFailure[] = [];
    let generated: { dataUrl: string; providerId: ProviderId; model: string } | null = null;
    for (let i = 0; i < providers.length; i++) {
      const result = await tryGenerateByProvider(providers[i], prompt, providers.length > 1 && i === 0);
      if ('error' in result) { failures.push(result.error); continue; }
      generated = { dataUrl: result.dataUrl, providerId: result.providerId, model: result.model };
      break;
    }
    if (!generated) {
      return json({ ok: false, error: 'All image providers failed', failures }, 502);
    }

    // Regions — DEFAULT path: derive from director zones (no extra model call).
    let regions = deriveRegionsFromElements(
      design ? { structuredPrompt: design.structuredPrompt, elements: design.elements } : { structuredPrompt: '', elements: [] },
      words,
    );
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

    const asset = await persistScene(sb, {
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

    console.log(`[scene-generate] generated ${wordSetHash} day=${dayIndex} user=${userId.substring(0, 8)} design=${design ? 'director' : 'fallback'} regions=${regionsSource} vision=${visionEnabled ? 'on' : 'off'}`);

    return json({
      ok: true,
      source: 'generated',
      degraded: false,
      asset,
      pipeline: { design: design ? 'director' : 'fallback', regions: regionsSource, vision: visionEnabled ? (visionModelUsed || 'on') : 'off' },
    });
  } catch (error) {
    console.error('[scene-generate] handler error:', error);
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
