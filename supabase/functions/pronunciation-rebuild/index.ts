import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

type UniquenessMode = 'strict' | 'relaxed';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const superAdminEmail = (Deno.env.get('PRONUNCIATION_REBUILD_ADMIN_EMAIL') || 'dysonfreeman@outlook.com').toLowerCase();
const minimaxVoiceId = 'English_CalmWoman';
const minimaxModel = Deno.env.get('MINIMAX_TTS_MODEL') || 'speech-2.8-turbo';
const ttsFormat = Deno.env.get('MINIMAX_TTS_AUDIO_FORMAT') || 'mp3';
const ttsSampleRate = Number(Deno.env.get('MINIMAX_TTS_SAMPLE_RATE') || '16000');

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const normalizeWord = (text: string): string => text.toLowerCase().trim().replace(/\s+/g, ' ');

const updateRun = async (
  runId: string,
  fields: Record<string, unknown>
) => {
  await supabase
    .from('pronunciation_rebuild_runs')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('run_id', runId);
};

const isRunCancelled = async (runId: string): Promise<boolean> => {
  const { data } = await supabase
    .from('pronunciation_rebuild_runs')
    .select('status')
    .eq('run_id', runId)
    .maybeSingle();
  return data?.status === 'cancelled';
};

const purgeMinimaxAssets = async () => {
  const pageSize = 1000;
  let page = 0;
  let hasMore = true;
  const allAssets: Array<{ id: string; storage_bucket: string | null; storage_path: string | null }> = [];

  while (hasMore) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from('pronunciation_assets')
      .select('id,storage_bucket,storage_path')
      .eq('model_provider', 'minimax')
      .range(from, to);

    if (error) {
      throw new Error(`Failed loading minimax assets page ${page}: ${error.message}`);
    }

    if (!data || data.length === 0) {
      hasMore = false;
      break;
    }

    allAssets.push(...(data as any[]));
    hasMore = data.length === pageSize;
    page++;
  }

  if (allAssets.length === 0) {
    return { deletedAssets: 0, deletedStorageObjects: 0 };
  }

  const ids = allAssets.map(a => a.id);
  const storagePaths = allAssets
    .filter(a => (a.storage_bucket || 'word-audio') === 'word-audio' && !!a.storage_path)
    .map(a => a.storage_path as string);

  const BATCH = 500;

  for (let i = 0; i < ids.length; i += BATCH) {
    const idBatch = ids.slice(i, i + BATCH);
    await supabase
      .from('words')
      .update({ pronunciation_asset_id: null, audio_url: null })
      .in('pronunciation_asset_id', idBatch);

    await supabase
      .from('pronunciation_generation_jobs')
      .delete()
      .in('asset_id', idBatch);
  }

  let deletedStorageObjects = 0;
  for (let i = 0; i < storagePaths.length; i += BATCH) {
    const pathBatch = storagePaths.slice(i, i + BATCH);
    if (pathBatch.length === 0) continue;

    const { error } = await supabase.storage
      .from('word-audio')
      .remove(pathBatch);

    if (!error) {
      deletedStorageObjects += pathBatch.length;
    }
  }

  for (let i = 0; i < ids.length; i += BATCH) {
    const idBatch = ids.slice(i, i + BATCH);
    const { error } = await supabase
      .from('pronunciation_assets')
      .delete()
      .in('id', idBatch);

    if (error) {
      throw new Error(`Failed deleting minimax assets batch ${i / BATCH}: ${error.message}`);
    }
  }

  return { deletedAssets: ids.length, deletedStorageObjects };
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const payload = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const action = payload?.action;
  const bypassConfirm = payload?.confirm;
  const isBypassConfirmed = bypassConfirm === 'I_UNDERSTAND_DELETE_ALL_MINIMAX';

  try {
    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (action === 'purge_minimax' && isBypassConfirmed) {
      const purgeResult = await purgeMinimaxAssets();
      return new Response(JSON.stringify({
        ok: true,
        action: 'purge_minimax',
        deleted_assets: purgeResult.deletedAssets,
        deleted_storage_objects: purgeResult.deletedStorageObjects,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const allowBypassReplaceAll = action === 'replace_all' && isBypassConfirmed;
    let email = superAdminEmail;
    let requestedBy: string | null = null;

    if (!allowBypassReplaceAll) {
      const authHeader = req.headers.get('Authorization') || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

      if (!token) {
        return new Response(JSON.stringify({ ok: false, error: 'Missing bearer token' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const { data: tokenUser, error: tokenError } = await supabase.auth.getUser(token);
      if (tokenError || !tokenUser?.user?.email) {
        return new Response(JSON.stringify({ ok: false, error: 'Invalid token' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      email = tokenUser.user.email.toLowerCase();
      requestedBy = tokenUser.user.id;

      if (email !== superAdminEmail) {
        return new Response(JSON.stringify({ ok: false, error: `Permission denied for ${email}` }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    const uniquenessMode: UniquenessMode = payload?.uniqueness_mode === 'relaxed' ? 'relaxed' : 'strict';
    const concurrency = Math.max(1, Math.min(8, Number(payload?.concurrency || 3)));
    const maxRequestsPerMinute = Math.max(1, Math.min(120, Number(payload?.max_requests_per_minute || 20)));
    const runId = payload?.run_id || crypto.randomUUID();
    const forceRegenerate = payload?.force_regenerate === true;

    if (action === 'cancel') {
      await updateRun(runId, {
        status: 'cancelled',
        message: 'Cancelled by admin switch',
        finished_at: new Date().toISOString(),
      });

      return new Response(JSON.stringify({ ok: true, run_id: runId, cancelled: true }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (action === 'purge_minimax') {
      const purgeResult = await purgeMinimaxAssets();
      return new Response(JSON.stringify({
        ok: true,
        action: 'purge_minimax',
        deleted_assets: purgeResult.deletedAssets,
        deleted_storage_objects: purgeResult.deletedStorageObjects,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    await supabase.from('pronunciation_rebuild_runs').upsert({
      run_id: runId,
      requested_by: requestedBy,
      requested_email: email,
      status: 'running',
      uniqueness_mode: uniquenessMode,
      concurrency,
      max_requests_per_minute: maxRequestsPerMinute,
      total: 0,
      done: 0,
      generated: 0,
      skipped: 0,
      failed: 0,
      message: 'Initializing global scan...',
      finished_at: null,
    }, { onConflict: 'run_id' });

    const uniqueMap = new Map<string, { word: string; lang: string }>();

    let page = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const from = page * pageSize;
      const to = from + pageSize - 1;
      const { data, error } = await supabase
        .from('words')
        .select('text, language, deleted')
        .or('deleted.eq.false,deleted.is.null')
        .range(from, to);

      if (error) {
        throw new Error(`Failed loading words page ${page}: ${error.message}`);
      }

      if (!data || data.length === 0) {
        hasMore = false;
        break;
      }

      for (const row of data as any[]) {
        const text = (row.text || '').trim();
        if (!text) continue;
        const lang = (row.language || 'en').trim();
        const key = `${normalizeWord(text)}::${lang}`;
        if (!uniqueMap.has(key)) {
          uniqueMap.set(key, { word: text, lang });
        }
      }

      hasMore = data.length === pageSize;
      page++;
    }

    const items = Array.from(uniqueMap.values());
    const total = items.length;

    const projectRefMatch = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/);
    if (!projectRefMatch) {
      throw new Error('Invalid SUPABASE_URL');
    }
    const projectRef = projectRefMatch[1];

    let done = 0;
    let generated = 0;
    let skipped = 0;
    let failed = 0;

    const queue = [...items];
    const minIntervalMs = Math.ceil(60000 / maxRequestsPerMinute);
    let nextAllowedAt = 0;
    let limiterChain: Promise<void> = Promise.resolve();

    const waitForRateSlot = async () => {
      limiterChain = limiterChain.then(async () => {
        const now = Date.now();
        const waitMs = Math.max(0, nextAllowedAt - now);
        if (waitMs > 0) {
          await new Promise(resolve => setTimeout(resolve, waitMs));
        }
        nextAllowedAt = Date.now() + minIntervalMs;
      });
      await limiterChain;
    };

    await updateRun(runId, {
      total,
      message: `Loaded ${total} unique words. Starting generation...`
    });

    const worker = async () => {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) break;

        if (await isRunCancelled(runId)) {
          break;
        }

        try {
          const normalized = normalizeWord(next.word);
          let existsQuery = supabase
            .from('pronunciation_assets')
            .select('id')
            .eq('normalized_word', normalized)
            .eq('language', next.lang)
            .eq('status', 'ready')
            .eq('model_provider', 'minimax')
            .limit(1);

          if (uniquenessMode === 'relaxed') {
            existsQuery = existsQuery
              .eq('voice', minimaxVoiceId)
              .eq('model_name', minimaxModel)
              .eq('codec', ttsFormat)
              .eq('sample_rate_hz', ttsSampleRate);
          }

          const { data: exists } = await existsQuery.maybeSingle();
          if (!forceRegenerate && exists?.id) {
            skipped++;
          } else {
            await waitForRateSlot();
            const functionUrl = `https://${projectRef}.supabase.co/functions/v1/pronunciation?word=${encodeURIComponent(next.word)}&lang=${encodeURIComponent(next.lang)}&uniqueness_mode=${encodeURIComponent(uniquenessMode)}${forceRegenerate ? '&force=1' : ''}`;
            const resp = await fetch(functionUrl, { method: 'GET' });
            if (!resp.ok) {
              const err = await resp.text();
              throw new Error(`pronunciation ${resp.status}: ${err}`);
            }
            generated++;
          }
        } catch (error) {
          console.error('Rebuild item failed:', next?.word, error);
          failed++;
        } finally {
          done++;
          if (done % 10 === 0 || done === total) {
            await updateRun(runId, {
              done,
              generated,
              skipped,
              failed,
              message: `Progress ${done}/${total}`,
            });
          }
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (await isRunCancelled(runId)) {
      await updateRun(runId, {
        done,
        generated,
        skipped,
        failed,
        message: 'Cancelled by admin switch',
        finished_at: new Date().toISOString(),
      });

      return new Response(JSON.stringify({
        ok: true,
        run_id: runId,
        cancelled: true,
        total,
        done,
        generated,
        skipped,
        failed,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    await updateRun(runId, {
      status: 'completed',
      done,
      generated,
      skipped,
      failed,
      message: 'Completed',
      finished_at: new Date().toISOString(),
    });

    return new Response(JSON.stringify({
      ok: true,
      run_id: runId,
      admin: email,
      uniqueness_mode: uniquenessMode,
      total,
      done,
      generated,
      skipped,
      failed,
      concurrency,
      max_requests_per_minute: maxRequestsPerMinute,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    const runId = payload?.run_id;
    if (runId) {
      await updateRun(runId, {
        status: 'failed',
        message: (error as Error).message || 'unknown error',
        finished_at: new Date().toISOString(),
      });
    }
    return new Response(JSON.stringify({ ok: false, error: (error as Error).message || 'unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
