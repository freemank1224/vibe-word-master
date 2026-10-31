import { splitChineseMeanings } from './chineseMeaning.ts';

export const BACKFILL_WORD_MAX_LENGTH = 32;
export const BACKFILL_MIN_INTERVAL_SECONDS = 300;
export const BACKFILL_MAX_COOLDOWN_SECONDS = 2147483647;
export const BACKFILL_UNKNOWN_RETRY_SECONDS = 86400;

export class BackfillRateLimitError extends Error {
  readonly cooldownSeconds: number;
  constructor(cooldownSeconds: number) {
    super('Translation provider rate limit reached');
    this.name = 'BackfillRateLimitError';
    this.cooldownSeconds = cooldownSeconds;
  }
}

export function retryAfterSeconds(value: string | null, now = Date.now()): number {
  if (!value?.trim()) return BACKFILL_UNKNOWN_RETRY_SECONDS;
  const text = value.trim();
  const seconds = /^\d+$/.test(text) ? Number(text) : Math.ceil((Date.parse(text) - now) / 1000);
  if (seconds === Infinity) return Infinity;
  if (!Number.isFinite(seconds)) return BACKFILL_UNKNOWN_RETRY_SECONDS;
  if (seconds > BACKFILL_MAX_COOLDOWN_SECONDS) return Infinity;
  return Math.max(0, Math.ceil(seconds));
}

export function failureDelaySeconds(attempts: number, retryAfter = 0): number {
  const exponent = Math.min(Math.max(Math.trunc(attempts) - 1, 0), 6);
  return Math.min(BACKFILL_MAX_COOLDOWN_SECONDS, Math.max(600 * 2 ** exponent, retryAfter));
}

/** One provider and one HTTP request per admitted job; fallback happens on a later attempt. */
export async function translateBackfillWord(
  text: string,
  lexemeId: string,
  attempts: number,
  uapisEndpoint: string,
  uapisApiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ provider: string; meanings: string[] }> {
  const query = text.trim();
  if (!query || Array.from(query).length > BACKFILL_WORD_MAX_LENGTH) {
    throw new Error('Word is empty or too long for automatic backfill');
  }
  // MyMemory is deliberately excluded: its public 5,000-character daily
  // budget is shared with other callers and cannot be safely reserved here.
  // UUIDs are stable and their final hexadecimal digit distributes the first
  // attempts across both providers; a failed attempt flips the next provider.
  // The database rolls back the attempt number for a 429/503, so a rate-limited
  // job keeps the same provider after the global cooldown expires.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lexemeId)) {
    throw new Error('Invalid lexeme ID for automatic backfill');
  }
  const firstAttemptUsesUapis = (parseInt(lexemeId.slice(-1), 16) & 1) === 1;
  const useUapis = attempts % 2 === 1 ? firstAttemptUsesUapis : !firstAttemptUsesUapis;
  const endpoint = useUapis
    ? new URL(uapisEndpoint)
    : new URL('https://translate.googleapis.com/translate_a/single');
  if (useUapis) endpoint.searchParams.set('to_lang', 'zh');
  else {
    endpoint.searchParams.set('client', 'gtx');
    endpoint.searchParams.set('sl', 'en');
    endpoint.searchParams.set('tl', 'zh-CN');
    endpoint.searchParams.set('dt', 't');
    endpoint.searchParams.set('q', query);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(endpoint.toString(), useUapis ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(uapisApiKey ? {
        Authorization: `Bearer ${uapisApiKey}`, 'x-api-key': uapisApiKey,
      } : {}) },
      body: JSON.stringify({ text: query }),
      signal: controller.signal,
    } : { signal: controller.signal });
    if (response.status === 429 || response.status === 503) {
      throw new BackfillRateLimitError(Math.max(3600, retryAfterSeconds(response.headers.get('Retry-After'))));
    }
    if (!response.ok) throw new Error(`Translation provider returned HTTP ${response.status}`);
    const provider = useUapis ? 'uapis' : 'google-translate';
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new Error(`Translation response invalid JSON (provider=${provider}, status=${response.status})`); }
    const root = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data === 'object' ? 'object' : 'other';
    const uapisObject = root === 'object' ? data as Record<string, unknown> : undefined;
    const fieldPresent = useUapis
      ? !!uapisObject && Object.prototype.hasOwnProperty.call(uapisObject, 'translated_text')
      : Array.isArray(data) && Array.isArray(data[0]);
    const raw = useUapis ? uapisObject?.translated_text : fieldPresent && Array.isArray(data)
      ? data[0].map((segment: unknown) => Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : '').join('')
      : undefined;
    const fieldType = !fieldPresent ? 'missing' : raw === null ? 'null' : typeof raw === 'string' ? 'string' : 'other';
    const translated = typeof raw === 'string' ? raw : '';
    const meanings = splitChineseMeanings(translated);
    if (!meanings.length) {
      // Never include provider text, request text, arbitrary JSON keys or secrets.
      // These fixed enums and booleans are stored as the job error for diagnosis.
      throw new Error(`Translation response unusable (provider=${provider}, status=${response.status}, root=${root}, field=${fieldType}, empty=${!translated.trim()}, han=${/\p{Script=Han}/u.test(translated)})`);
    }
    return { provider, meanings };
  } finally {
    clearTimeout(timer);
  }
}
