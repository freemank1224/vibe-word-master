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
const minimaxVoiceId = 'English_CalmWoman';
const minimaxSpeed = Number(Deno.env.get('MINIMAX_TTS_SPEED') || '0.95');
const minimaxPitch = Number(Deno.env.get('MINIMAX_TTS_PITCH') || '0');
const minimaxVol = Number(Deno.env.get('MINIMAX_TTS_VOL') || '1');
const ttsFormat = Deno.env.get('MINIMAX_TTS_AUDIO_FORMAT') || 'mp3';
const ttsSampleRate = Number(Deno.env.get('MINIMAX_TTS_SAMPLE_RATE') || '16000');
const ttsBitrate = Number(Deno.env.get('MINIMAX_TTS_BITRATE') || '32000');
const ttsChannel = Number(Deno.env.get('MINIMAX_TTS_CHANNEL') || '1');

const storageBucket = 'word-audio';
const modelVersion = 'minimax-2.8-turbo-v1';

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const normalizeWord = (text: string): string => text.toLowerCase().trim().replace(/\s+/g, ' ');

const contentTypeFromFormat = (format: string): string => {
  if (format === 'mp3') return 'audio/mpeg';
  if (format === 'wav') return 'audio/wav';
  if (format === 'flac') return 'audio/flac';
  return 'application/octet-stream';
};

const upsertJob = async (assetId: string) => {
  await supabase
    .from('pronunciation_generation_jobs')
    .upsert({
      asset_id: assetId,
      status: 'pending',
      priority: 5,
      retry_count: 0,
      max_retries: 3,
      scheduled_at: new Date().toISOString()
    }, { onConflict: 'asset_id' });
};

const buildStoragePath = (normalizedWord: string): string => {
  const escaped = encodeURIComponent(normalizedWord);
  return `en/${escaped}_${minimaxVoiceId}_${ttsSampleRate}_${ttsBitrate}.${ttsFormat}`;
};

type UniquenessMode = 'strict' | 'relaxed';

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

    const minimaxPayload = {
      model: minimaxModel,
      text: word,
      stream: false,
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

    const ttsResp = await fetch(minimaxEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${minimaxApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(minimaxPayload)
    });

    if (!ttsResp.ok) {
      const errText = await ttsResp.text();
      throw new Error(`Minimax request failed (${ttsResp.status}): ${errText}`);
    }

    const ttsJson = await ttsResp.json();
    const statusCode = ttsJson?.base_resp?.status_code;
    const statusMsg = ttsJson?.base_resp?.status_msg;

    if (statusCode !== 0 || !ttsJson?.data?.audio) {
      throw new Error(`Minimax synth failed: ${statusCode} ${statusMsg || ''}`);
    }

    const hexAudio: string = ttsJson.data.audio;
    const byteLength = Math.floor(hexAudio.length / 2);
    const audioBytes = new Uint8Array(byteLength);
    for (let i = 0; i < byteLength; i++) {
      audioBytes[i] = parseInt(hexAudio.substr(i * 2, 2), 16);
    }

    const storagePath = buildStoragePath(normalizedWord);
    const uploadContentType = contentTypeFromFormat(ttsFormat);

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
      duration_ms: ttsJson?.extra_info?.audio_length || null,
      file_size_bytes: ttsJson?.extra_info?.audio_size || audioBytes.byteLength,
      storage_bucket: storageBucket,
      storage_path: storagePath,
      public_url: publicData.publicUrl,
      source_type: 'tts',
      status: 'ready',
      error_message: null
    };

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
          .update(assetPayload)
          .eq('id', anyExisting.id)
          .select('id')
          .single();
        upserted = updated;
        upsertError = error as any;

        await supabase
          .from('pronunciation_assets')
          .update({
            status: 'disabled',
            error_message: 'Disabled by strict uniqueness dedup'
          })
          .eq('normalized_word', normalizedWord)
          .eq('language', lang)
          .neq('id', anyExisting.id)
          .eq('status', 'ready');
      } else {
        const { data: inserted, error } = await supabase
          .from('pronunciation_assets')
          .insert(assetPayload)
          .select('id')
          .single();
        upserted = inserted;
        upsertError = error as any;
      }
    } else {
      const { data, error } = await supabase
        .from('pronunciation_assets')
        .upsert(assetPayload, {
          onConflict: 'normalized_word,language,accent,voice,codec,sample_rate_hz,model_provider,model_name,model_version'
        })
        .select('id')
        .single();
      upserted = data;
      upsertError = error as any;
    }

    if (upsertError) {
      throw new Error(`Asset upsert failed: ${upsertError.message}`);
    }

    if (upserted?.id) {
      const { error: mapError } = await supabase
        .from('words')
        .update({ pronunciation_asset_id: upserted.id, audio_url: publicData.publicUrl })
        .eq('text', word)
        .eq('language', lang);

      if (mapError) {
        console.warn('Word mapping warning:', mapError.message);
      }

      await upsertJob(upserted.id);
    }

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
    return new Response(JSON.stringify({ error: (error as Error).message || 'unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
