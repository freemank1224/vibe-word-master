import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { normalizeChineseMeaning } from '../_shared/chineseMeaning.ts';
import { isLexemeBackfillAuthorized } from '../_shared/lexemeBackfillAuth.ts';
import { BACKFILL_MAX_COOLDOWN_SECONDS, BackfillRateLimitError, failureDelaySeconds, retryAfterSeconds, translateBackfillWord } from '../_shared/lexemeBackfillPolicy.ts';
import { addMachineMeanings } from '../_shared/lexemeBackfillStore.ts';

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

// PostgREST's client response does not expose response headers. Capture the
// retry deadline at fetch level so database 429s do not lose Retry-After.
let observedDatabaseCooldownUntil = 0;
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: async (input, init) => {
    const response = await fetch(input, init);
    if (response.status === 429 || response.status === 503) {
      const seconds = Math.max(3600, retryAfterSeconds(response.headers.get('Retry-After')));
      observedDatabaseCooldownUntil = Math.max(observedDatabaseCooldownUntil, Date.now() + seconds * 1000);
    }
    return response;
  } },
});

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

const assertDatabaseSuccess = (error: { message?: string } | null, status: number, operation: string) => {
  if (status === 429 || (error && observedDatabaseCooldownUntil > Date.now())) {
    throw new BackfillRateLimitError(Math.max(3600, Math.ceil((observedDatabaseCooldownUntil - Date.now()) / 1000)));
  }
  if (error) throw new Error(`${operation}: ${error.message || 'Database request failed'}`);
};

const claimJobs = async (token: string): Promise<ClaimedJob[]> => {
  const { data, error, status } = await supabase.rpc('claim_lexeme_backfill_with_slot', { p_token: token });
  assertDatabaseSuccess(error, status, 'Claim jobs failed');
  return (data || []) as ClaimedJob[];
};

const completeJob = async (jobId: string, attempts: number, success: boolean, errorMessage?: string, retryDelaySeconds = 300) => {
  const { error, status } = await supabase.rpc('finish_claimed_lexeme_backfill', {
    p_job_id: jobId,
    p_expected_attempt: attempts,
    p_success: success,
    p_error: errorMessage || null,
    p_retry_delay_seconds: retryDelaySeconds,
  });

  assertDatabaseSuccess(error, status, 'Complete job failed');
};

const deferRateLimitedJob = async (jobId: string, attempts: number, delaySeconds: number) => {
  const { error, status } = await supabase.rpc('defer_rate_limited_lexeme_backfill', {
    p_job_id: jobId, p_expected_attempt: attempts, p_retry_delay_seconds: delaySeconds,
  });
  assertDatabaseSuccess(error, status, 'Defer rate-limited job failed');
};

class PreserveBackfillLeaseError extends Error {
  constructor() { super('Unable to safely persist a rate-limit retry'); this.name = 'PreserveBackfillLeaseError'; }
}

const upsertMeanings = async (lexemeId: string, meanings: string[], provider: string) => {
  const { error, status } = await addMachineMeanings(supabase, lexemeId, meanings, provider);

  assertDatabaseSuccess(error, status, 'Upsert meanings failed');
};

const getJobCounts = async () => {
  const { data, error, status } = await supabase
    .from('lexeme_meaning_backfill_jobs')
    .select('status');

  assertDatabaseSuccess(error, status, 'Load job counts failed');

  return (data || []).reduce((acc: Record<string, number>, row: { status: string }) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});
};

const processJobs = async (token: string) => {
  const claimedJobs = await claimJobs(token);
  const summary = {
    claimed: claimedJobs.length,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    processedLexemes: [] as string[],
  };

  for (const job of claimedJobs) {
    try {
      const { data: existingMeanings, error: existingError, status } = await supabase
        .from('lexeme_meanings')
        .select('meaning_zh')
        .eq('lexeme_id', job.lexeme_id)
        .limit(50);

      assertDatabaseSuccess(existingError, status, 'Check existing meanings failed');

      if ((existingMeanings || []).some((item: { meaning_zh: string }) => normalizeChineseMeaning(item.meaning_zh))) {
        await completeJob(job.job_id, job.attempts, true, undefined, 300);
        summary.skipped += 1;
        continue;
      }

      const translation = await translateBackfillWord(job.display_text || job.normalized_text, job.lexeme_id, job.attempts, uapisTranslateEndpoint, uapisApiKey);
      if (translation.meanings.length === 0) {
        throw new Error('No Chinese translation returned by provider');
      }

      const meanings = translation.meanings;
      const provider = translation.provider;

      // A learner may have supplied a meaning while the provider was running.
      // A second read avoids needless machine options; ignoreDuplicates below
      // also prevents replacing user metadata if the same meaning races in.
      const { data: afterTranslation, error: recheckError, status: recheckStatus } = await supabase
        .from('lexeme_meanings').select('meaning_zh').eq('lexeme_id', job.lexeme_id).limit(50);
      assertDatabaseSuccess(recheckError, recheckStatus, 'Recheck existing meanings failed');
      if ((afterTranslation || []).some((item: { meaning_zh: string }) => normalizeChineseMeaning(item.meaning_zh))) {
        await completeJob(job.job_id, job.attempts, true, undefined, 300);
        summary.skipped += 1;
        continue;
      }
      await upsertMeanings(job.lexeme_id, meanings, provider);
      await completeJob(job.job_id, job.attempts, true, undefined, 300);

      summary.succeeded += 1;
      summary.processedLexemes.push(job.display_text || job.normalized_text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A cooldown too large to store leaves the shared lease locked; the job
      // can be retried only after an operator inspects and resets that lease.
      const delay = error instanceof BackfillRateLimitError
        ? (Number.isFinite(error.cooldownSeconds) ? error.cooldownSeconds : 3600)
        : failureDelaySeconds(job.attempts);
      if (error instanceof BackfillRateLimitError) {
        try { await deferRateLimitedJob(job.job_id, job.attempts, delay); }
        catch { throw new PreserveBackfillLeaseError(); }
        throw error;
      }
      try { await completeJob(job.job_id, job.attempts, false, message, delay); }
      catch (completionError) {
        if (completionError instanceof BackfillRateLimitError) {
          const rateDelay = Number.isFinite(completionError.cooldownSeconds) ? completionError.cooldownSeconds : 3600;
          try { await deferRateLimitedJob(job.job_id, job.attempts, rateDelay); }
          catch { throw new PreserveBackfillLeaseError(); }
        }
        throw completionError;
      }
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

  if (!isLexemeBackfillAuthorized(backfillSecret, req.headers.get('x-admin-secret') || '')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let leaseToken: string | null = null;
  let cooldownSeconds = 0;
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'run_once';

    if (action === 'status') {
      const counts = await getJobCounts();
      return new Response(JSON.stringify({ success: true, counts }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (action !== 'run_once') {
      return new Response(JSON.stringify({ error: 'Unsupported action' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Shared database gate is authoritative across cron and all Edge instances.
    const { data: token, error: gateError, status: gateStatus } = await supabase.rpc('try_acquire_lexeme_backfill_slot');
    assertDatabaseSuccess(gateError, gateStatus, 'Acquire backfill slot failed');
    if (!token) {
      return new Response(JSON.stringify({ success: true, paced: true, totalClaimed: 0 }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    leaseToken = token;

    // Deliberately ignore request batch controls and do not scan/re-enqueue the
    // full vocabulary. The scheduler separately discovers missing lexemes.
    const result = await processJobs(leaseToken);
    return new Response(JSON.stringify({
      success: true, action, totalClaimed: result.claimed,
      totalSucceeded: result.succeeded, totalFailed: result.failed, runs: [result],
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    if (error instanceof BackfillRateLimitError) cooldownSeconds = error.cooldownSeconds;
    if (error instanceof PreserveBackfillLeaseError) cooldownSeconds = Infinity;
    console.error('lexeme-meaning-backfill error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: error instanceof BackfillRateLimitError ? 429 : 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', ...(error instanceof BackfillRateLimitError ? {
        'Retry-After': String(Number.isFinite(error.cooldownSeconds) ? error.cooldownSeconds : BACKFILL_MAX_COOLDOWN_SECONDS),
      } : {}) },
    });
  } finally {
    if (leaseToken && Number.isFinite(cooldownSeconds)) {
      const { error } = await supabase.rpc('release_lexeme_backfill_slot', {
        p_token: leaseToken, p_cooldown_seconds: cooldownSeconds,
      });
      // An unreleased lease fails closed. Do not silently allow
      // a new worker after a failure to persist the provider cooldown.
      if (error) console.error('Could not release backfill slot:', error.message);
    }
  }
});
