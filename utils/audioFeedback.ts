/**
 * Procedural audio generation for UI feedback
 */

let audioCtx: AudioContext | null = null;

const getCtx = () => {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return audioCtx;
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

