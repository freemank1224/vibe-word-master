/**
 * Typed facade over the vendored tiny-voca runtime (upstream Apache-2.0,
 * see VENDOR-NOTE.md). The upstream `.js` modules are untyped (allowJs, no
 * checkJs), so this wrapper is the only typed surface the app may import:
 *
 *   const rt = await createVocaRuntime(buffer);
 *   const { ids, stress } = rt.phonemize('hello');
 *   const wavBytes = rt.toWav(rt.synthesize(ids, stress));
 */

import { readGGUF, TinyVoca } from './tiny-voca.js';
import { fromGGUF } from './dizione/engine.js';
import { limited, wav } from './text.js';

/** Fixed voice for the local fallback: upstream male speaker M2. */
export const LOCAL_TTS_VOICE = 'M2';
/** The only language tiny-voca supports (American English). */
export const LOCAL_TTS_LANG = 'en';

export interface VocaRuntime {
  /** American-English text → { ids, stress } phoneme ids for synthesize(). */
  phonemize: (text: string) => { ids: number[]; stress: number[] };
  /** Phoneme ids → mono speech samples. Throws on oversized input.
   *  speed < 1 stretches durations (slower), > 1 compresses (faster). */
  synthesize: (ids: number[], stress: number[], options?: { speed?: number }) => Float32Array;
  /** Peak-limited samples → 16-bit PCM WAV bytes. */
  toWav: (audio: Float32Array) => ArrayBuffer;
  /** Sample rate of the synthesized audio, read from the model config. */
  sampleRate: number;
}

export async function createVocaRuntime(buffer: ArrayBuffer): Promise<VocaRuntime> {
  const file = readGGUF(buffer);
  const voca = new TinyVoca(file);
  const phonemizer = await fromGGUF(file);
  const sampleRate = Number(voca.config.sample_rate);
  return {
    phonemize: (text: string) => phonemizer.phonemize(text),
    synthesize: (ids, stress, options) => voca.synthesize(ids, stress, {
      // Upstream accepts a speaker name string (resolved via voices.indexOf)
      // but its JS-inferred signature only surfaces the numeric default.
      voice: LOCAL_TTS_VOICE as unknown as number,
      speed: options?.speed ?? 1,
    }).audio,
    toWav: (audio) => wav(limited(audio), sampleRate),
    sampleRate,
  };
}
