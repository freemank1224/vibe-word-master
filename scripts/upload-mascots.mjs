// ================================================================
// upload-mascots.mjs — one-time upload of 7 canonical monster images
// (M0..M6) into the Supabase Storage bucket `word-images/mascots/`.
//
// The scene-generate edge function fetches these at runtime to inject as
// a reference image alongside the LLM-authored structuredPrompt (replacing
// the [TODAYS_MASCOT] placeholder). Without this upload, the edge function
// silently falls back to text-only generation with the short description.
//
// Usage:
//   SUPABASE_URL=...                 \
//   SUPABASE_SERVICE_ROLE_KEY=...    \
//   node scripts/upload-mascots.mjs
//
// Re-runs are safe (upsert:true). Files are ~50-100KB each.
// ================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SCENE_MASCOT_BUCKET || 'word-images';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('✗ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
  console.error('  Example:');
  console.error('    SUPABASE_URL=https://xxx.supabase.co \\');
  console.error('    SUPABASE_SERVICE_ROLE_KEY=eyJ... \\');
  console.error('    node scripts/upload-mascots.mjs');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function main() {
  let okCount = 0;
  let failCount = 0;
  for (let i = 0; i < 7; i++) {
    const localPath = join(REPO_ROOT, 'public', 'monsterImages', `M${i}.webp`);
    const objectPath = `mascots/M${i}.webp`;
    let data;
    try {
      data = readFileSync(localPath);
    } catch (err) {
      console.error(`✗ M${i} (${DAY_NAMES[i]}): could not read ${localPath}: ${err.message}`);
      failCount += 1;
      continue;
    }
    const { error } = await sb.storage
      .from(BUCKET)
      .upload(objectPath, data, {
        contentType: 'image/webp',
        cacheControl: '31536000',
        upsert: true,
      });
    if (error) {
      console.error(`✗ M${i} (${DAY_NAMES[i]}): upload failed: ${error.message}`);
      failCount += 1;
      continue;
    }
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;
    console.log(`✓ M${i} (${DAY_NAMES[i]}): ${data.length} bytes → ${BUCKET}/${objectPath}`);
    console.log(`  public URL: ${publicUrl}`);
    okCount += 1;
  }
  console.log('');
  console.log(`Done: ${okCount}/7 uploaded, ${failCount} failed.`);
  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
