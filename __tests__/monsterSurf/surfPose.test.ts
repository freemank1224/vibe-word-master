import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseSurfPose, smoothSurfHeading, SURF_POSE_INDEX } from '../../features/monster-surf/surfPose.ts';

test('steering selects real carve frames and holds its pose through small velocity fluctuations', () => {
  assert.equal(chooseSurfPose('surfing', -39), 'left');
  assert.equal(chooseSurfPose('surfing', -25, 'left'), 'left');
  assert.equal(chooseSurfPose('surfing', -25, 'straight'), 'straight');
  assert.equal(chooseSurfPose('surfing', -15, 'left'), 'straight');
  assert.equal(chooseSurfPose('surfing', 39, 'left'), 'right');
  assert.equal(chooseSurfPose('surfing', 25, 'right'), 'right');
  assert.equal(chooseSurfPose('surfing', 15, 'right'), 'straight');
});

test('reward and injury frames override steering, and ready always shows its surf crouch', () => {
  assert.equal(chooseSurfPose('cleared', -250, 'left'), 'celebrate');
  assert.equal(chooseSurfPose('hurt', 250, 'right'), 'hurt');
  assert.equal(chooseSurfPose('sinking', 250), 'fall');
  assert.equal(chooseSurfPose('over', -250), 'fall');
  assert.equal(chooseSurfPose('ready', -250, 'left'), 'straight');
  assert.deepEqual(Object.values(SURF_POSE_INDEX), [0, 1, 2, 3, 4, 5]);
});

test('heading damping is frame-rate independent and remains still while the game is paused', () => {
  const once = smoothSurfHeading(0, 240, 100);
  let split = 0;
  for (let i = 0; i < 10; i += 1) split = smoothSurfHeading(split, 240, 10);
  assert.ok(Math.abs(once - split) < 1e-10);
  assert.ok(once > 0 && once < 240);
  assert.equal(smoothSurfHeading(once, -240, 0), once);
  assert.equal(smoothSurfHeading(once, NaN, 20), once);
});
