/** Brief, quiet feedback that leaves the next word's pronunciation in the foreground. */
export type PuzzleFeedbackKind = 'correct' | 'wrong' | 'line' | 'complete';

export interface PuzzleFeedbackNote {
  frequency: number;
  endFrequency?: number;
  start: number;
  duration: number;
  peak: number;
  waveform: 'sine' | 'triangle';
}

/** Durations are in seconds and gain is linear; no cue lasts longer than 360 ms. */
export const getPuzzleFeedbackNotes = (kind: PuzzleFeedbackKind): readonly PuzzleFeedbackNote[] => {
  switch (kind) {
    case 'correct':
      return [
        { frequency: 659.25, start: 0, duration: 0.12, peak: 0.045, waveform: 'sine' },
        { frequency: 987.77, start: 0.045, duration: 0.12, peak: 0.032, waveform: 'sine' },
      ];
    case 'wrong':
      return [{ frequency: 196, endFrequency: 146.83, start: 0, duration: 0.12, peak: 0.035, waveform: 'triangle' }];
    case 'line':
      return [523.25, 659.25, 783.99].map((frequency, index) => ({
        frequency, start: index * 0.055, duration: 0.12, peak: 0.035, waveform: 'sine',
      }));
    case 'complete':
      return [523.25, 659.25, 783.99, 1046.5].map((frequency, index) => ({
        frequency, start: index * 0.04, duration: 0.24, peak: 0.025, waveform: 'sine',
      }));
  }
};

let context: AudioContext | null = null;
let playbackRevision = 0;
const activeVoices = new Set<{ oscillator: OscillatorNode; disconnect: () => void }>();

const getContext = (): AudioContext | null => {
  if (typeof window === 'undefined') return null;
  try {
    if (!context || context.state === 'closed') {
      const AudioContextClass = window.AudioContext
        || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return null;
      context = new AudioContextClass();
    }
    return context;
  } catch {
    // A denied audio device or unsupported Web Audio must never block answering.
    return null;
  }
};

/** Also invalidates a cue still waiting for the browser's autoplay permission. */
export const stopPuzzleFeedbackAudio = (): void => {
  playbackRevision += 1;
  for (const voice of activeVoices) {
    try { voice.oscillator.stop(); } catch { /* A finished oscillator can already be stopped. */ }
    voice.disconnect();
  }
  activeVoices.clear();
};

/** Call from a user gesture, and pass the same enabled preference used by playback. */
export const unlockPuzzleFeedbackAudio = (enabled = true): void => {
  if (!enabled) return;
  const audio = getContext();
  if (audio?.state === 'suspended') {
    try { void audio.resume().catch(() => {}); } catch { /* Audio is optional. */ }
  }
};

const scheduleFeedback = (audio: AudioContext, kind: PuzzleFeedbackKind): void => {
  try {
    const now = audio.currentTime;
    for (const note of getPuzzleFeedbackNotes(kind)) {
      const oscillator = audio.createOscillator();
      let gain: GainNode;
      try { gain = audio.createGain(); } catch (error) {
        oscillator.disconnect();
        throw error;
      }
      const voice = {
        oscillator,
        disconnect: () => {
          oscillator.onended = null;
          oscillator.disconnect();
          gain.disconnect();
          activeVoices.delete(voice);
        },
      };
      activeVoices.add(voice);
      oscillator.onended = voice.disconnect;
      oscillator.type = note.waveform;
      const start = now + note.start;
      const end = start + note.duration;
      oscillator.frequency.setValueAtTime(note.frequency, start);
      if (note.endFrequency) oscillator.frequency.exponentialRampToValueAtTime(note.endFrequency, end);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(note.peak, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, end - 0.008);
      gain.gain.linearRampToValueAtTime(0, end);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start(start);
      oscillator.stop(end);
    }
  } catch {
    stopPuzzleFeedbackAudio();
  }
};

/** Replaces any unfinished cue, so rapid answers and line rewards cannot stack volume. */
export const playPuzzleFeedback = (kind: PuzzleFeedbackKind, enabled = true): void => {
  stopPuzzleFeedbackAudio();
  if (!enabled) return;
  const audio = getContext();
  if (!audio) return;
  const revision = playbackRevision;
  if (audio.state === 'suspended') {
    try {
      void audio.resume().then(() => {
        if (revision === playbackRevision && audio.state === 'running') scheduleFeedback(audio, kind);
      }).catch(() => {});
    } catch { /* A blocked autoplay request must not interrupt the game. */ }
  } else if (audio.state === 'running') {
    scheduleFeedback(audio, kind);
  }
};
