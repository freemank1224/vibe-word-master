import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const backfillSecret = Deno.env.get('LEXEME_BACKFILL_SECRET') || '';
const uapisTranslateEndpoint = Deno.env.get('UAPIS_TRANSLATE_ENDPOINT') || 'https://uapis.cn/api/v1/translate/text';
const uapisApiKey = Deno.env.get('UAPIS_API_KEY') || '';

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const normalizeMeaning = (value?: string | null): string | undefined => {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized ? normalized : undefined;
};

const splitMeaningCandidates = (value?: string | null): string[] => {
  const normalized = normalizeMeaning(value);
  if (!normalized) return [];

  const rawParts = normalized
    .split(/[;/；、，]/g)
    .map(part => normalizeMeaning(part))
    .filter((part): part is string => !!part);

  const parts = rawParts.length > 0 ? rawParts : [normalized];
  const unique = new Set<string>();

  for (const part of parts) {
    unique.add(part);
    if (unique.size >= 5) break;
  }

  return Array.from(unique);
};

const fetchWithTimeout = async (input: string, timeoutMs: number, init?: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...(init || {}), signal: controller.signal });
  } finally {
    clearTimeout(timeoutHandle);
  }
};

const fetchUapisTranslation = async (text: string) => {
  const response = await fetchWithTimeout(`${uapisTranslateEndpoint}?to_lang=zh`, 2500, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(uapisApiKey ? {
        Authorization: `Bearer ${uapisApiKey}`,
        'x-api-key': uapisApiKey,
      } : {}),
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(`UAPIs translate failed (${response.status}): ${details.slice(0, 300)}`);
  }

  const data = await response.json().catch(() => ({}));
  return splitMeaningCandidates(data?.translated_text);
};

const fetchChineseTranslation = async (text: string, fallbackText?: string) => {
  const query = text.trim();
  if (!query) {
    return { provider: 'none', meanings: [] as string[] };
  }

  const googleTargets = [query, fallbackText].filter((item): item is string => !!item?.trim());

  for (const target of googleTargets) {
    try {
      const meanings = await fetchUapisTranslation(target);
      if (meanings.length > 0) {
        return { provider: 'uapis', meanings };
      }
    } catch (error) {
      console.warn('UAPIs translation failed:', error);
    }
  }

  for (const target of googleTargets) {
    try {
      const response = await fetch(
        `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(target)}`
      );

      if (response.ok) {
        const data = await response.json();
        const translated = Array.isArray(data?.[0])
          ? data[0].map((segment: any) => segment?.[0]).filter(Boolean).join('')
          : undefined;
        const meanings = splitMeaningCandidates(translated);
        if (meanings.length > 0) {
          return { provider: 'google-translate', meanings };
        }
      }
    } catch (error) {
      console.warn('Google translation failed:', error);
    }
  }

  try {
    const response = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(query)}&langpair=en|zh-CN`
    );

    if (response.ok) {
      const data = await response.json();
      const meanings = splitMeaningCandidates(data?.responseData?.translatedText);
      if (meanings.length > 0) {
        return { provider: 'mymemory', meanings };
      }
    }
  } catch (error) {
    console.warn('MyMemory translation failed:', error);
  }

  return { provider: 'none', meanings: [] as string[] };
};

type ClaimedJob = {
  job_id: string;
  lexeme_id: string;
  normalized_text: string;
  display_text: string;
  language: string;
  phonetic?: string | null;
  definition_en?: string | null;
  attempts: number;
  max_attempts: number;
};

const claimJobs = async (batchSize: number): Promise<ClaimedJob[]> => {
  const { data, error } = await supabase.rpc('claim_lexeme_meaning_backfill_jobs', { p_limit: batchSize });
  if (error) {
    throw new Error(`Claim jobs failed: ${error.message}`);
  }
  return (data || []) as ClaimedJob[];
};

const completeJob = async (jobId: string, success: boolean, errorMessage?: string, retryDelaySeconds = 300) => {
  const { error } = await supabase.rpc('complete_lexeme_meaning_backfill_job', {
    p_job_id: jobId,
    p_success: success,
    p_error: errorMessage || null,
    p_retry_delay_seconds: retryDelaySeconds,
  });

  if (error) {
    throw new Error(`Complete job failed: ${error.message}`);
  }
};

const upsertMeanings = async (lexemeId: string, meanings: string[], provider: string) => {
  const payload = meanings.map((meaning, index) => ({
    lexeme_id: lexemeId,
    meaning_zh: meaning,
    source_type: 'machine',
    source_provider: provider,
    confidence: index === 0 ? 0.78 : 0.68,
    is_verified: false,
  }));

  const { error } = await supabase
    .from('lexeme_meanings')
    .upsert(payload, { onConflict: 'lexeme_id,meaning_zh' });

  if (error) {
    throw new Error(`Upsert meanings failed: ${error.message}`);
  }
};

const propagateMeaningToWords = async (lexemeId: string, meaning: string) => {
  const { error: nullError } = await supabase
    .from('words')
    .update({ definition_cn: meaning })
    .eq('lexeme_id', lexemeId)
    .is('definition_cn', null);

  if (nullError) {
    throw new Error(`Propagate null meaning failed: ${nullError.message}`);
  }

  const { error: emptyError } = await supabase
    .from('words')
    .update({ definition_cn: meaning })
    .eq('lexeme_id', lexemeId)
    .eq('definition_cn', '');

  if (emptyError) {
    throw new Error(`Propagate empty meaning failed: ${emptyError.message}`);
  }
};

const getJobCounts = async () => {
  const { data, error } = await supabase
    .from('lexeme_meaning_backfill_jobs')
    .select('status');

  if (error) {
    throw new Error(`Load job counts failed: ${error.message}`);
  }

  return (data || []).reduce((acc: Record<string, number>, row: { status: string }) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});
};

const processJobs = async (batchSize: number) => {
  const claimedJobs = await claimJobs(batchSize);
  const summary = {
    claimed: claimedJobs.length,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    processedLexemes: [] as string[],
  };

  for (const job of claimedJobs) {
    try {
      const { data: existingMeanings, error: existingError } = await supabase
        .from('lexeme_meanings')
        .select('meaning_zh')
        .eq('lexeme_id', job.lexeme_id)
        .limit(1);

      if (existingError) {
        throw new Error(`Check existing meanings failed: ${existingError.message}`);
      }

      if ((existingMeanings || []).length > 0) {
        await completeJob(job.job_id, true, null, 300);
        summary.skipped += 1;
        continue;
      }

      const translation = await fetchChineseTranslation(job.display_text || job.normalized_text, job.definition_en || undefined);
      if (translation.meanings.length === 0) {
        throw new Error('No translation result returned from all providers');
      }

      const meanings = translation.meanings;
      const provider = translation.provider;

      await upsertMeanings(job.lexeme_id, meanings, provider);
      await propagateMeaningToWords(job.lexeme_id, meanings[0]);
      await completeJob(job.job_id, true, null, 300);

      summary.succeeded += 1;
      summary.processedLexemes.push(job.display_text || job.normalized_text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await completeJob(job.job_id, false, message, 120);
      summary.failed += 1;
    }
  }

  return summary;
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

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'Missing Supabase service credentials' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (backfillSecret) {
    const requestSecret = req.headers.get('x-admin-secret') || '';
    if (requestSecret !== backfillSecret) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'run_once';
    const batchSize = Math.min(Math.max(Number(body.batchSize || 25), 1), 100);
    const maxBatches = Math.min(Math.max(Number(body.maxBatches || 1), 1), 50);
    const enqueueLimit = Math.min(Math.max(Number(body.enqueueLimit || 1000), 1), 5000);
    const force = body.force === true;

    if (action === 'status') {
      const counts = await getJobCounts();
      return new Response(JSON.stringify({ success: true, counts }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let enqueued = 0;
    if (action === 'enqueue_missing' || action === 'run_once') {
      const { data, error } = await supabase.rpc('enqueue_missing_lexeme_backfills', {
        p_limit: enqueueLimit,
        p_force: force,
      });

      if (error) {
        throw new Error(`Enqueue missing lexemes failed: ${error.message}`);
      }

      enqueued = Number(data || 0);

      if (action === 'enqueue_missing') {
        const counts = await getJobCounts();
        return new Response(JSON.stringify({ success: true, enqueued, counts }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    const runs = [] as Array<Record<string, unknown>>;
    let totalSucceeded = 0;
    let totalFailed = 0;
    let totalClaimed = 0;

    for (let index = 0; index < maxBatches; index += 1) {
      const result = await processJobs(batchSize);
      runs.push(result);
      totalSucceeded += result.succeeded;
      totalFailed += result.failed;
      totalClaimed += result.claimed;

      if (result.claimed === 0) {
        break;
      }
    }

    const counts = await getJobCounts();

    return new Response(JSON.stringify({
      success: true,
      action,
      enqueued,
      totalClaimed,
      totalSucceeded,
      totalFailed,
      counts,
      runs,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('lexeme-meaning-backfill error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
