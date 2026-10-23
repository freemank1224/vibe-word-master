/**
 * Physics-world regression guards (utils/wordStrikePhysics.ts).
 *
 * Two invariants that once broke together as "the brick vanished after a
 * typo": a SOLID bullet dumps its 26px/step momentum into the struck unit,
 * and because units run frictionAir exactly 0 that sideways drift never
 * decays — the surviving bar sails out of the un-walled right edge. Bullets
 * must be sensors (hit detection is event-based anyway) and a right wall
 * must cap the screen edge so the whole bar always stays visible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { WordStrikePhysics } from '../../utils/wordStrikePhysics.ts';

const makePhysics = () =>
  new WordStrikePhysics({
    onBulletHit: () => {},
    onBrickReachedGround: () => {},
  });

interface WorldView {
  world: Matter.World;
}

test('bullets are sensors: a hit must never transfer momentum into the bar', () => {
  const physics = makePhysics();
  physics.spawnBrick('cat', 'w0', { centerX: 600, y: 200, unitSize: 39 });
  const bullet = physics.fireBullet(0, 240);
  assert.equal(bullet.isSensor, true, 'bullet body must be a sensor');
  physics.clearBrick();
  physics.destroy();
});

test('side walls cap at the exact screen edges so the whole bar stays visible', () => {
  const physics = makePhysics();
  const { world } = physics as unknown as WorldView;
  const walls = Matter.Composite.allBodies(world).filter((b) => b.label === 'wall');
  assert.ok(
    walls.some((b) => b.bounds.min.x === 900),
    'expected a right wall whose visible edge is exactly x=900'
  );
  assert.ok(
    walls.some((b) => b.bounds.max.x === 0),
    'expected a left wall whose visible edge is exactly x=0'
  );
  physics.destroy();
});
