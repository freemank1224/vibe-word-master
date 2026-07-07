// @ts-nocheck
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ================================================================
// scene-tts edge function — sentence-level TTS for the Scene Fusion Game.
//
// Mirrors the `pronunciation` function's MiniMax call shape, but:
//   • Input is a full sentence (?text=...) instead of a single word.
//   • No DB writes — uses Supabase Storage as the cache.
//   • Storage path: word-audio/sentences/{sha256(text)}.mp3
//   • Returns audio/mpeg bytes with immutable cache headers.
//
// Reuses the same MiniMax env vars already configured for `pronunciation`:
//   MINIMAX_API_KEY, MINIMAX_TTS_* (endpoint/model/voice/speed/...).
// ================================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const minimaxApiKey = Deno.env.get('MINIMAX_API_KEY') || '';

const configuredMinimaxEndpoint = Deno.env.get('MINIMAX_TTS_ENDPOINT') || 'https://api.minimaxi.com/v1/t2a_v2';
const configuredMinimaxFallbacks = (Deno.env.get('MINIMAX_TTS_FALLBACK_ENDPOINTS') || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const minimaxModel = Deno.env.get('MINIMAX_TTS_MODEL') || 'speech-2.8-turbo';
const minimaxVoiceId = Deno.env.get('MINIMAX_TTS_VOICE_ID') || 'English_CalmWoman';
const minimaxSpeed = Number(Deno.env.get('MINIMAX_TTS_SPEED') || '0.8');
const minimaxPitch = Number(Deno.env.get('MINIMAX_TTS_PITCH') || '0');
const minimaxVol = Number(Deno.env.get('MINIMAX_TTS_VOL') || '1');
const ttsFormat = Deno.env.get('MINIMAX_TTS_AUDIO_FORMAT') || 'mp3';
const ttsSampleRate = Number(Deno.env.get('MINIMAX_TTS_SAMPLE_RATE') || '16000');
const ttsBitrate = Number(Deno.env.get('MINIMAX_TTS_BITRATE') || '32000');
const ttsChannel = Number(Deno.env.get('MINIMAX_TTS_CHANNEL') || '1');
const minimaxTimeoutMs = Number(Deno.env.get('MINIMAX_TTS_TIMEOUT_MS') || '4500');
const minimaxRetryTimes = Number(Deno.env.get('MINIMAX_TTS_RETRY_TIMES') || '1');

const storageBucket = 'word-audio';
const SENTENCE_MAX_LENGTH = 300;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ----------------------------------------------------------------
// Helpers — mirrored from pronunciation/index.ts to keep behavior aligned.
// ----------------------------------------------------------------
const uniqueEndpoints = (items: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

const minimaxEndpoints = uniqueEndpoints([
  configuredMinimaxEndpoint,
  ...(configuredMinimaxFallbacks.length > 0 ? configuredMinimaxFallbacks : ['https://api.minimaxi.com/v1/t2a_v2']),
]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableStatus = (status?: number): boolean => {
  if (!status) return false;
  return status === 429 || status >= 500;
};

const isRetryableNetworkError = (error: Error): boolean => {
  const code = String((error as any)?.code || '').toUpperCase();
  const name = String(error.name || '').toUpperCase();
  const message = String(error.message || '').toLowerCase();
  return (
    code === 'ETIMEDOUT'
    || code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'ENETUNREACH'
    || code === 'EHOSTUNREACH'
    || name === 'ABORTERROR'
    || message.includes('connection timed out')
    || message.includes('tcp connect error')
    || message.includes('network is unreachable')
    || message.includes('connection refused')
    || message.includes('connection reset')
  );
};

const toBackoffMs = (attempt: number): number => Math.min(4000, 500 * (attempt + 1));

/**
 * POST to MiniMax T2A_v2 with endpoint fallback + bounded retry. Mirrors
 * pronunciation/index.ts::requestMinimaxWithRetry line-for-line so behavior
 * (timeouts, retryable statuses, endpoint rotation) stays consistent.
 */
const requestMinimaxWithRetry = async (payload: Record<string, unknown>) => {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= minimaxRetryTimes; attempt++) {
    for (const endpoint of minimaxEndpoints) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), minimaxTimeoutMs);

      try {
        const ttsResp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${minimaxApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!ttsResp.ok) {
          const errText = await ttsResp.text();
          const err = new Error(`Minimax request failed via ${endpoint} (${ttsResp.status}): ${errText}`);
          (err as any).status = ttsResp.status;
          throw err;
        }

        const ttsJson = await ttsResp.json();
        const statusCode = ttsJson?.base_resp?.status_code;
        const statusMsg = ttsJson?.base_resp?.status_msg;

        if (statusCode !== 0 || !ttsJson?.data?.audio) {
          const err = new Error(`Minimax synth failed via ${endpoint}: ${statusCode} ${statusMsg || ''}`);
          (err as any).status = statusCode;
          throw err;
        }

        return ttsJson;
      } catch (error) {
        const err = error as Error;
        lastError = err;
        const status = Number((err as any)?.status || 0);
        const retryable = isRetryableNetworkError(err) || isRetryableStatus(status);

        console.warn(`[scene-tts] Minimax attempt failed via ${endpoint}:`, err.message || err);

        const isLastEndpoint = endpoint === minimaxEndpoints[minimaxEndpoints.length - 1];
        if (!retryable) throw err;
        if (isLastEndpoint && attempt >= minimaxRetryTimes) throw err;
        if (isLastEndpoint) await sleep(toBackoffMs(attempt));
      } finally {
        clearTimeout(timeoutHandle);
      }
    }
  }

  throw lastError || new Error('Unknown Minimax request failure');
};

const contentTypeFromFormat = (format: string): string => {
  const normalized = format.toLowerCase();
  if (normalized === 'pcm') return 'audio/pcm';
  if (normalized === 'wav') return 'audio/wav';
  return 'audio/mpeg';
};

const uploadContentType = contentTypeFromFormat(ttsFormat);

/**
 * Build a deterministic storage path for a sentence. Uses SHA-256 so the
 * cache is collision-free across sentences of varying length/content. Sits
 * under `sentences/` so it never collides with per-word audio at `en/...`.
 */
const buildStoragePath = async (sentence: string): Promise<string> => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sentence));
  const hash = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const ext = ttsFormat.toLowerCase() === 'wav' ? 'wav' : ttsFormat.toLowerCase() === 'pcm' ? 'pcm' : 'mp3';
  return `sentences/${hash}_${minimaxVoiceId}_${ttsSampleRate}_${ttsBitrate}.${ext}`;
};

// ----------------------------------------------------------------
// HTTP entry
// ----------------------------------------------------------------
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return new Response(JSON.stringify({ error: 'Missing Supabase service env vars' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!minimaxApiKey) {
    return new Response(JSON.stringify({ error: 'Missing MINIMAX_API_KEY in Edge Function env' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const requestUrl = new URL(req.url);
    const text = (requestUrl.searchParams.get('text') || '').trim();

    if (!text) {
      return new Response(JSON.stringify({ error: 'Missing "text" parameter' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (text.length > SENTENCE_MAX_LENGTH) {
      return new Response(JSON.stringify({ error: `Sentence too long (${text.length} > ${SENTENCE_MAX_LENGTH})` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const storagePath = await buildStoragePath(text);

    // 1. Cache hit — short-circuit and stream the public URL bytes back.
    const { data: existingPublic } = supabase.storage.from(storageBucket).getPublicUrl(storagePath);
    if (existingPublic?.publicUrl) {
      try {
        const head = await fetch(existingPublic.publicUrl, { method: 'GET' });
        // Some storage backends respond 200 with zero-byte objects for missing
        // files; guard by requiring a non-zero content-length.
        if (head.ok && head.status === 200 && (Number(head.headers.get('content-length') || 0) > 0)) {
          const bytes = new Uint8Array(await head.arrayBuffer());
          if (bytes.length > 0) {
            console.log(`[scene-tts] cache hit ${storagePath} (${bytes.length}B)`);
            return new Response(bytes, {
              status: 200,
              headers: {
                ...corsHeaders,
                'Content-Type': uploadContentType,
                'Cache-Control': 'public, max-age=31536000, immutable',
                'X-Scene-Tts-Source': 'cache',
              },
            });
          }
        }
      } catch (err) {
        console.warn(`[scene-tts] cache check threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 2. Cache miss — synth via MiniMax.
    const minimaxPayload = {
      model: minimaxModel,
      text,
      stream: false,
      language_boost: 'English',
      output_format: 'hex',
      subtitle_enable: false,
      voice_setting: {
        voice_id: minimaxVoiceId,
        speed: minimaxSpeed,
        vol: minimaxVol,
        pitch: minimaxPitch,
      },
      audio_setting: {
        sample_rate: ttsSampleRate,
        bitrate: ttsBitrate,
        format: ttsFormat,
        channel: ttsChannel,
      },
    };

    const ttsJson = await requestMinimaxWithRetry(minimaxPayload);

    const hexAudio: string = ttsJson.data.audio;
    const byteLength = Math.floor(hexAudio.length / 2);
    const audioBytes = new Uint8Array(byteLength);
    for (let i = 0; i < byteLength; i++) {
      audioBytes[i] = parseInt(hexAudio.substr(i * 2, 2), 16);
    }

    // 3. Upload to storage (immutable cache).
    const { error: uploadError } = await supabase.storage
      .from(storageBucket)
      .upload(storagePath, audioBytes, {
        contentType: uploadContentType,
        upsert: true,
        cacheControl: '31536000',
      });

    if (uploadError) {
      console.warn(`[scene-tts] storage upload failed: ${uploadError.message}`);
      // Non-fatal — we still return the audio bytes to the caller.
    } else {
      console.log(`[scene-tts] cached ${storagePath} (${audioBytes.length}B)`);
    }

    // 4. Return MP3 bytes.
    return new Response(audioBytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': uploadContentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Scene-Tts-Source': 'fresh',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[scene-tts] failed:', message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
