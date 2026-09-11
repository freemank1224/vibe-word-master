/**
 * Procedural audio generation for UI feedback
 */

let audioCtx: AudioContext | null = null;

const getCtx = () => {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  // Autoplay policy: browsers start the context suspended until a user
  // gesture; resume cheaply whenever it is still suspended.
  if (audioCtx.state === 'suspended') {
    void audioCtx.resume();
  }
  return audioCtx;
};

/** Shared white-noise buffer (mono, `seconds` long). */
const createNoiseBuffer = (ctx: AudioContext, seconds: number): AudioBuffer => {
  const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
};

export const playDing = () => {
  const ctx = getCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, ctx.currentTime); // A5
  osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.1); // E6

  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0.2, ctx.currentTime + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start();
  osc.stop(ctx.currentTime + 0.5);
};


export const playAchievementUnlock = () => {
  const ctx = getCtx();
  const now = ctx.currentTime;
  
  // Create a Major 7th Arpeggio: C4, E4, G4, B4, C5
  const notes = [261.63, 329.63, 392.00, 493.88, 523.25];
  
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.type = 'triangle'; // Softer, more pleasant tone
    osc.frequency.setValueAtTime(freq, now + i * 0.1);
    
    // Envelope for each note
    gain.gain.setValueAtTime(0, now + i * 0.1);
    gain.gain.linearRampToValueAtTime(0.1, now + i * 0.1 + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.8);
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    osc.start(now + i * 0.1);
    osc.stop(now + i * 0.1 + 1);
  });
};


/**
 * Coin reward jingle: two classic ascending metallic pings (Mario-style
 * B5 → E6) followed by a quick high sparkle trail. Used by the coin
 * reward popup and the daily-login reward modal.
 */
export const playCoinReward = () => {
  const ctx = getCtx();
  const now = ctx.currentTime;

  // 1. Two ascending square-wave pings (the iconic "coin" sound)
  const coinNotes = [
    { freq: 988, t: 0 },      // B5
    { freq: 1319, t: 0.08 },  // E6
  ];

  coinNotes.forEach(({ freq, t }) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, now + t);

    gain.gain.setValueAtTime(0, now + t);
    gain.gain.linearRampToValueAtTime(0.12, now + t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + t + 0.18);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now + t);
    osc.stop(now + t + 0.2);
  });

  // 2. Sparkle trail (three quick ascending sines for shine)
  const sparkles = [1568, 1976, 2637]; // G6, B6, E7
  sparkles.forEach((freq, i) => {
    const t = 0.18 + i * 0.06;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now + t);

    gain.gain.setValueAtTime(0, now + t);
    gain.gain.linearRampToValueAtTime(0.06, now + t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + t + 0.15);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now + t);
    osc.stop(now + t + 0.16);
  });
};


export const playBuzzer = () => {
  const ctx = getCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(110, ctx.currentTime); // A2
  osc.frequency.linearRampToValueAtTime(80, ctx.currentTime + 0.2);

  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.05);
  gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start();
  osc.stop(ctx.currentTime + 0.3);
};

export const playCheer = () => {
  const ctx = getCtx();
  const now = ctx.currentTime;
  const duration = 2.5;

  // 1. Crowd Roar (White noise with resonant filter)
  const bufferSize = ctx.sampleRate * duration;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const noise = ctx.createBufferSource();
  noise.buffer = buffer;

  const bandpass = ctx.createBiquadFilter();
  bandpass.type = 'lowpass';
  bandpass.frequency.setValueAtTime(800, now);
  bandpass.frequency.exponentialRampToValueAtTime(1200, now + duration);
  bandpass.Q.setValueAtTime(2, now);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.3, now + 0.1);
  gain.gain.exponentialRampToValueAtTime(0.01, now + duration);

  noise.connect(bandpass);
  bandpass.connect(gain);
  gain.connect(ctx.destination);

  // 2. High-pitched whistles (Sine oscillators)
  const whistles = [1200, 1500, 1800];
  whistles.forEach((freq, idx) => {
    const osc = ctx.createOscillator();
    const wGain = ctx.createGain();
    const wNow = now + 0.1 + idx * 0.2;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, wNow);
    osc.frequency.exponentialRampToValueAtTime(freq * 1.5, wNow + 0.5);

    wGain.gain.setValueAtTime(0, wNow);
    wGain.gain.linearRampToValueAtTime(0.05, wNow + 0.1);
    wGain.gain.exponentialRampToValueAtTime(0.001, wNow + 0.6);

    osc.connect(wGain);
    wGain.connect(ctx.destination);

    osc.start(wNow);
    osc.stop(wNow + 0.6);
  });

  noise.start(now);
  noise.stop(now + duration);
};


// ================================================================
// WORD STRIKE — physics typing-shooter effects
// ================================================================

/** Gunshot: 90ms noise burst through a sweeping lowpass + a sub thump. */
export const playGunshot = () => {
  const ctx = getCtx();
  const now = ctx.currentTime;

  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, 0.12);

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.setValueAtTime(4200, now);
  lowpass.frequency.exponentialRampToValueAtTime(320, now + 0.09);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.28, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);

  noise.connect(lowpass);
  lowpass.connect(gain);
  gain.connect(ctx.destination);
  noise.start(now);
  noise.stop(now + 0.12);

  // Sub thump for body
  const osc = ctx.createOscillator();
  const thumpGain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(60, now);
  thumpGain.gain.setValueAtTime(0.22, now);
  thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
  osc.connect(thumpGain);
  thumpGain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.08);
};

/** Brick shatter: 6 staggered metallic pings with random detune. */
export const playShatter = () => {
  const ctx = getCtx();
  const now = ctx.currentTime;

  const pings = 6;
  for (let i = 0; i < pings; i++) {
    const at = now + i * 0.018;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = i % 2 === 0 ? 'square' : 'triangle';
    osc.frequency.setValueAtTime(1800 + Math.random() * 2400, at);
    osc.detune.setValueAtTime((Math.random() - 0.5) * 60, at);

    gain.gain.setValueAtTime(0.09, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.07);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.08);
  }
};

/** Explosion: long filtered noise decay + falling sub-bass — launcher hit. */
export const playExplosion = () => {
  const ctx = getCtx();
  const now = ctx.currentTime;
  const duration = 0.7;

  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, duration);

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.setValueAtTime(900, now);
  lowpass.frequency.exponentialRampToValueAtTime(90, now + duration);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.35, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

  noise.connect(lowpass);
  lowpass.connect(gain);
  gain.connect(ctx.destination);
  noise.start(now);
  noise.stop(now + duration);

  const sub = ctx.createOscillator();
  const subGain = ctx.createGain();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(55, now);
  sub.frequency.exponentialRampToValueAtTime(28, now + 0.5);
  subGain.gain.setValueAtTime(0.3, now);
  subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
  sub.connect(subGain);
  subGain.connect(ctx.destination);
  sub.start(now);
  sub.stop(now + 0.6);
};

/** Miss: two descending sawtooth blips — shot connected, wrong letters. */
export const playMiss = () => {
  const ctx = getCtx();
  const now = ctx.currentTime;

  [420, 240].forEach((freq, i) => {
    const at = now + i * 0.09;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, at);

    gain.gain.setValueAtTime(0.12, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.08);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.09);
  });
};
