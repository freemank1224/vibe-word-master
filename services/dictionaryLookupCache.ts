/** Run the entire operation (including response bodies) within a deadline. */
export async function withinDeadline<T>(
  load: (signal: AbortSignal) => PromiseLike<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let rejectAbort: (reason: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    controller.abort();
    rejectAbort(new DOMException('Dictionary request cancelled or timed out', 'AbortError'));
  };
  const timer = setTimeout(abort, timeoutMs);
  parentSignal?.addEventListener('abort', abort, { once: true });
  try {
    if (parentSignal?.aborted) abort();
    return await Promise.race([
      aborted,
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        return load(controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
  }
}

interface LookupCacheOptions<T> {
  timeoutMs?: number;
  ttlMs?: number;
  negativeTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
  isUsable?: (value: T) => boolean;
}

/** Public dictionary values only: never pass personal words or chosen meanings here. */
export function createDictionaryLookupCache<T>(options: LookupCacheOptions<T> = {}) {
  const { timeoutMs = 6500, ttlMs = 15 * 60_000, negativeTtlMs = 15_000, maxEntries = 128, now = Date.now, isUsable = () => true } = options;
  const values = new Map<string, { value: T | null; expiresAt: number }>();
  const requests = new Map<string, {
    controller: AbortController;
    promise: Promise<T | null>;
    consumers: number;
  }>();
  const clone = (value: T | null) => value === null ? null : structuredClone(value);

  return async (key: string, load: (signal: AbortSignal) => PromiseLike<T | null>, signal?: AbortSignal): Promise<T | null> => {
    if (signal?.aborted) return null;
    const cached = values.get(key);
    if (cached && cached.expiresAt > now()) {
      values.delete(key);
      values.set(key, cached);
      return clone(cached.value);
    }
    values.delete(key);
    let request = requests.get(key);
    if (!request || request.controller.signal.aborted) {
      const controller = new AbortController();
      const created = { controller, consumers: 0, promise: Promise.resolve<T | null>(null) };
      created.promise = withinDeadline(load, timeoutMs, controller.signal)
        .catch(() => null)
        .then(value => {
          if (!controller.signal.aborted) {
            values.set(key, { value: clone(value), expiresAt: now() + (value === null || !isUsable(value) ? negativeTtlMs : ttlMs) });
            while (values.size > maxEntries) values.delete(values.keys().next().value!);
          }
          return value;
        })
        .finally(() => { if (requests.get(key) === created) requests.delete(key); });
      request = created;
      requests.set(key, request);
    }
    const current = request;
    current.consumers++;
    return new Promise(resolve => {
      let settled = false;
      const finish = (value: T | null) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', cancel);
        current.consumers--;
        if (current.consumers === 0 && requests.get(key) === current) current.controller.abort();
        resolve(clone(value));
      };
      const cancel = () => finish(null);
      signal?.addEventListener('abort', cancel, { once: true });
      current.promise.then(finish);
      if (signal?.aborted) cancel();
    });
  };
}
