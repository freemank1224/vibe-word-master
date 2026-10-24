/** Recorded pronunciation sources shared by lessons and games. No player or TTS side effects. */
export interface PronunciationCandidateOptions {
  word: string;
  lang?: string;
  directUrl?: string | null;
  cachedUrl?: string | null;
  supabaseUrl?: string | null;
  uniquenessMode?: 'strict' | 'relaxed';
}

export function safePronunciationUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return /^(https?:)$/.test(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * An entry's saved recording wins over an older persistent cache. If neither is
 * available, the official endpoint resolves the shared pronunciation asset.
 * A missing audio_url on a personal word does not mean its recording is absent.
 */
export function buildPronunciationCandidates(options: PronunciationCandidateOptions): string[] {
  const word = options.word.toLowerCase().trim().replace(/\s+/g, ' ');
  if (!word) return [];

  const candidates: string[] = [];
  const add = (value?: string | null) => {
    const url = safePronunciationUrl(value);
    if (url && !candidates.includes(url)) candidates.push(url);
  };
  add(options.directUrl);
  add(options.cachedUrl);

  const base = safePronunciationUrl(options.supabaseUrl);
  if (base) {
    const url = new URL(base);
    // Build only the configured official project endpoint, never a demo asset.
    if (url.protocol === 'https:' && /^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname) && !url.port) {
      const lang = options.lang?.trim() || 'en';
      const mode = options.uniquenessMode === 'relaxed' ? 'relaxed' : 'strict';
      add(`${url.origin}/functions/v1/pronunciation?word=${encodeURIComponent(word)}&lang=${encodeURIComponent(lang)}&uniqueness_mode=${mode}`);
    }
  }

  return candidates;
}
