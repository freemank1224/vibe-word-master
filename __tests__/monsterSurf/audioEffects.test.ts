import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { SurfAudio } from '../../features/monster-surf/audio.ts';

class FakeParam {
  values: number[] = [];
  setValueAtTime(value: number) { this.values.push(value); }
  linearRampToValueAtTime(value: number) { this.values.push(value); }
  exponentialRampToValueAtTime(value: number) { this.values.push(value); }
}

class FakeNode {
  disconnected = false;
  connect<T extends FakeNode>(target: T): T { return target; }
  disconnect() { this.disconnected = true; }
}

class FakeOscillator extends FakeNode {
  frequency = new FakeParam();
  type = '';
  onended: (() => void) | null = null;
  cancelled = false;
  start() {}
  stop(at?: number) { if (at === undefined) this.cancelled = true; }
}

class FakeGain extends FakeNode { gain = new FakeParam(); }
class FakeFilter extends FakeNode { frequency = new FakeParam(); type = ''; }

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  class FakeContext {
    currentTime = 0;
    state = 'running';
    destination = new FakeNode();
    sampleRate = 8000;
    gains: FakeGain[] = [];
    sources: FakeOscillator[] = [];
    oscillators: FakeOscillator[] = [];
    createOscillator() {
      const oscillator = new FakeOscillator();
      this.oscillators.push(oscillator);
      return oscillator;
    }
    createGain() { const gain = new FakeGain(); this.gains.push(gain); return gain; }
    createBuffer(_channels: number, size: number) { return { getChannelData: () => new Float32Array(size) }; }
    createBufferSource() { const source = new FakeOscillator(); this.sources.push(source); return source; }
    createBiquadFilter() { return new FakeFilter(); }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  const context = new FakeContext();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { AudioContext: class { constructor() { return context; } } },
  });
  const audio = new SurfAudio();
  audio.unlock();
  const advance = (milliseconds: number) => {
    context.currentTime += milliseconds / 1000;
    t.mock.timers.tick(milliseconds);
  };
  t.after(() => {
    audio.destroy();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  return { audio, context, advance };
}

test('dense coin pickups share a bounded chime instead of creating one sound per coin', t => {
  const { audio, context, advance } = fixture(t);
  audio.play('coin', 24);
  assert.equal(context.oscillators.length, 3);
  for (let i = 0; i < 20; i++) audio.play('coin', 2);
  assert.equal(context.oscillators.length, 3);
  advance(139);
  assert.equal(context.oscillators.length, 3);
  advance(1);
  assert.equal(context.oscillators.length, 6);
  advance(1000);
  assert.equal(context.oscillators.length, 6);
});

test('consecutive pickups rise in pitch while a new collection starts a fresh phrase', t => {
  const { audio, context, advance } = fixture(t);
  audio.play('coin');
  const first = context.oscillators[0].frequency.values[0];
  advance(150);
  audio.play('coin');
  assert.ok(context.oscillators[1].frequency.values[0] > first);
  advance(600);
  audio.play('coin');
  assert.equal(context.oscillators[2].frequency.values[0], first);
});

test('muting cancels pending and active coin effects without replaying a stale batch after unmute', t => {
  const { audio, context, advance } = fixture(t);
  audio.play('coin');
  audio.play('coin', 30);
  audio.effectsEnabled = false;
  assert.ok(context.oscillators.every(source => source.cancelled && source.disconnected));
  advance(1000);
  assert.equal(context.oscillators.length, 1);
  audio.effectsEnabled = true;
  audio.play('coin');
  assert.equal(context.oscillators.length, 2);
});

test('pause and destruction discard scheduled pickup chimes', t => {
  const { audio, context, advance } = fixture(t);
  audio.play('coin');
  audio.play('coin', 12);
  audio.stopEffects();
  advance(500);
  assert.equal(context.oscillators.length, 1);
  audio.play('coin');
  audio.play('coin', 12);
  audio.destroy();
  advance(500);
  audio.play('coin', 12);
  assert.equal(context.oscillators.length, 2);
  assert.equal(context.state, 'closed');
  assert.ok(context.oscillators.every(source => source.cancelled && source.disconnected));
});


test('sea chase events have distinct short cues and third-mistake attack adds a splash', t => {
  const { audio, context } = fixture(t);
  audio.play('sea-warning');
  assert.deepEqual(context.oscillators.map(node => node.frequency.values[0]), [196, 147, 196]);
  const warning = [...context.oscillators];
  audio.play('sea-approach');
  assert.ok(warning.every(node => node.cancelled));
  assert.deepEqual(context.oscillators.slice(3).map(node => node.frequency.values[0]), [220, 174]);
  assert.equal(context.sources.length, 0, 'following and approaching do not play an attack splash');
  audio.play('sea-attack');
  assert.deepEqual(context.oscillators.slice(5).map(node => node.frequency.values[0]), [110, 73, 55]);
  assert.equal(context.sources.length, 1);
  audio.play('sea-escape');
  assert.deepEqual(context.oscillators.slice(8).map(node => node.frequency.values[0]), [523, 659, 784, 1046, 1318]);
  audio.stopEffects();
  assert.ok(context.oscillators.every(node => node.cancelled && node.disconnected));
  assert.ok(context.sources.every(node => node.cancelled && node.disconnected));
});

test('chase sounds duck under spoken dictation without cancelling it', async t => {
  const { audio, context } = fixture(t);
  let speechPaused = 0;
  class FakeAudio {
    onplaying: (() => void) | null = null;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    preload = ''; playbackRate = 1; preservesPitch = true;
    play() { this.onplaying?.(); return Promise.resolve(); }
    pause() { speechPaused++; }
    removeAttribute() {}
    load() {}
  }
  Object.assign(window, { Audio: FakeAudio });
  audio.play('sea-warning');
  const peakWithoutSpeech = Math.max(...context.gains[0].gain.values);
  await audio.speak('ocean');
  audio.play('sea-warning');
  const peakWithSpeech = Math.max(...context.gains[3].gain.values);
  assert.ok(peakWithSpeech < peakWithoutSpeech * 0.5);
  audio.play('sea-attack');
  assert.equal(speechPaused, 0);
  audio.effectsEnabled = false;
  assert.equal(speechPaused, 0, 'muting sea effects leaves dictation playing');
  const before = context.oscillators.length;
  audio.play('sea-escape');
  assert.equal(context.oscillators.length, before);
});
