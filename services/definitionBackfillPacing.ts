/** The historical personal-word backfill is optional background work. */
export const DEFINITION_BACKFILL_INTERVAL_MS = 60_000;
export const DEFINITION_BACKFILL_RETRY_MS = 60 * 60_000;
const MIN_RATE_LIMIT_PAUSE_MS = 24 * 60 * 60_000;
const NEXT_KEY = 'vibe_definition_backfill_next_v1';
const RATE_PREFIX = 'vibe_supabase_rate_pause_v1:';
const LOCK_NAME = 'vibe_definition_backfill_v1';
const tabKey = `${RATE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`;
let localPauseUntil = 0;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
type LockLike = Pick<LockManager, 'request'>;

export function retryAfterDeadline(value: string | null, now: number): number {
  if (!value?.trim()) return now + MIN_RATE_LIMIT_PAUSE_MS;
  const text = value.trim();
  const seconds = /^\d+$/.test(text) ? Number(text) : (Date.parse(text) - now) / 1000;
  if (seconds === Infinity) return Infinity;
  if (!Number.isFinite(seconds)) return now + MIN_RATE_LIMIT_PAUSE_MS;
  const delay = Math.max(MIN_RATE_LIMIT_PAUSE_MS, seconds * 1000);
  return Number.isSafeInteger(Math.ceil(now + delay)) ? Math.ceil(now + delay) : Infinity;
}

/** Called by the Supabase transport; no request data or credentials are stored. */
export function recordSupabaseRateLimit(retryAfter: string | null, storage?: StorageLike, now = Date.now()): void {
  const deadline = retryAfterDeadline(retryAfter, now);
  localPauseUntil = Math.max(localPauseUntil, deadline);
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    if (target) target.setItem(tabKey, String(localPauseUntil));
  } catch {
    // Fail closed for this tab if the shared cooldown cannot be persisted.
    localPauseUntil = Infinity;
  }
}

export function sharedRateLimitDeadline(storage: StorageLike, now = Date.now()): number {
  let deadline = localPauseUntil;
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index);
    if (!key?.startsWith(RATE_PREFIX)) continue;
    const value = Number(storage.getItem(key));
    if (Number.isNaN(value)) return Infinity;
    if (value > now) deadline = Math.max(deadline, value);
    else storage.removeItem(key);
  }
  return deadline;
}

export function isSupabaseRateLimited(now = Date.now()): boolean {
  try {
    if (typeof localStorage === 'undefined') return localPauseUntil > now;
    return sharedRateLimitDeadline(localStorage, now) > now;
  } catch { return true; }
}

/** Observe Supabase responses without delaying or modifying foreground calls. */
export function observeSupabaseRateLimits(
  fetcher: typeof fetch,
  report: (retryAfter: string | null) => void = recordSupabaseRateLimit,
): typeof fetch {
  return async (input, init) => {
    const response = await fetcher(input, init);
    if (response.status === 429) report(response.headers.get('Retry-After'));
    return response;
  };
}

export type DefinitionPermit<T> =
  | { kind: 'done'; value: T }
  | { kind: 'wait'; ms: number }
  | { kind: 'cancelled' }
  | { kind: 'unavailable' };

export class DefinitionBackfillTaskError extends Error {
  constructor(cause: unknown) { super('Historical meaning backfill failed', { cause }); this.name = 'DefinitionBackfillTaskError'; }
}

/** One optional background task per minute across tabs, with a shared 429 pause. */
export async function withDefinitionBackfillPermit<T>(
  storage: StorageLike | undefined,
  locks: LockLike | undefined,
  isCurrent: () => boolean,
  task: () => Promise<T>,
  now: () => number = Date.now,
): Promise<DefinitionPermit<T>> {
  if (!storage || !locks) return { kind: 'unavailable' };
  try {
    return await locks.request(LOCK_NAME, { ifAvailable: true }, async lock => {
      if (!lock) return { kind: 'wait', ms: 5_000 } as const;
      if (!isCurrent()) return { kind: 'cancelled' } as const;
      const currentTime = now();
      const pauseUntil = sharedRateLimitDeadline(storage, currentTime);
      const storedNext = storage.getItem(NEXT_KEY);
      const next = storedNext === null ? 0 : Number(storedNext);
      if (Number.isNaN(next)) return { kind: 'unavailable' } as const;
      const availableAt = Math.max(next, pauseUntil);
      if (!Number.isFinite(availableAt)) return { kind: 'unavailable' } as const;
      if (availableAt > currentTime) return { kind: 'wait', ms: availableAt - currentTime } as const;
      storage.setItem(NEXT_KEY, String(currentTime + DEFINITION_BACKFILL_INTERVAL_MS));
      if (!isCurrent()) return { kind: 'cancelled' } as const;
      try { return { kind: 'done', value: await task() } as const; }
      catch (error) { throw new DefinitionBackfillTaskError(error); }
    });
  } catch (error) {
    // Storage/lock failures must not cause an unthrottled fallback. Task errors
    // are returned separately so the queue can retry them later.
    if (error instanceof Error && error.name === 'DefinitionBackfillTaskError') throw error;
    return { kind: 'unavailable' };
  }
}
