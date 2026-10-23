import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPuzzleFeedbackNotes, playPuzzleFeedback, stopPuzzleFeedbackAudio, unlockPuzzleFeedbackAudio,
  type PuzzleFeedbackKind,
} from '../../utils/puzzleFeedback.ts';

const kinds: PuzzleFeedbackKind[] = ['correct', 'wrong', 'line', 'complete'];

test('all feedback leaves room for the next spoken word and cannot clip when its notes overlap', () => {
  for (const kind of kinds) {
    const notes = getPuzzleFeedbackNotes(kind);
    assert.ok(notes.length > 0);
    assert.ok(Math.max(...notes.map(note => note.start + note.duration)) <= 0.4, `${kind} stays brief`);
    assert.ok(notes.reduce((sum, note) => sum + note.peak, 0) <= 0.12, `${kind} stays quiet even at maximum overlap`);
    assert.ok(notes.every(note => note.peak > 0 && note.frequency > 0 && note.duration > 0.016));
  }
});

test('a mistake uses a soft falling tone; progress and completion have distinct ascending rewards', () => {
  const wrong = getPuzzleFeedbackNotes('wrong');
  assert.equal(wrong.length, 1);
  assert.ok(wrong[0].endFrequency! < wrong[0].frequency);
  assert.equal(wrong[0].waveform, 'triangle');
  for (const kind of ['correct', 'line', 'complete'] as const) {
    const notes = getPuzzleFeedbackNotes(kind);
    assert.ok(notes.every((note, index) => index === 0 || note.frequency > notes[index - 1].frequency));
  }
  assert.equal(new Set(kinds.map(kind => JSON.stringify(getPuzzleFeedbackNotes(kind)))).size, kinds.length);
});

test('server rendering and browsers without Web Audio can still answer safely', () => {
  assert.doesNotThrow(() => {
    for (const kind of kinds) playPuzzleFeedback(kind);
    unlockPuzzleFeedbackAudio();
    stopPuzzleFeedbackAudio();
  });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  try {
    assert.doesNotThrow(() => playPuzzleFeedback('correct'));
    assert.doesNotThrow(() => unlockPuzzleFeedbackAudio());
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('muting neither accesses the audio device nor asks the browser for autoplay permission', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let audioAccesses = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { get AudioContext() { audioAccesses += 1; throw new Error('Audio device must stay unopened'); } },
  });
  try {
    for (const kind of kinds) playPuzzleFeedback(kind, false);
    unlockPuzzleFeedbackAudio(false);
    assert.equal(audioAccesses, 0);
    assert.doesNotThrow(() => playPuzzleFeedback('correct', true));
    assert.equal(audioAccesses, 1, 'A denied audio device degrades safely when feedback is enabled');
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('leaving during autoplay unlock cancels the cue, and replacing or finishing a cue releases its audio nodes', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const parameter = { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} };
  const oscillators: Array<{ onended: (() => void) | null; stops: number; disconnections: number }> = [];
  const gains: Array<{ disconnections: number }> = [];
  let releaseResume!: () => void;
  let fixture!: FakeAudioContext;
  class FakeAudioContext {
    state: AudioContextState = 'suspended';
    currentTime = 10;
    destination = {};
    constructor() { fixture = this; }
    resume() {
      return new Promise<void>(resolve => {
        releaseResume = () => { this.state = 'running'; resolve(); };
      });
    }
    createOscillator() {
      const oscillator = {
        onended: null as (() => void) | null, stops: 0, disconnections: 0,
        type: 'sine', frequency: parameter, connect() {}, start() {},
        stop() { this.stops += 1; }, disconnect() { this.disconnections += 1; },
      };
      oscillators.push(oscillator);
      return oscillator;
    }
    createGain() {
      const gain = { gain: parameter, disconnections: 0, connect() {}, disconnect() { this.disconnections += 1; } };
      gains.push(gain);
      return gain;
    }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext: FakeAudioContext } });
  try {
    playPuzzleFeedback('line');
    stopPuzzleFeedbackAudio();
    releaseResume();
    await Promise.resolve();
    assert.equal(oscillators.length, 0, 'A cancelled autoplay request must not play after leaving the game');

    playPuzzleFeedback('complete');
    const rewardVoices = oscillators.length;
    assert.ok(rewardVoices > 0);
    playPuzzleFeedback('wrong');
    assert.ok(oscillators.slice(0, rewardVoices).every(voice => voice.stops >= 2 && voice.disconnections === 1));
    assert.ok(gains.slice(0, rewardVoices).every(gain => gain.disconnections === 1));
    for (const voice of oscillators) voice.onended?.();
    assert.ok(oscillators.every(voice => voice.onended === null && voice.disconnections === 1));
    assert.ok(gains.every(gain => gain.disconnections === 1));
  } finally {
    stopPuzzleFeedbackAudio();
    fixture.state = 'closed';
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
