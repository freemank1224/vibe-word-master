import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const guanchaApiKey = Deno.env.get('GUANCHA_API_KEY') || '';
const guanchaEndpoint = (Deno.env.get('GUANCHA_ENDPOINT') || 'https://tokendance.space/gateway/v1').replace(/\/$/, '');
const guanchaModel = Deno.env.get('GUANCHA_MODEL') || 'gpt-4o-mini';
const guanchaTimeoutMs = Number(Deno.env.get('GUANCHA_TIMEOUT_MS') || '2500');

const normalizeWord = (word: string): string => word.trim();

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
    const word = normalizeWord(String(body?.word || ''));

    if (!word) {
      return new Response(JSON.stringify({ isValid: false, serviceError: true, error: 'Missing word' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!guanchaApiKey) {
      return new Response(JSON.stringify({ isValid: true, serviceError: true, suggestion: null }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), guanchaTimeoutMs);

    const response = await fetch(`${guanchaEndpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${guanchaApiKey}`,
      },
      body: JSON.stringify({
        model: guanchaModel,
        messages: [
          {
            role: 'system',
            content: 'You are a spelling checker. Return JSON only: {"isValid": boolean, "suggestion": string | null}.',
          },
          {
            role: 'user',
            content: `Check spelling of: "${word}". If valid English word or common proper noun, set isValid=true.`,
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 80,
      }),
      signal: controller.signal,
    }).finally(() => {
      clearTimeout(timeoutHandle);
    });

    if (!response.ok) {
      const details = await response.text().catch(() => '');
      return new Response(JSON.stringify({
        isValid: true,
        serviceError: true,
        error: `Upstream error ${response.status}`,
        details: details.slice(0, 400),
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const payload = await response.json().catch(() => ({}));
    const content = payload?.choices?.[0]?.message?.content;

    if (!content) {
      return new Response(JSON.stringify({ isValid: true, serviceError: true }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const parsed = JSON.parse(content);
    return new Response(JSON.stringify({
      isValid: typeof parsed?.isValid === 'boolean' ? parsed.isValid : true,
      suggestion: typeof parsed?.suggestion === 'string' ? parsed.suggestion : null,
      serviceError: false,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      isValid: true,
      serviceError: true,
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
