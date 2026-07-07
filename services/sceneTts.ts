// ================================================================
// sceneTts.ts — client helper for the scene-tts edge function.
//
// Fetches a single sentence's MP3 from the scene-tts edge function,
// which uses the same MiniMax TTS pipeline as `pronunciation` but with
// Supabase Storage as the cache (no DB writes). Returned bytes are
// wrapped in a Blob so callers can build blob: URLs for <audio>.
// ================================================================

// Static env-var access (vite.config.ts `define` replaces these at build time,
// mirroring services/sceneGame.ts and lib/supabaseClient.ts).
const SUPABASE_URL: string = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY: string = process.env.SUPABASE_ANON_KEY || '';

/**
 * Fetch the TTS audio for a single English sentence.
 *
 * Returns a Blob (audio/mpeg) on success. Throws on any non-2xx response —
 * callers should catch and degrade gracefully (e.g. hide the speaker icon).
 */
export const fetchSceneTts = async (sentence: string, signal?: AbortSignal): Promise<Blob> => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('scene-tts: Supabase env not configured');
  }
  const trimmed = String(sentence || '').trim();
  if (!trimmed) throw new Error('scene-tts: empty sentence');

  const url = `${SUPABASE_URL}/functions/v1/scene-tts?text=${encodeURIComponent(trimmed)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      apikey: SUPABASE_ANON_KEY,
    },
    signal,
  });
  if (!res.ok) {
    let detail = '';
    try {
      const errBody = await res.json();
      detail = errBody?.error ? `: ${errBody.error}` : '';
    } catch { /* not JSON */ }
    throw new Error(`scene-tts HTTP ${res.status}${detail}`);
  }
  return await res.blob();
};
