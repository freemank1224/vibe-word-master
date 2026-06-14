// @ts-nocheck
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ================================================================
// scene-generate edge function
//
// Fuses N words (5-10) into ONE isometric cartoon scene that also
// contains the day-of-week monster, then asks a vision model for
// per-word bounding boxes. Caches the result in scene_assets keyed
// by (word-set hash + day + language) so re-runs are instant/free.
//
// Self-contained (mirrors the style of image-generate): provider
// fallback chain + WebP conversion are inlined here so the critical
// single-word image-generate function is untouched.
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
      const timeoutMs = isPrimary ? 90000 : 60000;
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
      lastFailure = { providerId: provider.id, url, message: isTimeout ? `Request timeout after ${isPrimary ? '90s' : '60s'}` : (error instanceof Error ? error.message : String(error)) };
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
// Fusion prompt builder
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

  // 1. Style
  parts.push('Isometric-perspective cartoon illustration, HD, highly detailed, vibrant saturated colors, clean studio lighting, soft global illumination, 1:1 square composition.');

  // 2. Daily monster
  parts.push(`ALWAYS include this exact mascot somewhere in the scene as a visible, clearly identifiable, unoccluded character: ${mascot}`);

  // 3. POS-aware per-word rules
  for (const w of words) {
    const rule = POS_RULES[w.pos] || POS_RULES.noun;
    parts.push(rule(w));
  }

  // 4. Layout helper (improves bounding-box separability)
  parts.push(`Lay out the ${words.length} word-elements plus the mascot on a rough grid so none overlap and each word-element occupies its own distinct bounding region. Avoid stacking elements on top of each other.`);

  // 5. Anti-text-overlay clause
  parts.push('Do NOT add floating captions, subtitles, UI labels, watermarks, or any text that spells out the target words. Diegetic text that belongs to objects (book covers, street signs, packaging) is allowed.');

  // 6. Explicit enumerator (grounds the vision step)
  const enumerated = words.map((w, i) => `${i + 1}. ${w.text}`).join(', ');
  parts.push(`The scene MUST contain exactly these ${words.length} distinct visual elements corresponding to the English words: ${enumerated}. The order of this list is arbitrary; placement in the image is up to you.`);

  return parts.join(' ');
};

// ----------------------------------------------------------------
// Vision bounding-box detection (gpt-4o, OpenAI-compatible chat)
// ----------------------------------------------------------------
interface DetectedRegion { word: string; x: number; y: number; w: number; h: number; confidence: number; }

const getVisionConfig = (): { baseUrl: string; apiKey: string; model: string } => {
  // Defaults reuse the omgteam gateway (OpenAI-compatible, proxies gpt-4o).
  const baseUrl = (Deno.env.get('SCENE_VISION_BASE_URL') || Deno.env.get('PRIMARY_IMAGE_GEN_BASE_URL') || 'https://newapi.omgteam.me').trim();
  const apiKey = Deno.env.get('SCENE_VISION_API_KEY') || Deno.env.get('PRIMARY_IMAGE_GEN_API_KEY') || '';
  const model = Deno.env.get('SCENE_VISION_MODEL') || 'gpt-4o';
  return { baseUrl: normalizeUrl(baseUrl), apiKey, model };
};

const detectRegions = async (dataUrl: string, words: SceneWordMetaInput[]): Promise<DetectedRegion[]> => {
  const cfg = getVisionConfig();
  if (!cfg.apiKey) {
    console.warn('[scene-generate] vision skipped: no SCENE_VISION_API_KEY');
    return [];
  }

  const enumerated = words.map((w, i) => `${i + 1}. ${w.text} (${w.definitionCn || '—'})`).join('\n');
  const instruction = [
    'You are given an isometric cartoon scene that contains exactly these visual elements:',
    enumerated,
    '',
    'Find each element\'s bounding box in the image. Coordinates are NORMALIZED to [0,1] where (0,0) is top-left and (1,1) is bottom-right.',
    'Respond as JSON: {"regions":[{"word":"<exact word>","x":<top-left x>,"y":<top-left y>,"w":<width>,"h":<height>,"confidence":<0..1>}]}.',
    '- Every word in the list MUST appear exactly once in "regions".',
    '- If an element is genuinely not visible, still emit a region with a best-guess location and set confidence <= 0.3.',
    '- Output ONLY the JSON object, no prose.',
  ].join('\n');

  const buildMessages = (useJsonMode: boolean) => [
    {
      model: cfg.model,
      max_tokens: 1000,
      ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        { role: 'user', content: [
          { type: 'text', text: instruction },
          { type: 'image_url', image_url: { url: dataUrl } },
        ] },
      ],
    },
  ];

  const attempt = async (useJsonMode: boolean): Promise<any | null> => {
    const chatUrl = cfg.baseUrl.endsWith('/chat/completions') ? cfg.baseUrl : `${cfg.baseUrl}/v1/chat/completions`;
    try {
      const response = await withTimeout(
        fetch(chatUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}`, 'User-Agent': 'Supabase-Edge-Function' },
          body: JSON.stringify(buildMessages(useJsonMode)),
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
  if (!data) data = await attempt(false); // retry without json_object
  if (!data) return [];

  const rawContent: string = data?.choices?.[0]?.message?.content || '';
  if (!rawContent) return [];

  // Extract JSON from possibly-wrapped content.
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
    if (!validWords.has(word.toLowerCase())) continue; // ignore hallucinated words
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
// Persist image + regions
// ----------------------------------------------------------------
const persistScene = async (
  sb: ReturnType<typeof getSupabaseClient>,
  params: {
    wordSetHash: string;
    dayIndex: number;
    language: string;
    words: SceneWordMetaInput[];
    dataUrl: string;
    prompt: string;
    model: string;
    visionModel: string;
    regions: DetectedRegion[];
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

  const storagePath = `scenes/${params.dayIndex}/${params.wordSetHash}.webp`;
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

  // Backfill missing words with detectionFailed regions so the client knows to degrade.
  const regionMap = new Map(params.regions.map((r) => [r.word.toLowerCase(), r]));
  const fullRegions = params.words.map((w) => {
    const found = regionMap.get(w.text.toLowerCase());
    if (!found) return { word: w.text, x: 0.4, y: 0.4, w: 0.2, h: 0.2, confidence: 0, detectionFailed: true };
    return { ...found, detectionFailed: found.confidence < 0.4 };
  });

  const row = {
    word_set_hash: params.wordSetHash,
    day_index: params.dayIndex,
    language: params.language,
    words: JSON.stringify(params.words),
    storage_bucket: NEW_BUCKET,
    storage_path: storagePath,
    public_url: publicUrl,
    prompt: params.prompt,
    regions: JSON.stringify(fullRegions),
    model: params.model,
    vision_model: params.visionModel,
    status: params.status,
    error_message: params.errorMessage,
  };

  const { data: asset, error } = await sb
    .from('scene_assets')
    .upsert(row, { onConflict: 'word_set_hash,day_index,language' })
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
    model: params.model,
    visionModel: params.visionModel,
    status: params.status,
    createdAt: asset.created_at,
  };
};

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
    const wordsRaw = Array.isArray(body?.words) ? body.words : [];
    const dayIndex = Number(body?.dayIndex);
    const language = typeof body?.language === 'string' ? body.language.trim() : 'en';
    const force = body?.force === true || body?.force === '1';

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

    const normalizedWords = words.map((w) => normalizeWord(w.text)).sort();
    const wordSetHash = (await sha1Hex(normalizedWords.join('|'))).slice(0, 16);

    const sb = getSupabaseClient();

    // Cache check
    if (!force) {
      const { data: cached } = await sb
        .from('scene_assets')
        .select('*')
        .eq('word_set_hash', wordSetHash)
        .eq('day_index', dayIndex)
        .eq('language', language)
        .eq('status', 'ready')
        .maybeSingle();
      if (cached) {
        console.log(`[scene-generate] cache hit ${wordSetHash} day=${dayIndex}`);
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
            model: cached.model || '',
            visionModel: cached.vision_model || '',
            status: cached.status,
            createdAt: cached.created_at,
          },
        });
      }
    }

    // Image generation
    const providers = getProviderConfigs();
    if (providers.length === 0) return json({ error: 'No image generation providers configured' }, 500);

    const prompt = buildFusionPrompt(words, dayIndex);
    const failures: ProviderAttemptFailure[] = [];
    let generated: { dataUrl: string; providerId: ProviderId; model: string } | null = null;

    for (let i = 0; i < providers.length; i++) {
      const result = await tryGenerateByProvider(providers[i], prompt, providers.length > 1 && i === 0);
      if ('error' in result) { failures.push(result.error); continue; }
      generated = { dataUrl: result.dataUrl, providerId: result.providerId, model: result.model };
      break;
    }

    if (!generated) {
      // Persist a failed row so the client can show a clean error (not cached as ready).
      return json({ ok: false, error: 'All image providers failed', failures }, 502);
    }

    // Vision bounding-box detection
    const visionModel = getVisionConfig().model;
    let detected: DetectedRegion[] = [];
    try {
      detected = await detectRegions(generated.dataUrl, words);
    } catch (err) {
      console.warn(`[scene-generate] vision detection threw: ${err}`);
    }

    const detectedCount = detected.length;
    const failedCount = words.length - detectedCount;
    // If fewer than half the words were found, mark the asset failed (degraded but not cached).
    const status: 'ready' | 'failed' = detectedCount >= Math.ceil(words.length / 2) ? 'ready' : 'failed';

    const asset = await persistScene(sb, {
      wordSetHash,
      dayIndex,
      language,
      words,
      dataUrl: generated.dataUrl,
      prompt,
      model: generated.model,
      visionModel,
      regions: detected,
      status,
      errorMessage: status === 'failed' ? `vision found ${detectedCount}/${words.length} regions` : null,
    });

    console.log(`[scene-generate] generated ${wordSetHash} day=${dayIndex} regions=${detectedCount}/${words.length} status=${status}`);

    return json({
      ok: true,
      source: 'generated',
      degraded: status === 'failed',
      asset,
      visionStats: { detected: detectedCount, total: words.length },
    });
  } catch (error) {
    console.error('[scene-generate] handler error:', error);
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
