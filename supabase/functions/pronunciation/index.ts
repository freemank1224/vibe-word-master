import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const minimaxApiKey = Deno.env.get('MINIMAX_API_KEY') || '';

const minimaxEndpoint = Deno.env.get('MINIMAX_TTS_ENDPOINT') || 'https://api.minimaxi.com/v1/t2a_v2';
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
const modelVersion = 'minimax-2.8-turbo-v1';

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const normalizeWord = (text: string): string => text.toLowerCase().trim().replace(/\s+/g, ' ');

const toBackoffMs = (attempt: number): number => {
  return Math.min(4000, 500 * (attempt + 1));
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableStatus = (status?: number): boolean => {
  if (!status) return false;
  return status === 429 || status >= 500;
};

const contentTypeFromFormat = (format: string): string => {
  if (format === 'mp3') return 'audio/mpeg';
  if (format === 'wav') return 'audio/wav';
  if (format === 'flac') return 'audio/flac';
  return 'application/octet-stream';
};

const ensureJob = async (assetId: string): Promise<{ retry_count: number; max_retries: number } | null> => {
  const { data: existing, error: existingError } = await supabase
    .from('pronunciation_generation_jobs')
    .select('retry_count, max_retries')
    .eq('asset_id', assetId)
    .maybeSingle();

  if (existingError) {
    console.warn('Load pronunciation job failed:', existingError.message);
  }

  if (existing) {
    return {
      retry_count: Number(existing.retry_count || 0),
      max_retries: Number(existing.max_retries || 3),
    };
  }

  const { data: created, error: createError } = await supabase
    .from('pronunciation_generation_jobs')
    .insert({
      asset_id: assetId,
      status: 'pending',
      priority: 5,
      retry_count: 0,
      max_retries: 3,
      scheduled_at: new Date().toISOString()
    })
    .select('retry_count, max_retries')
    .single();

  if (createError) {
    console.warn('Create pronunciation job failed:', createError.message);
    return null;
  }

  return {
    retry_count: Number(created?.retry_count || 0),
    max_retries: Number(created?.max_retries || 3),
  };
};

const markJobProcessing = async (assetId: string) => {
  await supabase
    .from('pronunciation_generation_jobs')
    .update({
      status: 'processing',
      started_at: new Date().toISOString(),
      finished_at: null,
      last_error: null,
    })
    .eq('asset_id', assetId);
};

const markJobDone = async (assetId: string) => {
  await supabase
    .from('pronunciation_generation_jobs')
    .update({
      status: 'done',
      finished_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('asset_id', assetId);
};

const markJobRetryOrFailed = async (assetId: string, message: string) => {
  const current = await ensureJob(assetId);
  const retryCount = Number(current?.retry_count || 0);
  const maxRetries = Number(current?.max_retries || 3);
  const nextRetryCount = retryCount + 1;
  const shouldFail = nextRetryCount > maxRetries;

  const scheduledAt = new Date(Date.now() + Math.min(300000, nextRetryCount * 15000)).toISOString();

  await supabase
    .from('pronunciation_generation_jobs')
    .update({
      status: shouldFail ? 'failed' : 'pending',
      retry_count: nextRetryCount,
      scheduled_at: scheduledAt,
      finished_at: shouldFail ? new Date().toISOString() : null,
      last_error: message.slice(0, 2000),
    })
    .eq('asset_id', assetId);
};

const buildStoragePath = (normalizedWord: string): string => {
  const escaped = encodeURIComponent(normalizedWord);
  return `en/${escaped}_${minimaxVoiceId}_${ttsSampleRate}_${ttsBitrate}.${ttsFormat}`;
};

type UniquenessMode = 'strict' | 'relaxed';

const requestMinimaxWithRetry = async (payload: Record<string, unknown>) => {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= minimaxRetryTimes; attempt++) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), minimaxTimeoutMs);

    try {
      const ttsResp = await fetch(minimaxEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${minimaxApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!ttsResp.ok) {
        const errText = await ttsResp.text();
        const err = new Error(`Minimax request failed (${ttsResp.status}): ${errText}`);
        (err as any).status = ttsResp.status;
        throw err;
      }

      const ttsJson = await ttsResp.json();
      const statusCode = ttsJson?.base_resp?.status_code;
      const statusMsg = ttsJson?.base_resp?.status_msg;

      if (statusCode !== 0 || !ttsJson?.data?.audio) {
        const err = new Error(`Minimax synth failed: ${statusCode} ${statusMsg || ''}`);
        (err as any).status = statusCode;
        throw err;
      }

      return ttsJson;
    } catch (error) {
      const err = error as Error;
      lastError = err;
      const status = Number((err as any)?.status || 0);
      const retryable = err.name === 'AbortError' || isRetryableStatus(status);
      if (!retryable || attempt >= minimaxRetryTimes) {
        throw err;
      }
      await sleep(toBackoffMs(attempt));
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  throw lastError || new Error('Unknown Minimax request failure');
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return new Response(JSON.stringify({ error: 'Missing Supabase service env vars' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  if (!minimaxApiKey) {
    return new Response(JSON.stringify({ error: 'Missing MINIMAX_API_KEY in Edge Function env' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  let activeAssetId: string | null = null;
  try {
    const requestUrl = new URL(req.url);
    const word = (requestUrl.searchParams.get('word') || '').trim();
    const lang = (requestUrl.searchParams.get('lang') || 'en').trim();
    const forceRegenerate = requestUrl.searchParams.get('force') === '1';
    const uniquenessMode: UniquenessMode = requestUrl.searchParams.get('uniqueness_mode') === 'relaxed' ? 'relaxed' : 'strict';

    if (!word) {
      return new Response(JSON.stringify({ error: 'Missing "word" parameter' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const normalizedWord = normalizeWord(word);
    const storagePath = buildStoragePath(normalizedWord);
    const uploadContentType = contentTypeFromFormat(ttsFormat);

    const baseAssetPayload = {
      normalized_word: normalizedWord,
      display_word: word,
      language: lang,
      accent: 'en-US',
      voice: minimaxVoiceId,
      model_provider: 'minimax',
      model_name: minimaxModel,
      model_version: modelVersion,
      codec: ttsFormat,
      sample_rate_hz: ttsSampleRate,
      bitrate_kbps: Math.round(ttsBitrate / 1000),
      storage_bucket: storageBucket,
      storage_path: storagePath,
      source_type: 'tts',
    };

    let existingAssetQuery = supabase
      .from('pronunciation_assets')
      .select('*')
      .eq('normalized_word', normalizedWord)
      .eq('language', lang)
      .eq('status', 'ready')
      .order('updated_at', { ascending: false })
      .limit(1);

    if (uniquenessMode === 'relaxed') {
      existingAssetQuery = existingAssetQuery
        .eq('accent', 'en-US')
        .eq('voice', minimaxVoiceId)
        .eq('codec', ttsFormat)
        .eq('sample_rate_hz', ttsSampleRate)
        .eq('model_provider', 'minimax')
        .eq('model_name', minimaxModel)
        .eq('model_version', modelVersion);
    }

    const { data: existingAsset, error: selectError } = await existingAssetQuery.maybeSingle();

    if (selectError) {
      throw new Error(`Asset lookup failed: ${selectError.message}`);
    }

    if (existingAsset && existingAsset.status === 'ready' && existingAsset.public_url && !forceRegenerate) {
      activeAssetId = existingAsset.id;
      await ensureJob(existingAsset.id);
      await markJobDone(existingAsset.id);

      const cachedResponse = await fetch(existingAsset.public_url);
      if (cachedResponse.ok) {
        const audioData = await cachedResponse.arrayBuffer();
        return new Response(audioData, {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': contentTypeFromFormat(existingAsset.codec || ttsFormat),
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Pronunciation-Source': 'supabase-asset-hit'
          }
        });
      }
    }

    let upserted: { id: string } | null = null;
    let upsertError: { message: string } | null = null;

    if (uniquenessMode === 'strict') {
      const { data: anyExisting } = await supabase
        .from('pronunciation_assets')
        .select('id')
        .eq('normalized_word', normalizedWord)
        .eq('language', lang)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (anyExisting?.id) {
        const { data: updated, error } = await supabase
          .from('pronunciation_assets')
          .update({
            ...baseAssetPayload,
            status: 'pending',
            error_message: null,
          })
          .eq('id', anyExisting.id)
          .select('id')
          .single();
        upserted = updated;
        upsertError = error as any;
      } else {
        const { data: inserted, error } = await supabase
          .from('pronunciation_assets')
          .insert({
            ...baseAssetPayload,
            status: 'pending',
            error_message: null,
          })
          .select('id')
          .single();
        upserted = inserted;
        upsertError = error as any;
      }
    } else {
      const { data, error } = await supabase
        .from('pronunciation_assets')
        .upsert({
          ...baseAssetPayload,
          status: 'pending',
          error_message: null,
        }, {
          onConflict: 'normalized_word,language,accent,voice,codec,sample_rate_hz,model_provider,model_name,model_version'
        })
        .select('id')
        .single();
      upserted = data;
      upsertError = error as any;
    }

    if (upsertError || !upserted?.id) {
      throw new Error(`Asset prepare failed: ${upsertError?.message || 'unknown'}`);
    }

    activeAssetId = upserted.id;
    await ensureJob(activeAssetId);
    await markJobProcessing(activeAssetId);

    const minimaxPayload = {
      model: minimaxModel,
      text: word,
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
      }
    };

    const ttsJson = await requestMinimaxWithRetry(minimaxPayload);

    const hexAudio: string = ttsJson.data.audio;
    const byteLength = Math.floor(hexAudio.length / 2);
    const audioBytes = new Uint8Array(byteLength);
    for (let i = 0; i < byteLength; i++) {
      audioBytes[i] = parseInt(hexAudio.substr(i * 2, 2), 16);
    }

    const { error: uploadError } = await supabase.storage
      .from(storageBucket)
      .upload(storagePath, audioBytes, {
        contentType: uploadContentType,
        upsert: true,
        cacheControl: '31536000'
      });

    if (uploadError) {
      throw new Error(`Storage upload failed: ${uploadError.message}`);
    }

    const { data: publicData } = supabase.storage.from(storageBucket).getPublicUrl(storagePath);

    const assetPayload = {
      ...baseAssetPayload,
      bitrate_kbps: Math.round(ttsBitrate / 1000),
      duration_ms: ttsJson?.extra_info?.audio_length || null,
      file_size_bytes: ttsJson?.extra_info?.audio_size || audioBytes.byteLength,
      public_url: publicData.publicUrl,
      status: 'ready',
      error_message: null
    };

    const { error: finalizeError } = await supabase
      .from('pronunciation_assets')
      .update(assetPayload)
      .eq('id', activeAssetId);

    if (finalizeError) {
      throw new Error(`Asset finalize failed: ${finalizeError.message}`);
    }

    const { data: targetWords, error: targetWordError } = await supabase
      .from('words')
      .select('id')
      .ilike('text', word)
      .eq('language', lang)
      .or('deleted.eq.false,deleted.is.null');

    if (targetWordError) {
      console.warn('Word target lookup warning:', targetWordError.message);
    } else if ((targetWords || []).length > 0) {
      const ids = (targetWords || []).map((item: any) => item.id).filter(Boolean);
      if (ids.length > 0) {
        const { error: mapError } = await supabase
          .from('words')
          .update({ pronunciation_asset_id: activeAssetId, audio_url: publicData.publicUrl })
          .in('id', ids);

        if (mapError) {
          console.warn('Word mapping warning:', mapError.message);
        }
      }
    }

    await markJobDone(activeAssetId);

    return new Response(audioBytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': uploadContentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Pronunciation-Source': 'minimax-generated'
      }
    });
  } catch (error) {
    console.error('Pronunciation generation error:', error);
    if (activeAssetId) {
      const errMessage = (error as Error).message || 'unknown error';
      await supabase
        .from('pronunciation_assets')
        .update({ status: 'failed', error_message: errMessage.slice(0, 2000) })
        .eq('id', activeAssetId);
      await markJobRetryOrFailed(activeAssetId, errMessage);
    }
    return new Response(JSON.stringify({ error: (error as Error).message || 'unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
