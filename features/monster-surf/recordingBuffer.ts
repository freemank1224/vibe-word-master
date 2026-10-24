import { safePronunciationUrl } from '../../services/pronunciationSources.ts';
import type { SurfWord } from './types';

const WINDOW_SIZE = 20;
const RETAIN_BEHIND = 2;
const MAX_STREAM_CACHE = WINDOW_SIZE + RETAIN_BEHIND + 2;
const CONCURRENCY = 4;
// A first official asset request may generate the missing recording server-side.
const DOWNLOAD_TIMEOUT_MS = 30000;
const RETRY_DELAY_MS = 500;
const MAX_RECORDING_BYTES = 8 * 1024 * 1024;

export interface SurfRecordingProgress {
  loaded: number;
  total: number;
  failed: number;
  loading: boolean;
}

export interface SurfRecordingBufferOptions {
  resolveSources: (word: string, audioUrl?: string | null) => readonly string[];
  onSourceReady?: (word: string, sourceUrl: string) => void;
}

export class SurfRecordingLoadError extends Error {
  readonly failedWords: readonly string[];
  constructor(words: readonly string[]) {
    super(`Unable to prepare ${words.length} word recording${words.length === 1 ? '' : 's'}.`);
    this.name = 'SurfRecordingLoadError';
    this.failedWords = words;
  }
}

interface RecordingEntry {
  key: string;
  word: string;
  audioUrl?: string | null;
  state: 'queued' | 'loading' | 'ready' | 'failed';
  /** Current-word requests precede launch loading, which precedes background work. */
  priority: 0 | 1 | 2;
  source: string | null;
  touched: number;
  controller: AbortController;
  promise: Promise<string>;
  resolve: (source: string) => void;
  reject: (error: Error) => void;
}

const cancelled = () => new DOMException('Recording preparation cancelled.', 'AbortError');
const keyFor = (word: string, audioUrl?: string | null) => `${word.trim().toLowerCase()}\n${safePronunciationUrl(audioUrl) ?? ''}`;

class RecordingAttemptError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number;
  constructor(message: string, retryable: boolean, retryAfterMs = RETRY_DELAY_MS) {
    super(message); this.retryable = retryable; this.retryAfterMs = retryAfterMs;
  }
}

function retryDelay(value: string | null): number {
  if (!value) return RETRY_DELAY_MS;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.min(3000, Math.max(0, milliseconds)) : RETRY_DELAY_MS;
}

function waitToRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Race even misbehaving transports/decoders against cancellation and their timeout. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(signal.reason ?? cancelled());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? cancelled()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** A complete Blob still has to be decodable before the player may enter the sea. */
function validateRecording(source: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? cancelled());
  if (typeof window === 'undefined' || !window.Audio) return Promise.reject(new Error('Audio playback is unavailable.'));
  return new Promise<void>((resolve, reject) => {
    const audio = new window.Audio();
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', abort);
      audio.oncanplay = audio.onloadeddata = audio.onerror = null;
      try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch { /* Decoder has been released. */ }
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(signal.reason instanceof Error ? signal.reason : cancelled());
    signal.addEventListener('abort', abort, { once: true });
    audio.preload = 'auto';
    audio.oncanplay = () => finish();
    audio.onloadeddata = () => finish();
    audio.onerror = () => finish(new Error('The downloaded recording cannot be decoded.'));
    try { audio.src = source; audio.load(); } catch (error) { finish(error instanceof Error ? error : new Error('Invalid recording.')); }
  });
}

/**
 * Holds downloaded, validated recordings, not merely remote URLs or preload hints.
 * Fixed rounds keep their entire deck; streaming rounds keep a bounded look-ahead.
 */
export class SurfRecordingBuffer {
  private readonly options: SurfRecordingBufferOptions;
  private entries = new Map<string, RecordingEntry>();
  private queue: RecordingEntry[] = [];
  private active = 0;
  private disposed = false;
  private generation = 0;
  private clock = 0;
  private deck: readonly SurfWord[] = [];
  private mode: 'fixed' | 'endless' = 'fixed';
  private checkpoint = 0;
  private targetKeys = new Set<string>();
  private retainedKeys = new Set<string>();
  private onProgress?: (progress: SurfRecordingProgress) => void;
  private preparing = false;

  constructor(options: SurfRecordingBufferOptions) { this.options = options; }

  get progress(): SurfRecordingProgress {
    let loaded = 0; let failed = 0; let pending = 0;
    for (const key of this.targetKeys) {
      const entry = this.entries.get(key);
      if (entry?.state === 'ready') loaded++;
      if (entry?.state === 'failed') failed++;
      if (entry?.state === 'queued' || entry?.state === 'loading') pending++;
    }
    return { loaded, total: this.targetKeys.size, failed, loading: this.preparing || pending > 0 };
  }

  /** Resolves only after every required recording has downloaded and decoded. */
  async prepare(deck: readonly SurfWord[], options: {
    mode: 'fixed' | 'endless'; checkpoint?: number; onProgress?: (progress: SurfRecordingProgress) => void;
  }): Promise<void> {
    if (this.disposed) throw cancelled();
    this.abort();
    const generation = this.generation;
    this.deck = deck;
    this.mode = options.mode;
    this.checkpoint = Math.min(deck.length, Math.max(0, Math.floor(options.checkpoint ?? 0)));
    this.onProgress = options.onProgress;
    this.preparing = true;
    const needed = this.setWindow(this.checkpoint);
    this.prune();
    const results = await Promise.allSettled(needed.map(word => this.request(word.answer, word.audioUrl, 1)));
    if (this.disposed || generation !== this.generation) throw cancelled();
    this.preparing = false;
    this.emitProgress();
    const failed = needed.filter((_word, index) => results[index].status === 'rejected');
    if (failed.length) throw new SurfRecordingLoadError(failed.map(word => word.answer));
  }

  /** Move the rolling window without awaiting background downloads in the game loop. */
  advance(checkpoint: number): void {
    if (this.disposed || this.mode !== 'endless') return;
    const next = Math.min(this.deck.length, Math.max(0, Math.floor(checkpoint)));
    if (next === this.checkpoint) return;
    this.checkpoint = next;
    const needed = this.setWindow(next);
    this.prune();
    for (const word of needed) void this.request(word.answer, word.audioUrl, 2).catch(() => {});
    this.emitProgress();
  }

  getSource(word: string, audioUrl?: string | null): string | null {
    const entry = this.entries.get(keyFor(word, audioUrl));
    if (entry?.state !== 'ready') return null;
    entry.touched = ++this.clock;
    return entry.source;
  }

  /** Foreground underruns/review replays take priority over queued background work. */
  ensure(word: string, audioUrl?: string | null): Promise<string> { return this.request(word, audioUrl, 0); }

  /** Cancel pending work. Already prepared recordings remain reusable on retry. */
  abort(): void {
    this.generation++;
    this.preparing = false;
    for (const entry of [...this.entries.values()]) {
      if (entry.state === 'ready' || entry.state === 'failed') continue;
      this.entries.delete(entry.key);
      entry.controller.abort(cancelled());
      entry.reject(cancelled());
    }
    this.queue = [];
    this.emitProgress();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort();
    for (const entry of this.entries.values()) if (entry.source) URL.revokeObjectURL(entry.source);
    this.entries.clear();
    this.targetKeys.clear();
    this.retainedKeys.clear();
    this.deck = [];
    this.onProgress = undefined;
  }

  private setWindow(checkpoint: number): readonly SurfWord[] {
    const end = this.mode === 'fixed' ? this.deck.length : Math.min(this.deck.length, checkpoint + WINDOW_SIZE);
    const needed = this.deck.slice(checkpoint, end);
    this.targetKeys = new Set(needed.map(word => keyFor(word.answer, word.audioUrl)));
    const keep = this.mode === 'fixed' ? this.deck : this.deck.slice(Math.max(0, checkpoint - RETAIN_BEHIND), end);
    this.retainedKeys = new Set(keep.map(word => keyFor(word.answer, word.audioUrl)));
    return needed;
  }

  private emitProgress(): void {
    try { this.onProgress?.(this.progress); } catch { /* Rendering must not interrupt downloads. */ }
  }

  private request(word: string, audioUrl: string | null | undefined, priority: 0 | 1 | 2): Promise<string> {
    if (this.disposed) return Promise.reject(cancelled());
    const answer = word.trim();
    if (!answer) return Promise.reject(new Error('Missing word.'));
    const key = keyFor(answer, audioUrl);
    const old = this.entries.get(key);
    if (old && old.state !== 'failed') {
      old.touched = ++this.clock;
      old.priority = Math.min(old.priority, priority) as 0 | 1 | 2;
      this.pump();
      return old.promise;
    }
    let resolve!: RecordingEntry['resolve']; let reject!: RecordingEntry['reject'];
    const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    const entry: RecordingEntry = {
      key, word: answer, audioUrl, state: 'queued', priority, source: null,
      touched: ++this.clock, controller: new AbortController(), promise, resolve, reject,
    };
    this.entries.set(key, entry);
    this.queue.push(entry);
    this.pump();
    this.emitProgress();
    return promise;
  }

  private pump(): void {
    if (this.disposed) return;
    this.queue.sort((a, b) => a.priority - b.priority);
    while (this.active < CONCURRENCY && this.queue.length) {
      // Keep one network slot available to the current word during streaming.
      if (this.queue[0].priority === 2 && this.active >= CONCURRENCY - 1) break;
      const entry = this.queue.shift()!;
      if (this.entries.get(entry.key) !== entry || entry.controller.signal.aborted) continue;
      entry.state = 'loading'; this.active++;
      void this.download(entry).then(({ source, remote }) => {
        if (this.disposed || entry.controller.signal.aborted || this.entries.get(entry.key) !== entry) {
          URL.revokeObjectURL(source); entry.reject(cancelled()); return;
        }
        entry.state = 'ready'; entry.source = source;
        try { this.options.onSourceReady?.(entry.word, remote); } catch { /* Persistent URL cache is optional. */ }
        entry.resolve(source);
        this.trimExtraCache();
      }, error => {
        entry.state = 'failed';
        entry.reject(error instanceof Error ? error : new Error('Unable to download recording.'));
      }).finally(() => {
        this.active--;
        this.emitProgress();
        this.pump();
      });
    }
  }

  private async download(entry: RecordingEntry): Promise<{ source: string; remote: string }> {
    const sources = [...new Set(this.options.resolveSources(entry.word, entry.audioUrl)
      .map(safePronunciationUrl).filter((source): source is string => Boolean(source)))];
    let retry: { remote: string; delay: number } | null = null;
    for (const remote of sources) {
      if (entry.controller.signal.aborted) throw cancelled();
      try { return await this.downloadSource(entry, remote); }
      catch (error) {
        if (entry.controller.signal.aborted) throw cancelled();
        if (error instanceof RecordingAttemptError && error.retryable) retry = { remote, delay: error.retryAfterMs };
      }
    }
    // Try healthy fallback sources first. If all fail, make just one additional
    // request for the last transient source (usually the official asset service).
    if (retry) {
      await waitToRetry(retry.delay, entry.controller.signal);
      try { return await this.downloadSource(entry, retry.remote); }
      catch { if (entry.controller.signal.aborted) throw cancelled(); }
    }
    throw new SurfRecordingLoadError([entry.word]);
  }

  private async downloadSource(entry: RecordingEntry, remote: string): Promise<{ source: string; remote: string }> {
    if (entry.controller.signal.aborted) throw cancelled();
    const controller = new AbortController();
    const cancel = () => controller.abort(cancelled());
    entry.controller.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Recording download timed out.')), DOWNLOAD_TIMEOUT_MS);
    let source: string | null = null;
    let decoding = false;
    try {
      const response = await abortable(fetch(remote, { signal: controller.signal }), controller.signal);
      if (!response.ok) throw new RecordingAttemptError(`Recording returned ${response.status}.`,
        response.status === 408 || response.status === 429 || response.status >= 500,
        retryDelay(response.headers.get('retry-after')));
      if (Number(response.headers.get('content-length')) > MAX_RECORDING_BYTES) throw new RecordingAttemptError('Recording is too large.', false);
      const blob = await abortable(response.blob(), controller.signal);
      if (!blob.size || blob.size > MAX_RECORDING_BYTES || (blob.type && !/^(audio\/|video\/mp4|application\/octet-stream|binary\/octet-stream)/i.test(blob.type))) {
        throw new RecordingAttemptError('Invalid recording response.', false);
      }
      if (controller.signal.aborted) throw controller.signal.reason ?? cancelled();
      decoding = true;
      source = URL.createObjectURL(blob);
      await validateRecording(source, controller.signal);
      return { source, remote };
    } catch (error) {
      if (source) URL.revokeObjectURL(source);
      if (entry.controller.signal.aborted) throw cancelled();
      if (error instanceof RecordingAttemptError) throw error;
      // Fetch/body interruptions and download timeouts can recover. Invalid
      // media or a failed local decoder cannot improve by fetching it twice.
      throw new RecordingAttemptError('Unable to prepare the recording.', !decoding);
    } finally {
      clearTimeout(timer);
      entry.controller.signal.removeEventListener('abort', cancel);
    }
  }

  private prune(): void {
    for (const entry of [...this.entries.values()]) {
      if (this.retainedKeys.has(entry.key)) continue;
      this.entries.delete(entry.key);
      if (entry.source) URL.revokeObjectURL(entry.source);
      if (entry.state === 'queued' || entry.state === 'loading') {
        entry.controller.abort(cancelled()); entry.reject(cancelled());
      }
    }
    this.queue = this.queue.filter(entry => this.entries.get(entry.key) === entry);
  }

  private trimExtraCache(): void {
    if (this.mode !== 'endless' || this.entries.size <= MAX_STREAM_CACHE) return;
    const extras = [...this.entries.values()].filter(entry => !this.retainedKeys.has(entry.key) && entry.state === 'ready')
      .sort((a, b) => a.touched - b.touched);
    for (const entry of extras) {
      if (this.entries.size <= MAX_STREAM_CACHE) break;
      this.entries.delete(entry.key);
      if (entry.source) URL.revokeObjectURL(entry.source);
    }
  }
}
