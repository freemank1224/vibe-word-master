import type { SurfEvent } from './types';
import { safePronunciationUrl } from '../../services/pronunciationSources.ts';

const START_TIMEOUT_MS = 8000;
const CRYSTAL_CHIME_WINDOW_MS = 140;

interface SurfAudioOptions {
  resolveSources?: (word: string, audioUrl?: string | null) => readonly string[];
  onSourceReady?: (word: string, url: string) => void;
  /** Trusted, fully downloaded Blob from SurfRecordingBuffer; never a remote URL. */
  resolvePreparedSource?: (word: string, audioUrl?: string | null) => string | null | Promise<string | null>;
}

/** Cancellable playback of the project's recordings. Never substitute system voices. */
export class SurfAudio {
  private context: AudioContext | null = null;
  private destroyed = false;
  private effects = true;
  private cancelSpeech: (() => void) | null = null;
  private effectStops = new Set<() => void>();
  private lastCrystalAt = -Infinity;
  private pendingCrystals = 0;
  private crystalTimer: ReturnType<typeof setTimeout> | null = null;
  private crystalPhrase = 0;
  private options: SurfAudioOptions;

  constructor(options: SurfAudioOptions = {}) { this.options = options; }

  get effectsEnabled() { return this.effects; }
  set effectsEnabled(enabled: boolean) {
    this.effects = enabled;
    if (!enabled) this.stopEffects();
  }

  /** Call from Start / Replay / Sound buttons, never from an automatic timer. */
  unlock(): void {
    if (this.destroyed || typeof window === 'undefined') return;
    try {
      if (!this.context && window.AudioContext) this.context = new window.AudioContext();
      void this.context?.resume().catch(() => {});
    } catch { /* Dictation remains available without Web Audio effects. */ }
  }

  speak(word: string, slow = false, audioUrl?: string | null): Promise<boolean> {
    this.stopSpeech();
    const answer = word.trim();
    if (this.destroyed || !answer || typeof window === 'undefined' || !window.Audio) return Promise.resolve(false);
    let sources: string[] = [];
    if (!this.options.resolvePreparedSource) {
      try {
        sources = [...new Set((this.options.resolveSources?.(answer, audioUrl) ?? [audioUrl])
          .map(safePronunciationUrl).filter((url): url is string => Boolean(url)))];
      } catch { return Promise.resolve(false); }
      if (!sources.length) return Promise.resolve(false);
    }
    return new Promise<boolean>(resolve => {
      let settled = false;
      let cancelled = false;
      let releaseCurrent: (() => void) | null = null;
      const settle = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
      const finish = (ok: boolean) => {
        cancelled = true; releaseCurrent?.(); releaseCurrent = null;
        if (this.cancelSpeech === cancel) this.cancelSpeech = null;
        settle(ok);
      };
      const cancel = () => finish(false);
      this.cancelSpeech = cancel;
      const play = (index: number) => {
        if (cancelled || this.destroyed) return;
        if (index >= sources.length) { finish(false); return; }
        let disposed = false;
        let audio: HTMLAudioElement | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const release = () => {
          if (disposed) return;
          disposed = true; clearTimeout(timer);
          if (audio) {
            audio.onplaying = audio.onended = audio.onerror = null;
            try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch { /* Released. */ }
          }
        };
        const fail = () => {
          if (disposed || cancelled) return;
          release();
          // A failed stored/cache URL may recover through the official asset service.
          play(index + 1);
        };
        releaseCurrent = release;
        try {
          audio = new window.Audio(sources[index]);
          audio.preload = 'auto'; audio.playbackRate = slow ? 0.72 : 1; audio.preservesPitch = true;
          audio.onplaying = () => {
            if (disposed || cancelled) return;
            clearTimeout(timer);
            if (!this.options.resolvePreparedSource) {
              try { this.options.onSourceReady?.(answer, sources[index]); } catch { /* Cache is optional. */ }
            }
            settle(true);
          };
          audio.onended = () => { if (!disposed && !cancelled) finish(true); };
          audio.onerror = fail;
          timer = setTimeout(fail, START_TIMEOUT_MS);
          void audio.play().catch(fail);
        } catch { fail(); }
      };
      if (this.options.resolvePreparedSource) {
        try {
          void Promise.resolve(this.options.resolvePreparedSource(answer, audioUrl)).then(source => {
            if (cancelled || this.destroyed) return;
            // Deliberately do not accept network URLs on the prepared-playback path.
            if (!source?.startsWith('blob:')) { finish(false); return; }
            sources = [source];
            play(0);
          }, () => finish(false));
        } catch { finish(false); }
      } else play(0);
    });
  }

  stopSpeech(): void { this.cancelSpeech?.(); }

  play(kind: SurfEvent['kind'], crystalCount = 1): void {
    const ctx = this.context;
    if (this.destroyed || !this.effects || !ctx || ctx.state !== 'running') return;
    // The legacy event name now represents Sea Crystal pickups, never wallet coins.
    if (kind === 'coin') {
      this.queueCrystals(crystalCount);
      return;
    }
    const seaEvent = kind.startsWith('sea-');
    const lowVoice = kind === 'hurt' || kind === 'over' || kind === 'sea-warning' || kind === 'sea-approach' || kind === 'sea-attack';
    if (kind === 'correct' || kind === 'hurt' || kind === 'over' || seaEvent) this.stopEffects();
    const notes: Record<SurfEvent['kind'], number[]> = {
      checkpoint: [523, 659], correct: [523, 659, 784, 1046],
      coin: [1175, 1568], hurt: [185, 110], over: [220, 165, 110],
      'sea-warning': [196, 147, 196], 'sea-approach': [220, 174],
      'sea-escape': [523, 659, 784, 1046, 1318], 'sea-attack': [110, 73, 55],
    };
    notes[kind].forEach((frequency, index) => {
      const at = ctx.currentTime + index * (kind === 'sea-warning' ? 0.11 : 0.065);
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = lowVoice ? 'triangle' : 'sine';
      oscillator.frequency.setValueAtTime(frequency, at);
      oscillator.frequency.exponentialRampToValueAtTime(frequency * (lowVoice ? 0.73 : 1.03), at + 0.16);
      gain.gain.setValueAtTime(0, at);
      // Chase cues stay brief and below dictation; speech is never interrupted by effects.
      const volume = (this.cancelSpeech ? 0.014 : seaEvent ? 0.038 : 0.055) / Math.sqrt(notes[kind].length / 2);
      gain.gain.linearRampToValueAtTime(volume, at + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.21);
      oscillator.connect(gain).connect(ctx.destination);
      this.trackEffect(oscillator, [gain]);
      oscillator.start(at);
      oscillator.stop(at + 0.23);
    });
    if (kind === 'correct' || kind === 'hurt' || kind === 'over') this.splash(kind === 'over' ? 0.65 : 0.3);
    if (kind === 'sea-attack') this.splash(0.55);
    if (kind === 'sea-escape') this.splash(0.24);
  }

  /** A crystal formation gets one short glassy phrase, never one sound per pickup. */
  private queueCrystals(count: number): void {
    const ctx = this.context!;
    this.pendingCrystals = Math.min(99, this.pendingCrystals + (Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1));
    const waitMs = CRYSTAL_CHIME_WINDOW_MS - (ctx.currentTime - this.lastCrystalAt) * 1000;
    if (waitMs <= 0) {
      if (this.crystalTimer !== null) clearTimeout(this.crystalTimer);
      this.crystalTimer = null;
      this.flushCrystals();
    } else if (this.crystalTimer === null) {
      this.crystalTimer = setTimeout(() => {
        this.crystalTimer = null;
        this.flushCrystals();
      }, waitMs);
    }
  }

  private flushCrystals(): void {
    const count = this.pendingCrystals;
    this.pendingCrystals = 0;
    const ctx = this.context;
    if (!count || this.destroyed || !this.effects || !ctx || ctx.state !== 'running') return;
    this.crystalPhrase = ctx.currentTime - this.lastCrystalAt < 0.5 ? (this.crystalPhrase + 1) % 5 : 0;
    this.lastCrystalAt = ctx.currentTime;
    const pentatonic = [0, 2, 4, 7, 9];
    const root = 1046.5 * 2 ** (pentatonic[this.crystalPhrase] / 12);
    const intervals = count >= 6 ? [0, 7, 12] : count >= 2 ? [0, 7] : [0];
    // A quiet glass chime sits behind dictation; muting effects leaves speech alone.
    const volume = (this.cancelSpeech ? 0.011 : 0.026) / Math.sqrt(intervals.length);
    intervals.forEach((interval, index) => {
      const at = ctx.currentTime + index * 0.032;
      const frequency = root * 2 ** (interval / 12);
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency * 1.035, at);
      oscillator.frequency.exponentialRampToValueAtTime(frequency, at + 0.065);
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(volume, at + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.14);
      oscillator.connect(gain).connect(ctx.destination);
      this.trackEffect(oscillator, [gain]);
      oscillator.start(at); oscillator.stop(at + 0.16);
    });
  }

  private splash(duration: number): void {
    const ctx = this.context!;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    source.buffer = buffer;
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1800, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(260, ctx.currentTime + duration);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(this.cancelSpeech ? 0.018 : 0.075, ctx.currentTime + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    source.connect(filter).connect(gain).connect(ctx.destination);
    this.trackEffect(source, [filter, gain]);
    source.start();
    source.stop(ctx.currentTime + duration);
  }

  private trackEffect(source: AudioScheduledSourceNode, nodes: AudioNode[]): void {
    const disconnect = () => {
      source.disconnect();
      nodes.forEach(node => node.disconnect());
      this.effectStops.delete(stop);
    };
    const stop = () => { try { source.stop(); } catch { /* Already ended. */ } disconnect(); };
    source.onended = disconnect;
    this.effectStops.add(stop);
  }

  stopEffects(): void {
    if (this.crystalTimer !== null) clearTimeout(this.crystalTimer);
    this.crystalTimer = null; this.pendingCrystals = 0; this.lastCrystalAt = -Infinity; this.crystalPhrase = 0;
    [...this.effectStops].forEach(stop => stop());
  }

  destroy(): void {
    this.destroyed = true;
    this.stopSpeech();
    this.stopEffects();
    void this.context?.close().catch(() => {});
    this.context = null;
  }
}
