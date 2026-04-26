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

/**
 * Purge orphaned pronunciation assets for a given list of word texts.
 * An asset is "orphaned" if no non-deleted word row exists for that text across ALL users.
 * Used after a user deletes words from their library (Trigger 1).
 */
const purgeOrphanedAssetsForWords = async (
  wordTexts: string[]
): Promise<{ deletedAssets: number; deletedStorageObjects: number; orphanedWords: string[] }> => {
  if (!wordTexts || wordTexts.length === 0) {
    return { deletedAssets: 0, deletedStorageObjects: 0, orphanedWords: [] };
  }

  const normalizedInputs = wordTexts.map(normalizeWord);

  // Find assets for these normalized words
  const { data: assets, error: assetsError } = await supabase
    .from('pronunciation_assets')
    .select('id, normalized_word, language, storage_bucket, storage_path')
    .in('normalized_word', normalizedInputs);

  if (assetsError) throw new Error(`Failed loading assets: ${assetsError.message}`);
  if (!assets || assets.length === 0) {
    return { deletedAssets: 0, deletedStorageObjects: 0, orphanedWords: [] };
  }

  // Build set of unique (normalized_word, language) from assets
  const uniquePairs = [...new Map<string, { word: string; lang: string }>(
    assets.map(a => [`${a.normalized_word}::${a.language || 'en'}`, { word: a.normalized_word, lang: a.language || 'en' }])
  ).values()];

  // For each pair, check if ANY non-deleted word row exists across ALL users
  const orphanedKeys = new Set<string>();
  const BATCH = 100;

  for (let i = 0; i < uniquePairs.length; i += BATCH) {
    const batch = uniquePairs.slice(i, i + BATCH);
    const wordBatch = batch.map(p => p.word);

    // Fetch all active words matching these normalized texts
    // We compare lower(text) = normalized_word (already lowercase)
    const { data: activeRows } = await supabase
      .from('words')
      .select('text, language')
      .or('deleted.eq.false,deleted.is.null')
      .in('text', wordBatch.map(w => w)); // exact match on text; normalize in JS below

    const activeSet = new Set(
      (activeRows || []).map(r => `${normalizeWord(r.text)}::${(r.language || 'en')}`)
    );

    for (const pair of batch) {
      const key = `${pair.word}::${pair.lang}`;
      if (!activeSet.has(key)) {
        orphanedKeys.add(key);
      }
    }
  }

  const orphanedAssets = assets.filter(a => orphanedKeys.has(`${a.normalized_word}::${a.language || 'en'}`));
  if (orphanedAssets.length === 0) {
    return { deletedAssets: 0, deletedStorageObjects: 0, orphanedWords: [] };
  }

  return await _deleteAssets(orphanedAssets);
};

/**
 * Full-scan orphan cleanup: scan ALL pronunciation_assets and remove those
 * with no matching active word across any user. Admin-only.
 */
const purgeOrphanedAssetsFull = async (): Promise<{ deletedAssets: number; deletedStorageObjects: number; orphanedWords: string[] }> => {
  // Load all assets in pages
  const PAGE = 1000;
  let allAssets: Array<{ id: string; normalized_word: string; language: string | null; storage_bucket: string | null; storage_path: string | null }> = [];
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const from = page * PAGE;
    const { data, error } = await supabase
      .from('pronunciation_assets')
      .select('id, normalized_word, language, storage_bucket, storage_path')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Failed loading assets page ${page}: ${error.message}`);
    if (!data || data.length === 0) { hasMore = false; break; }
    allAssets.push(...(data as any[]));
    hasMore = data.length === PAGE;
    page++;
  }

  if (allAssets.length === 0) return { deletedAssets: 0, deletedStorageObjects: 0, orphanedWords: [] };

  // Get ALL active words across all users (normalized)
  const activeSet = new Set<string>();
  page = 0; hasMore = true;
  while (hasMore) {
    const from = page * PAGE;
    const { data, error } = await supabase
      .from('words')
      .select('text, language')
      .or('deleted.eq.false,deleted.is.null')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Failed loading words page ${page}: ${error.message}`);
    if (!data || data.length === 0) { hasMore = false; break; }
    for (const r of data as any[]) {
      activeSet.add(`${normalizeWord(r.text)}::${r.language || 'en'}`);
    }
    hasMore = data.length === PAGE;
    page++;
  }

  const orphanedAssets = allAssets.filter(
    a => !activeSet.has(`${a.normalized_word}::${a.language || 'en'}`)
  );

  if (orphanedAssets.length === 0) return { deletedAssets: 0, deletedStorageObjects: 0, orphanedWords: [] };

  return await _deleteAssets(orphanedAssets);
};

const drainStorageCleanupQueue = async (
  limit: number = 200
): Promise<{ processedJobs: number; deletedStorageObjects: number; failedJobs: number }> => {
  const batchSize = Math.max(1, Math.min(500, Number(limit) || 200));

  const { data: jobs, error: jobsError } = await supabase
    .from('pronunciation_asset_storage_cleanup_jobs')
    .select('id,storage_bucket,storage_path,attempt_count')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(batchSize);

  if (jobsError) {
    throw new Error(`Failed loading storage cleanup jobs: ${jobsError.message}`);
  }

  if (!jobs || jobs.length === 0) {
    return { processedJobs: 0, deletedStorageObjects: 0, failedJobs: 0 };
  }

  const jobIds = jobs.map((job: any) => job.id);
  const { error: markProcessingError } = await supabase
    .from('pronunciation_asset_storage_cleanup_jobs')
    .update({ status: 'processing', last_error: null })
    .in('id', jobIds);

  if (markProcessingError) {
    throw new Error(`Failed marking storage cleanup jobs as processing: ${markProcessingError.message}`);
  }

  const jobsByBucket = new Map<string, Array<{ id: string; storage_path: string; attempt_count: number }>>();
  for (const job of jobs as any[]) {
    const bucket = (job.storage_bucket || 'word-audio').trim() || 'word-audio';
    const storagePath = (job.storage_path || '').trim();
    if (!storagePath) continue;

    if (!jobsByBucket.has(bucket)) {
      jobsByBucket.set(bucket, []);
    }

    jobsByBucket.get(bucket)!.push({
      id: job.id,
      storage_path: storagePath,
      attempt_count: Number(job.attempt_count || 0),
    });
  }

  let deletedStorageObjects = 0;
  let failedJobs = 0;
  const successIds: string[] = [];

  for (const [bucket, bucketJobs] of jobsByBucket.entries()) {
    const storagePaths = bucketJobs.map(job => job.storage_path);
    const { error } = await supabase.storage.from(bucket).remove(storagePaths);

    if (error) {
      failedJobs += bucketJobs.length;

      for (const bucketJob of bucketJobs) {
        const nextAttemptCount = bucketJob.attempt_count + 1;
        const nextStatus = nextAttemptCount >= 5 ? 'failed' : 'pending';

        await supabase
          .from('pronunciation_asset_storage_cleanup_jobs')
          .update({
            status: nextStatus,
            attempt_count: nextAttemptCount,
            last_error: error.message,
          })
          .eq('id', bucketJob.id);
      }

      continue;
    }

    deletedStorageObjects += bucketJobs.length;
    successIds.push(...bucketJobs.map(job => job.id));
  }

  if (successIds.length > 0) {
    const { error: deleteJobsError } = await supabase
      .from('pronunciation_asset_storage_cleanup_jobs')
      .delete()
      .in('id', successIds);

    if (deleteJobsError) {
      throw new Error(`Failed deleting completed storage cleanup jobs: ${deleteJobsError.message}`);
    }
  }

  return {
    processedJobs: jobs.length,
    deletedStorageObjects,
    failedJobs,
  };
};

/**
 * Shared helper: delete storage files + DB records for a list of asset rows.
 */
const _deleteAssets = async (
  orphanedAssets: Array<{ id: string; normalized_word: string; language: string | null; storage_bucket: string | null; storage_path: string | null }>
): Promise<{ deletedAssets: number; deletedStorageObjects: number; orphanedWords: string[] }> => {
  const BATCH = 500;
  const ids = orphanedAssets.map(a => a.id);
  const storagePaths = orphanedAssets
    .filter(a => a.storage_path && (a.storage_bucket || 'word-audio') === 'word-audio')
    .map(a => a.storage_path as string);
  const orphanedWords = [...new Set(orphanedAssets.map(a => a.normalized_word))];

  // 1. Clear references in words table
  for (let i = 0; i < ids.length; i += BATCH) {
    const batchIds = ids.slice(i, i + BATCH);
    await supabase.from('words')
      .update({ pronunciation_asset_id: null, audio_url: null })
      .in('pronunciation_asset_id', batchIds);
    await supabase.from('pronunciation_generation_jobs')
      .delete()
      .in('asset_id', batchIds);
  }

  // 2. Delete storage files
  let deletedStorageObjects = 0;
  for (let i = 0; i < storagePaths.length; i += BATCH) {
    const { error } = await supabase.storage.from('word-audio').remove(storagePaths.slice(i, i + BATCH));
    if (!error) deletedStorageObjects += Math.min(BATCH, storagePaths.length - i);
  }

  // 3. Delete pronunciation_assets rows
  for (let i = 0; i < ids.length; i += BATCH) {
    await supabase.from('pronunciation_assets').delete().in('id', ids.slice(i, i + BATCH));
  }

  return { deletedAssets: ids.length, deletedStorageObjects, orphanedWords };
};

const processPronunciationGenerationJobs = async (
  limit: number,
  uniquenessMode: UniquenessMode,
): Promise<{ picked: number; triggered: number; failed: number }> => {
  const batchSize = Math.max(1, Math.min(100, Number(limit) || 20));
  const nowIso = new Date().toISOString();

  const { data: rows, error } = await supabase
    .from('pronunciation_generation_jobs')
    .select('id, asset_id, status, scheduled_at, pronunciation_assets!inner(normalized_word, language)')
    .in('status', ['pending', 'failed'])
    .lte('scheduled_at', nowIso)
    .order('priority', { ascending: false })
    .order('scheduled_at', { ascending: true })
    .limit(batchSize);

  if (error) {
    throw new Error(`Failed loading pronunciation generation jobs: ${error.message}`);
  }

  const jobs = (rows || []) as any[];
  if (jobs.length === 0) {
    return { picked: 0, triggered: 0, failed: 0 };
  }

  const projectRefMatch = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/);
  if (!projectRefMatch) {
    throw new Error('Invalid SUPABASE_URL');
  }

  const projectRef = projectRefMatch[1];
  let triggered = 0;
  let failed = 0;

  for (const job of jobs) {
    const asset = job.pronunciation_assets;
    const word = (asset?.normalized_word || '').trim();
    const lang = (asset?.language || 'en').trim();

    if (!word) {
      failed++;
      continue;
    }

    await supabase
      .from('pronunciation_generation_jobs')
      .update({ status: 'processing', started_at: new Date().toISOString(), last_error: null })
      .eq('id', job.id);

    const functionUrl = `https://${projectRef}.supabase.co/functions/v1/pronunciation?word=${encodeURIComponent(word)}&lang=${encodeURIComponent(lang)}&uniqueness_mode=${encodeURIComponent(uniquenessMode)}&force=1`;
    const resp = await fetch(functionUrl, { method: 'GET' });

    if (resp.ok) {
      triggered++;
    } else {
      failed++;
      const errText = await resp.text();
      await supabase
        .from('pronunciation_generation_jobs')
        .update({
          status: 'pending',
          last_error: `worker trigger failed: ${resp.status} ${errText}`.slice(0, 2000),
          scheduled_at: new Date(Date.now() + 30000).toISOString(),
        })
        .eq('id', job.id);
    }
  }

  return {
    picked: jobs.length,
    triggered,
    failed,
  };
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const payload = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const action = payload?.action;

  try {
    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    let email = '';
    let requestedBy = '';
    let tokenAuthenticated = false;

    if (token) {
      const { data: tokenUser, error: tokenError } = await supabase.auth.getUser(token);
      if (!tokenError && tokenUser?.user?.email) {
        email = tokenUser.user.email.toLowerCase();
        requestedBy = tokenUser.user.id;
        tokenAuthenticated = true;
      }
    }

    if (!tokenAuthenticated) {
      const fallbackEmailRaw = typeof payload?.requested_email === 'string' ? payload.requested_email : '';
      const fallbackRequestedByRaw = typeof payload?.requested_by === 'string' ? payload.requested_by : '';
      const fallbackEmail = fallbackEmailRaw.toLowerCase().trim();
      const fallbackRequestedBy = fallbackRequestedByRaw.trim();
      const uuidLike = /^[0-9a-fA-F-]{36}$/.test(fallbackRequestedBy);

      if (fallbackEmail === superAdminEmail && uuidLike) {
        email = fallbackEmail;
        requestedBy = fallbackRequestedBy;
      } else {
        return new Response(JSON.stringify({ ok: false, error: 'Invalid token and fallback admin verification failed' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // ── Any token-authenticated user can trigger targeted orphan cleanup ─────
    if (action === 'purge_orphaned_words') {
      if (!tokenAuthenticated) {
        return new Response(JSON.stringify({ ok: false, error: 'Token auth required for purge_orphaned_words' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const words = (payload?.words as string[] | undefined) || [];
      if (words.length === 0) {
        return new Response(JSON.stringify({ ok: false, error: '`words` array is required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      const result = await purgeOrphanedAssetsForWords(words);
      return new Response(JSON.stringify({
        ok: true,
        action: 'purge_orphaned_words',
        deleted_assets: result.deletedAssets,
        deleted_storage_objects: result.deletedStorageObjects,
        orphaned_words: result.orphanedWords,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (action === 'drain_storage_cleanup_queue') {
      if (!tokenAuthenticated && email !== superAdminEmail) {
        return new Response(JSON.stringify({ ok: false, error: 'Token auth required for drain_storage_cleanup_queue' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const result = await drainStorageCleanupQueue(Number(payload?.limit || 200));
      return new Response(JSON.stringify({
        ok: true,
        action: 'drain_storage_cleanup_queue',
        processed_jobs: result.processedJobs,
        deleted_storage_objects: result.deletedStorageObjects,
        failed_jobs: result.failedJobs,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (action === 'process_generation_jobs') {
      if (!tokenAuthenticated && email !== superAdminEmail) {
        return new Response(JSON.stringify({ ok: false, error: 'Token auth required for process_generation_jobs' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const mode: UniquenessMode = payload?.uniqueness_mode === 'relaxed' ? 'relaxed' : 'strict';
      const result = await processPronunciationGenerationJobs(Number(payload?.limit || 20), mode);
      return new Response(JSON.stringify({
        ok: true,
        action: 'process_generation_jobs',
        picked: result.picked,
        triggered: result.triggered,
        failed: result.failed,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (email !== superAdminEmail) {
      return new Response(JSON.stringify({ ok: false, error: `Permission denied for ${email}` }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
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

    if (action === 'purge_orphaned') {
      const result = await purgeOrphanedAssetsFull();
      return new Response(JSON.stringify({
        ok: true,
        action: 'purge_orphaned',
        deleted_assets: result.deletedAssets,
        deleted_storage_objects: result.deletedStorageObjects,
        orphaned_words: result.orphanedWords,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (action === 'status') {
      const targetRunId = (payload?.run_id || '').toString().trim();
      if (!targetRunId) {
        return new Response(JSON.stringify({ ok: false, error: 'run_id is required for status action' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const { data: runRow, error: runErr } = await supabase
        .from('pronunciation_rebuild_runs')
        .select('run_id,status,total,done,generated,skipped,failed,message,updated_at,finished_at,requested_email')
        .eq('run_id', targetRunId)
        .maybeSingle();

      if (runErr) {
        return new Response(JSON.stringify({ ok: false, error: runErr.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      if (!runRow) {
        return new Response(JSON.stringify({ ok: false, error: `run_id not found: ${targetRunId}` }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({ ok: true, run: runRow }), {
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
