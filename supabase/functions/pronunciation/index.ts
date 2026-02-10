// Supabase Edge Function: Pronunciation Proxy
// 通过服务器代理音频请求，解决CORS问题
// 访问: https://your-project.supabase.co/functions/v1/pronunciation

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// CORS headers for all responses
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// China-accessible pronunciation sources
const PRONUNCIATION_SOURCES = {
  youdao: (word: string, type: '1' | '2' = '2') =>
    `https://dict.youdao.com/dictvoice?type=${type}&audio=${encodeURIComponent(word)}`,
  iciba: (word: string) =>
    `https://res.iciba.com/resource/amp3/${encodeURIComponent(word)}.mp3`,
  iciba_uk: (word: string) =>
    `https://res.iciba.com/resource/amp3/oxford/${encodeURIComponent(word)}.mp3`,
  dictcn: (word: string) =>
    `https://mp3.dict.cn/mp3/${encodeURIComponent(word)}.mp3`,
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const word = url.searchParams.get('word');
    const source = url.searchParams.get('source') || 'youdao';
    const lang = url.searchParams.get('lang') || 'en';

    if (!word) {
      return new Response(
        JSON.stringify({ error: 'Missing "word" parameter' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Build audio URL based on source
    let audioUrl: string;
    switch (source) {
      case 'youdao':
        audioUrl = PRONUNCIATION_SOURCES.youdao(word, lang === 'en-GB' ? '1' : '2');
        break;
      case 'iciba':
        audioUrl = PRONUNCIATION_SOURCES.iciba(word);
        break;
      case 'iciba-uk':
        audioUrl = PRONUNCIATION_SOURCES.iciba_uk(word);
        break;
      case 'dictcn':
        audioUrl = PRONUNCIATION_SOURCES.dictcn(word);
        break;
      default:
        audioUrl = PRONUNCIATION_SOURCES.youdao(word);
    }

    console.log(`Fetching audio: ${audioUrl}`);

    // Fetch audio from source
    const audioResponse = await fetch(audioUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
    });

    if (!audioResponse.ok) {
      throw new Error(`Source returned ${audioResponse.status}`);
    }

    // Get audio content type
    const contentType = audioResponse.headers.get('content-type') || 'audio/mpeg';

    // Get audio data
    const audioData = await audioResponse.arrayBuffer();

    // Return audio data with proper headers
    return new Response(audioData, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
      },
    });
  } catch (error) {
    console.error('Pronunciation proxy error:', error);

    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
