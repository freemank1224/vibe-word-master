import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { SurfAudio } from '../../features/monster-surf/audio.ts';

class FakeUtterance {
  text: string;
  lang = '';
  rate = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) { this.text = text; }
}

const english = { name: 'English', lang: 'en-US', localService: true, default: false } as SpeechSynthesisVoice;

function fixture(t: TestContext, useAudio = true) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const elements: FakeAudio[] = [];
  class FakeAudio {
    src: string;
    playbackRate = 1;
    preservesPitch = false;
    paused = false;
    onplaying: (() => void) | null = null;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(src: string) { this.src = src; elements.push(this); }
    play() { return Promise.resolve(); }
    pause() { this.paused = true; }
    load() {}
    removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  }
  class Synth extends EventTarget {
    voices: SpeechSynthesisVoice[] = [english];
    spoken: FakeUtterance[] = [];
    cancelled = 0;
    paused = false;
    getVoices() { return this.voices; }
    speak(utterance: FakeUtterance) { this.spoken.push(utterance); }
    cancel() { this.cancelled++; }
    resume() { this.paused = false; }
  }
  const synth = new Synth();
  Object.defineProperty(globalThis, 'window', {
    configurable: true, value: {
      Audio: useAudio ? FakeAudio : undefined,
      SpeechSynthesisUtterance: FakeUtterance, speechSynthesis: synth,
    },
  });
  const audio = new SurfAudio();
  t.after(() => {
    audio.destroy();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  return { audio, synth, elements };
}

test('dictation waits for actual playing and remains audible when effects are off', async t => {
  const { audio, synth, elements } = fixture(t);
  audio.effectsEnabled = false;
  const result = audio.speak('Sun', true);
  let resolved = false;
  void result.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(elements[0].src, '/monster-surf/audio/sun.m4a');
  assert.equal(elements[0].playbackRate, 0.72);
  assert.equal(elements[0].preservesPitch, true);
  elements[0].onplaying?.();
  assert.equal(await result, true);
  assert.equal(synth.spoken.length, 0);
});

test('replay cancels the old audio and late playing events cannot restart it', async t => {
  const { audio, elements } = fixture(t);
  const old = audio.speak('sun');
  const latePlaying = elements[0].onplaying!;
  const latest = audio.speak('moon');
  assert.equal(await old, false);
  assert.equal(elements[0].paused, true);
  assert.equal(elements[0].src, '');
  latePlaying();
  audio.stopSpeech();
  assert.equal(await latest, false);
  assert.equal(elements[1].paused, true);
});

test('failed static audio falls back to an English voice and reports actual speech start', async t => {
  const { audio, synth, elements } = fixture(t);
  const result = audio.speak('cat', true);
  elements[0].onerror?.();
  assert.equal(elements[0].paused, true);
  assert.equal(synth.spoken.length, 1);
  assert.equal(synth.spoken[0].voice, english);
  assert.equal(synth.spoken[0].lang, 'en-US');
  assert.equal(synth.spoken[0].rate, 0.62);
  synth.spoken[0].onstart?.();
  assert.equal(await result, true);
  audio.stopSpeech();
  assert.equal(synth.cancelled, 1);
});

test('a missing static response cannot leave the question silently pending forever', async t => {
  const { audio, synth, elements } = fixture(t);
  const result = audio.speak('cat');
  t.mock.timers.tick(5000);
  assert.equal(elements[0].paused, true);
  assert.equal(synth.spoken.length, 1);
  t.mock.timers.tick(5000);
  assert.equal(await result, false);
  assert.equal(synth.cancelled, 1);
});

test('delayed voice enumeration selects English and ignores the non-English system default', async t => {
  const { audio, synth } = fixture(t, false);
  synth.voices = [{ name: 'Chinese', lang: 'zh-CN', default: true } as SpeechSynthesisVoice];
  const result = audio.speak('water');
  assert.equal(synth.spoken.length, 0);
  synth.voices.push(english);
  synth.dispatchEvent(new Event('voiceschanged'));
  assert.equal(synth.spoken[0].voice, english);
  synth.spoken[0].onend?.();
  assert.equal(await result, true);
});

test('pausing while voices load cancels both the wait and all later speech', async t => {
  const { audio, synth } = fixture(t, false);
  synth.voices = [];
  const result = audio.speak('sun');
  audio.stopSpeech();
  assert.equal(await result, false);
  synth.voices = [english];
  synth.dispatchEvent(new Event('voiceschanged'));
  t.mock.timers.tick(10000);
  assert.equal(synth.spoken.length, 0);
});

test('empty voice lists still permit an engine to resolve en-US lazily, but errors remain failures', async t => {
  const { audio, synth } = fixture(t, false);
  synth.voices = [];
  const result = audio.speak('sea');
  t.mock.timers.tick(900);
  assert.equal(synth.spoken[0].lang, 'en-US');
  assert.equal(synth.spoken[0].voice, null);
  synth.spoken[0].onerror?.();
  assert.equal(await result, false);
});

test('destroy cancels queued TTS, ignores late callbacks, and prevents further playback', async t => {
  const { audio, synth } = fixture(t, false);
  const result = audio.speak('sun');
  const lateStart = synth.spoken[0].onstart!;
  audio.destroy();
  lateStart();
  assert.equal(await result, false);
  assert.equal(await audio.speak('cat'), false);
  assert.equal(synth.spoken.length, 1);
  assert.equal(synth.cancelled, 1);
});

test('non-word characters never become a static resource path', async t => {
  const { audio, synth, elements } = fixture(t);
  const result = audio.speak('../cat?secret=x');
  assert.equal(elements.length, 0);
  synth.spoken[0].onerror?.();
  assert.equal(await result, false);
});
