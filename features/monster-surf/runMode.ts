/** The final slider stop is an entire-library pass, never a repeating round. */
export type SurfRunMode = { kind: 'fixed'; wordCount: number } | { kind: 'endless' };

export const SURF_MIN_WORDS = 10;
export const SURF_MAX_WORDS = 50;
export const SURF_ENDLESS_SLIDER_VALUE = 51;
export const SURF_STREAMING_WINDOW = 20;
export const DEFAULT_SURF_RUN_MODE: SurfRunMode = Object.freeze({ kind: 'fixed', wordCount: 20 });

export function isSurfRunMode(value: unknown): value is SurfRunMode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const mode = value as Record<string, unknown>;
  return mode.kind === 'endless' || (mode.kind === 'fixed' && Number.isInteger(mode.wordCount)
    && (mode.wordCount as number) >= SURF_MIN_WORDS && (mode.wordCount as number) <= SURF_MAX_WORDS);
}

export function modeFromSlider(value: number): SurfRunMode {
  if (value === SURF_ENDLESS_SLIDER_VALUE) return { kind: 'endless' };
  const count = Number.isFinite(value) ? Math.round(value) : 20;
  return { kind: 'fixed', wordCount: Math.max(SURF_MIN_WORDS, Math.min(SURF_MAX_WORDS, count)) };
}

export function modeToSlider(mode: SurfRunMode): number {
  return mode.kind === 'endless' ? SURF_ENDLESS_SLIDER_VALUE : mode.wordCount;
}

export function modeWordLimit(mode: SurfRunMode): number {
  return mode.kind === 'endless' ? Infinity : mode.wordCount;
}

/** Null preserves legacy paid decks, which must also be prepared in full. */
export function initialAudioWordCount(mode: SurfRunMode | null, remainingWords: number): number {
  return Math.min(Math.max(0, Math.floor(remainingWords)), mode?.kind === 'endless' ? SURF_STREAMING_WINDOW : Infinity);
}
