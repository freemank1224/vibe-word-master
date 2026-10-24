import type { SurfEvent } from './types';

const VOICE_WAIT_MS = 900;
const START_TIMEOUT_MS = 5000;
const COIN_CHIME_WINDOW_MS = 140;

/** Standalone practice audio with browser speech fallback; no account or remote API. */
export class SurfAudio {
  private context: AudioContext | null = null;
  private destroyed = false;
  private effects = true;
  private cancelSpeech: (() => void) | null = null;
  // Keep a strong reference until completion; some engines drop unreferenced utterances.
  private utterance: SpeechSynthesisUtterance | null = null;
  private effectStops = new Set<() => void>();
  private lastCoinAt = -Infinity;
  private pendingCoins = 0;
  private coinTimer: ReturnType<typeof setTimeout> | null = null;
  private coinPhrase = 0;

  get effectsEnabled() { return this.effects; }
  set effectsEnabled(enabled: boolean) {
    this.effects = enabled;
    if (!enabled) this.stopEffects();
  }

  /** Call from Start / Replay / Sound buttons, never from an automatic timer. */
  unlock(): void {
    if (this.destroyed || typeof window === 'undefined') return;
    // Asking early starts asynchronous voice enumeration without speaking an answer.
    try { window.speechSynthesis?.getVoices(); } catch { /* Voice loading can fail independently. */ }
    try {
      if (!this.context && window.AudioContext) this.context = new window.AudioContext();
      void this.context?.resume().catch(() => {});
    } catch { /* Dictation must remain available even without Web Audio effects. */ }
  }

  /** Same-origin practice audio first, browser English speech as a fallback. */
  speak(word: string, slow = false): Promise<boolean> {
    this.stopSpeech();
    const answer = word.trim();
    if (this.destroyed || !answer || typeof window === 'undefined') return Promise.resolve(false);
    if (!/^[a-z]+$/i.test(answer) || !window.Audio) return this.speakWithSpeech(answer, slow);
    return new Promise<boolean>(resolve => {
      let settled = false;
      let disposed = false;
      let audio: HTMLAudioElement | null = null;
      let startTimeout: ReturnType<typeof setTimeout> | undefined;
      const settle = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
      const clear = () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(startTimeout);
        if (audio) {
          audio.onplaying = audio.onended = audio.onerror = null;
          try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch { /* Already released. */ }
        }
        if (this.cancelSpeech === cancel) this.cancelSpeech = null;
      };
      const cancel = () => { settle(false); clear(); };
      const fallback = () => {
        if (disposed) return;
        clear();
        // The fallback installs its own cancellation handler before returning.
        void this.speakWithSpeech(answer, slow).then(settle);
      };
      this.cancelSpeech = cancel;
      try {
        audio = new window.Audio(`/monster-surf/audio/${encodeURIComponent(answer.toLowerCase())}.m4a`);
        audio.preload = 'auto';
        audio.playbackRate = slow ? 0.72 : 1;
        audio.preservesPitch = true;
        audio.onplaying = () => {
          if (disposed) return;
          clearTimeout(startTimeout);
          settle(true);
        };
        audio.onended = () => { if (!disposed) { settle(true); clear(); } };
        audio.onerror = fallback;
        startTimeout = setTimeout(fallback, START_TIMEOUT_MS);
        void audio.play().catch(fallback);
      } catch { fallback(); }
    });
  }

  /** Resolves true only on actual speech start/end. Effects mute never mutes the question. */
  private speakWithSpeech(answer: string, slow: boolean): Promise<boolean> {
    this.stopSpeech();
    if (this.destroyed || !answer || typeof window === 'undefined'
      || !window.speechSynthesis || !window.SpeechSynthesisUtterance) return Promise.resolve(false);
    const synth = window.speechSynthesis;
    return new Promise<boolean>(resolve => {
      let settled = false;
      let disposed = false;
      let enqueued = false;
      let waitingForVoices = false;
      let utterance: SpeechSynthesisUtterance | null = null;
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const later = (fn: () => void, delay: number) => {
        const timer = setTimeout(() => { timers.delete(timer); if (!disposed) fn(); }, delay);
        timers.add(timer);
        return timer;
      };
      const settle = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
      const clear = () => {
        if (disposed) return;
        disposed = true;
        timers.forEach(clearTimeout);
        timers.clear();
        synth.removeEventListener('voiceschanged', onVoicesChanged);
        if (utterance) utterance.onstart = utterance.onend = utterance.onerror = null;
        if (this.utterance === utterance) this.utterance = null;
        if (this.cancelSpeech === cancel) this.cancelSpeech = null;
      };
      const cancel = () => {
        settle(false);
        clear();
        // Cancel queued speech too, so a paused/old checkpoint cannot speak later.
        if (enqueued) { try { synth.cancel(); } catch { /* Engine may already have shut down. */ } }
      };
      const voices = () => {
        try { return synth.getVoices(); } catch { return []; }
      };
      const englishVoice = () => voices().filter(voice => /^en(?:[-_]|$)/i.test(voice.lang))
        .sort((a, b) => {
          const score = (voice: SpeechSynthesisVoice) =>
            (/^en[-_]US$/i.test(voice.lang) ? 4 : 0) + (voice.localService ? 2 : 0) + (voice.default ? 1 : 0);
          return score(b) - score(a);
        })[0];
      const begin = () => {
        if (disposed || enqueued) return;
        waitingForVoices = false;
        synth.removeEventListener('voiceschanged', onVoicesChanged);
        try {
          utterance = new window.SpeechSynthesisUtterance(answer);
          this.utterance = utterance;
          const voice = englishVoice();
          if (voice) utterance.voice = voice;
          // An empty list is normal in engines that resolve voices only when speaking.
          // Never select the system's potentially non-English default voice explicitly.
          utterance.lang = voice?.lang || 'en-US';
          utterance.rate = slow ? 0.62 : 0.88;
          utterance.pitch = 1;
          utterance.volume = 1;
          let startTimeout: ReturnType<typeof setTimeout>;
          utterance.onstart = () => {
            if (disposed) return;
            clearTimeout(startTimeout);
            timers.delete(startTimeout);
            settle(true);
          };
          utterance.onend = () => { if (!disposed) { settle(true); clear(); } };
          utterance.onerror = () => { if (!disposed) { settle(false); clear(); } };
          // A silent engine is a failure, not a successful pronunciation.
          startTimeout = later(cancel, START_TIMEOUT_MS);
          later(cancel, 20000);
          enqueued = true;
          if (synth.paused) synth.resume();
          synth.speak(utterance);
        } catch { cancel(); }
      };
      function onVoicesChanged() {
        if (waitingForVoices && englishVoice()) begin();
      }
      this.cancelSpeech = cancel;
      if (englishVoice()) begin();
      else {
        waitingForVoices = true;
        synth.addEventListener('voiceschanged', onVoicesChanged);
        later(begin, VOICE_WAIT_MS);
        // A few Chromium builds populate getVoices without emitting voiceschanged.
        const poll = () => {
          if (!waitingForVoices) return;
          if (englishVoice()) begin(); else later(poll, 120);
        };
        later(poll, 120);
      }
    });
  }

  stopSpeech(): void { this.cancelSpeech?.(); }

  play(kind: SurfEvent['kind'], coinCount = 1): void {
    const ctx = this.context;
    if (this.destroyed || !this.effects || !ctx || ctx.state !== 'running') return;
    if (kind === 'coin') {
      this.queueCoins(coinCount);
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

  /** A coin formation gets one short musical phrase, never one sound per coin. */
  private queueCoins(count: number): void {
    const ctx = this.context!;
    this.pendingCoins = Math.min(99, this.pendingCoins + (Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1));
    const waitMs = COIN_CHIME_WINDOW_MS - (ctx.currentTime - this.lastCoinAt) * 1000;
    if (waitMs <= 0) {
      if (this.coinTimer !== null) clearTimeout(this.coinTimer);
      this.coinTimer = null;
      this.flushCoins();
    } else if (this.coinTimer === null) {
      this.coinTimer = setTimeout(() => {
        this.coinTimer = null;
        this.flushCoins();
      }, waitMs);
    }
  }

  private flushCoins(): void {
    const count = this.pendingCoins;
    this.pendingCoins = 0;
    const ctx = this.context;
    if (!count || this.destroyed || !this.effects || !ctx || ctx.state !== 'running') return;
    this.coinPhrase = ctx.currentTime - this.lastCoinAt < 0.5 ? (this.coinPhrase + 1) % 5 : 0;
    this.lastCoinAt = ctx.currentTime;
    const pentatonic = [0, 2, 4, 7, 9];
    const root = 880 * 2 ** (pentatonic[this.coinPhrase] / 12);
    const intervals = count >= 6 ? [0, 7, 12] : count >= 2 ? [0, 7] : [0];
    // A quiet bell sits behind the spoken dictation; muting effects leaves speech alone.
    const volume = (this.cancelSpeech ? 0.011 : 0.026) / Math.sqrt(intervals.length);
    intervals.forEach((interval, index) => {
      const at = ctx.currentTime + index * 0.032;
      const frequency = root * 2 ** (interval / 12);
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, at);
      oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.025, at + 0.075);
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
    if (this.coinTimer !== null) clearTimeout(this.coinTimer);
    this.coinTimer = null; this.pendingCoins = 0; this.lastCoinAt = -Infinity; this.coinPhrase = 0;
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
