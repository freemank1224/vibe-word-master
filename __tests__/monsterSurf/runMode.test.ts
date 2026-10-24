import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SURF_RUN_MODE, initialAudioWordCount, isSurfRunMode, modeFromSlider, modeToSlider, modeWordLimit } from '../../features/monster-surf/runMode.ts';

test('slider covers every fixed count10–50 and only its final stop selects Endless', () => {
  for (let count = 10; count <= 50; count++) {
    assert.deepEqual(modeFromSlider(count), { kind: 'fixed', wordCount: count });
    assert.equal(modeToSlider(modeFromSlider(count)), count);
    assert.equal(modeWordLimit(modeFromSlider(count)), count);
  }
  assert.deepEqual(modeFromSlider(51), { kind: 'endless' });
  assert.equal(modeWordLimit(modeFromSlider(51)), Infinity);
  assert.equal(modeToSlider({ kind: 'endless' }), 51);
  assert.deepEqual(DEFAULT_SURF_RUN_MODE, { kind: 'fixed', wordCount: 20 });
});

test('fixed and legacy runs prepare all remaining recordings, Endless prepares only first20', () => {
  assert.equal(initialAudioWordCount({ kind: 'fixed', wordCount: 50 }, 50), 50);
  assert.equal(initialAudioWordCount({ kind: 'fixed', wordCount: 20 }, 7), 7);
  assert.equal(initialAudioWordCount({ kind: 'endless' }, 1200), 20);
  assert.equal(initialAudioWordCount({ kind: 'endless' }, 5), 5);
  assert.equal(initialAudioWordCount(null, 100), 100);
});

test('untrusted stored modes must have a supported kind and integer fixed count', () => {
  for (const value of [null, 10, [], {}, { kind: 'loop' }, { kind: 'fixed', wordCount: '20' }, { kind: 'fixed', wordCount: 9 }, { kind: 'fixed', wordCount: 51 }, { kind: 'fixed', wordCount: 20.5 }]) {
    assert.equal(isSurfRunMode(value), false);
  }
  assert.equal(isSurfRunMode({ kind: 'endless' }), true);
  assert.equal(isSurfRunMode({ kind: 'fixed', wordCount: 10 }), true);
});
