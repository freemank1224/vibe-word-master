// @ts-nocheck
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const OLD_BUCKET = 'vocab-images';
const NEW_BUCKET = 'word-images';

const normalizeWord = (text: string): string =>
  text.toLowerCase().trim().replace(/\s+/g, ' ');

const getSupabaseClient = () =>
  createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

// -------------------------------------------------------
// action: analyze
// -------------------------------------------------------
const handleAnalyze = async () => {
  const sb = getSupabaseClient();

  // Find all (normalized_word, language) groups with their image_paths
  const { data, error } = await sb
    .from('words')
    .select('text, language, image_path')
    .is('deleted', false) // may need null check too
    .not('image_path', 'is', null)
    .neq('image_path', '');

  if (error) {
    return { ok: false, error: error.message };
  }

  // Group by normalized_word + language
  const groups: Record<string, {
    normalizedWord: string;
    displayWord: string;
    language: string;
    imagePaths: string[];
  }> = {};

  for (const row of data || []) {
    const nw = normalizeWord(row.text);
    const lang = (row.language || 'en').trim() || 'en';
    const key = `${nw}::${lang}`;

    if (!groups[key]) {
      groups[key] = {
        normalizedWord: nw,
        displayWord: row.text.trim(),
        language: lang,
        imagePaths: [],
      };
    }
    const path = (row.image_path || '').trim();
    if (path && !groups[key].imagePaths.includes(path)) {
      groups[key].imagePaths.push(path);
    }
  }

  const allGroups = Object.values(groups);
  const autoMigrate = allGroups.filter((g) => g.imagePaths.length === 1);
  const needsReview = allGroups.filter((g) => g.imagePaths.length > 1);

  return {
    ok: true,
    totalGroups: allGroups.length,
    autoMigrateCount: autoMigrate.length,
    needsReviewCount: needsReview.length,
    needsReview: needsReview.map((g) => ({
      normalizedWord: g.normalizedWord,
      displayWord: g.displayWord,
      language: g.language,
      imageCount: g.imagePaths.length,
      imagePaths: g.imagePaths,
    })),
  };
};

// -------------------------------------------------------
// action: auto-migrate
// Migrate words that have exactly 1 distinct image (no duplicates).
// -------------------------------------------------------
const handleAutoMigrate = async (limit: number = 50, offset: number = 0) => {
  const sb = getSupabaseClient();

  // Get distinct (normalized_word, language) with exactly 1 image_path
  const { data: words, error: wErr } = await sb
    .from('words')
    .select('id, text, language, image_path')
    .or('deleted.is.false,deleted.is.null')
    .not('image_path', 'is', null)
    .neq('image_path', '');

  if (wErr) return { ok: false, error: wErr.message };

  // Group by normalized_word + language
  const groups: Record<string, {
    normalizedWord: string;
    displayWord: string;
    language: string;
    imagePaths: string[];
    wordIds: string[];
  }> = {};

  for (const row of words || []) {
    const nw = normalizeWord(row.text);
    const lang = (row.language || 'en').trim() || 'en';
    const key = `${nw}::${lang}`;

    if (!groups[key]) {
      groups[key] = {
        normalizedWord: nw,
        displayWord: row.text.trim(),
        language: lang,
        imagePaths: [],
        wordIds: [],
      };
    }
    groups[key].wordIds.push(row.id);
    const path = (row.image_path || '').trim();
    if (path && !groups[key].imagePaths.includes(path)) {
      groups[key].imagePaths.push(path);
    }
  }

  // Filter to only single-image groups that don't already have an image_asset
  const candidates = Object.values(groups).filter((g) => g.imagePaths.length === 1);
  const batch = candidates.slice(offset, offset + limit);

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const group of batch) {
    try {
      // Check if image_asset already exists
      const { data: existing } = await sb
        .from('image_assets')
        .select('id')
        .eq('normalized_word', group.normalizedWord)
        .eq('language', group.language)
        .eq('status', 'ready')
        .maybeSingle();

      if (existing) {
        // Asset already exists, just link words if needed
        await sb
          .from('words')
          .update({ image_asset_id: existing.id })
          .in('id', group.wordIds)
          .is('image_asset_id', null);
        skipped++;
        continue;
      }

      const oldPath = group.imagePaths[0];

      // Download old image from vocab-images bucket
      const { data: fileData, error: dlErr } = await sb.storage
        .from(OLD_BUCKET)
        .download(oldPath);

      if (dlErr || !fileData) {
        console.error(`[image-migrate] Download failed for ${oldPath}: ${dlErr?.message}`);
        failed++;
        continue;
      }

      // Determine content type
      const contentType = fileData.type || 'image/webp';
      const ext = contentType.includes('png') ? 'png' : contentType.includes('jpeg') ? 'jpeg' : 'webp';

      // Upload to new bucket at deterministic path
      const newPath = `images/${group.language}/${encodeURIComponent(group.normalizedWord)}.${ext}`;

      const { error: ulErr } = await sb.storage
        .from(NEW_BUCKET)
        .upload(newPath, fileData, {
          contentType,
          cacheControl: '31536000',
          upsert: true,
        });

      if (ulErr) {
        console.error(`[image-migrate] Upload failed for ${newPath}: ${ulErr.message}`);
        failed++;
        continue;
      }

      // Get public URL
      const { data: urlData } = sb.storage.from(NEW_BUCKET).getPublicUrl(newPath);
      const publicUrl = urlData.publicUrl;

      // Get file size
      const fileSize = fileData.size || null;

      // Create image_asset record
      const { data: asset, error: iaErr } = await sb
        .from('image_assets')
        .insert({
          normalized_word: group.normalizedWord,
          display_word: group.displayWord,
          language: group.language,
          model: 'legacy-migrated',
          storage_bucket: NEW_BUCKET,
          storage_path: newPath,
          public_url: publicUrl,
          file_size_bytes: fileSize,
          status: 'ready',
        })
        .select('id')
        .single();

      if (iaErr) {
        // Unique constraint violation means another process already created it
        if (iaErr.code === '23505') {
          // Get the existing asset
          const { data: existingAsset } = await sb
            .from('image_assets')
            .select('id')
            .eq('normalized_word', group.normalizedWord)
            .eq('language', group.language)
            .eq('status', 'ready')
            .single();

          if (existingAsset) {
            await sb
              .from('words')
              .update({ image_asset_id: existingAsset.id })
              .in('id', group.wordIds)
              .is('image_asset_id', null);
            skipped++;
            continue;
          }
        }
        console.error(`[image-migrate] Insert image_assets failed: ${iaErr.message}`);
        failed++;
        continue;
      }

      // Link all matching words to the new asset
      await sb
        .from('words')
        .update({ image_asset_id: asset.id })
        .in('id', group.wordIds);

      processed++;
    } catch (err) {
      console.error(`[image-migrate] Error processing "${group.normalizedWord}": ${err}`);
      failed++;
    }
  }

  const hasMore = offset + limit < candidates.length;

  return {
    ok: true,
    processed,
    skipped,
    failed,
    totalCandidates: candidates.length,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  };
};

// -------------------------------------------------------
// action: duplicates-report
// Return list of words with multiple images for manual review.
// -------------------------------------------------------
const handleDuplicatesReport = async () => {
  const sb = getSupabaseClient();

  const { data: words, error } = await sb
    .from('words')
    .select('id, text, language, image_path, user_id')
    .or('deleted.is.false,deleted.is.null')
    .not('image_path', 'is', null)
    .neq('image_path', '');

  if (error) return { ok: false, error: error.message };

  // Group by normalized_word + language
  const groups: Record<string, {
    normalizedWord: string;
    displayWord: string;
    language: string;
    images: Record<string, { path: string; publicUrl: string; wordCount: number }>;
  }> = {};

  for (const row of words || []) {
    const nw = normalizeWord(row.text);
    const lang = (row.language || 'en').trim() || 'en';
    const key = `${nw}::${lang}`;

    if (!groups[key]) {
      groups[key] = {
        normalizedWord: nw,
        displayWord: row.text.trim(),
        language: lang,
        images: {},
      };
    }

    const path = (row.image_path || '').trim();
    if (!path) continue;

    if (!groups[key].images[path]) {
      const { data: urlData } = sb.storage.from(OLD_BUCKET).getPublicUrl(path);
      groups[key].images[path] = {
        path,
        publicUrl: urlData.publicUrl,
        wordCount: 0,
      };
    }
    groups[key].images[path].wordCount++;
  }

  // Filter to only groups with > 1 distinct image
  const duplicates = Object.values(groups)
    .filter((g) => Object.keys(g.images).length > 1)
    .map((g) => ({
      normalizedWord: g.normalizedWord,
      displayWord: g.displayWord,
      language: g.language,
      imageCount: Object.keys(g.images).length,
      images: Object.values(g.images),
    }));

  return { ok: true, duplicates };
};

// -------------------------------------------------------
// action: apply-selection
// Apply user's manual selection for duplicate images.
// -------------------------------------------------------
const handleApplySelection = async (
  selections: Array<{
    normalizedWord: string;
    language: string;
    selectedImagePath: string;
  }>
) => {
  const sb = getSupabaseClient();

  let processed = 0;
  let failed = 0;

  for (const sel of selections) {
    try {
      const nw = normalizeWord(sel.normalizedWord);
      const lang = (sel.language || 'en').trim() || 'en';

      // Check if asset already exists
      const { data: existing } = await sb
        .from('image_assets')
        .select('id')
        .eq('normalized_word', nw)
        .eq('language', lang)
        .eq('status', 'ready')
        .maybeSingle();

      if (existing) {
        // Already migrated, just ensure all words are linked
        const { data: matchingWords } = await sb
          .from('words')
          .select('id')
          .or('deleted.is.false,deleted.is.null')
          .ilike('text', sel.normalizedWord)
          .eq('language', lang)
          .is('image_asset_id', null);

        if (matchingWords && matchingWords.length > 0) {
          await sb
            .from('words')
            .update({ image_asset_id: existing.id })
            .in('id', matchingWords.map((w: any) => w.id));
        }
        processed++;
        continue;
      }

      // Download selected image
      const { data: fileData, error: dlErr } = await sb.storage
        .from(OLD_BUCKET)
        .download(sel.selectedImagePath);

      if (dlErr || !fileData) {
        console.error(`[image-migrate] Download failed: ${dlErr?.message}`);
        failed++;
        continue;
      }

      const contentType = fileData.type || 'image/webp';
      const ext = contentType.includes('png') ? 'png' : contentType.includes('jpeg') ? 'jpeg' : 'webp';
      const newPath = `images/${lang}/${encodeURIComponent(nw)}.${ext}`;

      // Upload to new bucket
      const { error: ulErr } = await sb.storage
        .from(NEW_BUCKET)
        .upload(newPath, fileData, {
          contentType,
          cacheControl: '31536000',
          upsert: true,
        });

      if (ulErr) {
        console.error(`[image-migrate] Upload failed: ${ulErr.message}`);
        failed++;
        continue;
      }

      const { data: urlData } = sb.storage.from(NEW_BUCKET).getPublicUrl(newPath);

      // Create image_asset
      const { data: asset, error: iaErr } = await sb
        .from('image_assets')
        .insert({
          normalized_word: nw,
          display_word: sel.normalizedWord.trim(),
          language: lang,
          model: 'legacy-migrated',
          storage_bucket: NEW_BUCKET,
          storage_path: newPath,
          public_url: urlData.publicUrl,
          file_size_bytes: fileData.size || null,
          status: 'ready',
        })
        .select('id')
        .single();

      if (iaErr) {
        console.error(`[image-migrate] Insert failed: ${iaErr.message}`);
        failed++;
        continue;
      }

      // Link all matching words
      const { data: matchingWords } = await sb
        .from('words')
        .select('id')
        .or('deleted.is.false,deleted.is.null')
        .ilike('text', sel.normalizedWord)
        .eq('language', lang);

      if (matchingWords && matchingWords.length > 0) {
        await sb
          .from('words')
          .update({ image_asset_id: asset.id })
          .in('id', matchingWords.map((w: any) => w.id));
      }

      processed++;
    } catch (err) {
      console.error(`[image-migrate] apply-selection error: ${err}`);
      failed++;
    }
  }

  return { ok: true, processed, failed };
};

// -------------------------------------------------------
// Main handler
// -------------------------------------------------------
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
    const action = body.action || 'analyze';

    let result;

    switch (action) {
      case 'analyze': {
        result = await handleAnalyze();
        break;
      }
      case 'auto-migrate': {
        const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 200);
        const offset = Math.max(Number(body.offset) || 0, 0);
        result = await handleAutoMigrate(limit, offset);
        break;
      }
      case 'duplicates-report': {
        result = await handleDuplicatesReport();
        break;
      }
      case 'apply-selection': {
        const selections = body.selections || [];
        if (!Array.isArray(selections) || selections.length === 0) {
          result = { ok: false, error: 'selections array is required' };
        } else {
          result = await handleApplySelection(selections);
        }
        break;
      }
      default:
        result = { ok: false, error: `Unknown action: ${action}` };
    }

    return new Response(JSON.stringify(result), {
      status: result.ok === false ? 400 : 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
