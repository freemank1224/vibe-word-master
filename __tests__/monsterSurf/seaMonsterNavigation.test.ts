import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSeaMonsterNavigator, findSeaMonsterWaterPoint,
  type SeaMonsterPoint, type SeaMonsterFootprint,
} from '../../features/monster-surf/seaMonsterNavigation.ts';
import { courseObstacle, courseMarginObstacle } from '../../features/monster-surf/course.ts';
import type { SurfObstacle } from '../../features/monster-surf/types.ts';

const bounds = { minX: 55, maxX: 945 };
const footprint = { rx: 46, ry: 22 };
const island = (id: number, x: number, y: number, rx = 125, ry = 55, hit = false): SurfObstacle => ({ id, x, y, rx, ry, variant: 3, hit });
const length = (a: SeaMonsterPoint, b: SeaMonsterPoint) => Math.hypot(a.x - b.x, a.y - b.y);

/** Independent collision oracle: checks the complete frame chord, not just its endpoint. */
function verifyStep(from: SeaMonsterPoint, to: SeaMonsterPoint, obstacles: readonly SurfObstacle[], body = footprint, maxDistance = Infinity) {
  assert.ok(length(from, to) <= maxDistance + 1e-6, 'movement exceeds its speed budget');
  assert.ok(to.x >= bounds.minX && to.x <= bounds.maxX, 'body centre left the permitted ocean');
  for (const obstacle of obstacles) {
    const rx = obstacle.rx + body.rx;
    const ry = obstacle.ry + body.ry;
    const px = (from.x - obstacle.x) / rx;
    const py = (from.y - obstacle.y) / ry;
    const dx = (to.x - from.x) / rx;
    const dy = (to.y - from.y) / ry;
    const denominator = dx * dx + dy * dy;
    const t = denominator ? Math.max(0, Math.min(1, -(px * dx + py * dy) / denominator)) : 0;
    assert.ok((px + dx * t) ** 2 + (py + dy * t) ** 2 >= 1, `frame crossed island ${obstacle.id}`);
  }
}

test('a straight route progresses exactly by its movement budget in open water', () => {
  const navigator = createSeaMonsterNavigator();
  const position = { x: 300, y: 100 };
  const next = navigator.step({ position, target: { x: 600, y: 500 }, obstacles: [], footprint, bounds, maxDistance: 50 });
  assert.deepEqual(next.position, { x: 330, y: 140 });
  assert.equal(next.navigation, 'direct');
  assert.equal(next.blocked, false);
  assert.equal(next.clearance, Infinity);
});

test('a hit island stays solid and the full continuous route rounds it before reaching the surfer', () => {
  const obstacles = [island(1, 500, 300, 140, 62, true)];
  const navigator = createSeaMonsterNavigator();
  const target = { x: 500, y: 560 };
  let position = { x: 500, y: 40 };
  let minX = position.x; let maxX = position.x; let detours = 0;
  for (let frame = 0; frame < 240 && length(position, target) > 1e-5; frame++) {
    const next = navigator.step({ position, target, obstacles, footprint, bounds, maxDistance: 8 });
    verifyStep(position, next.position, obstacles, footprint, 8);
    assert.equal(next.blocked, false);
    assert.ok(next.clearance >= 1);
    detours += Number(next.navigation === 'detour');
    position = next.position; minX = Math.min(minX, position.x); maxX = Math.max(maxX, position.x);
  }
  assert.ok(length(position, target) < 1e-5);
  assert.ok(detours > 1);
  assert.ok(Math.min(minX - 500, 500 - maxX) < -180, 'the sea monster visibly rounds a side');
});

test('large or interrupted frame budgets never jump across a corner or tunnel through land', () => {
  const obstacles = [island(1, 500, 200), island(2, 370, 440), island(3, 640, 660)];
  const navigator = createSeaMonsterNavigator();
  const target = { x: 500, y: 900 };
  let position = { x: 500, y: 0 };
  for (let frame = 0; frame < 60 && length(position, target) > 1e-5; frame++) {
    const maxDistance = frame % 2 ? 3 : 900;
    const next = navigator.step({ position, target, obstacles, footprint, bounds, maxDistance });
    verifyStep(position, next.position, obstacles, footprint, maxDistance);
    assert.equal(next.relocated, false);
    assert.equal(next.blocked, false);
    position = next.position;
  }
  assert.ok(length(position, target) < 1e-5);
});

test('near-shore and multiple overlapping hazards keep the actor inside the water boundary', () => {
  const obstacles = [island(1, 100, 250, 130, 80), island(2, 330, 340, 140, 70), island(3, 790, 520, 165, 80)];
  const navigator = createSeaMonsterNavigator();
  const target = { x: 70, y: 750 };
  let position = { x: 75, y: 20 };
  for (let frame = 0; frame < 300 && length(position, target) > 1e-5; frame++) {
    const next = navigator.step({ position, target, obstacles, footprint, bounds, maxDistance: 12 });
    verifyStep(position, next.position, obstacles, footprint, 12);
    assert.equal(next.blocked, false);
    position = next.position;
  }
  assert.ok(length(position, target) < 1e-5);
});

test('a target inside land is projected to reachable water without relocating the chasing actor', () => {
  const obstacles = [island(1, 500, 350)];
  const navigator = createSeaMonsterNavigator();
  const target = { x: 500, y: 350 };
  let position = { x: 500, y: 0 };
  for (let frame = 0; frame < 120; frame++) {
    const next = navigator.step({ position, target, obstacles, footprint, bounds, maxDistance: 10 });
    verifyStep(position, next.position, obstacles, footprint, 10);
    assert.equal(next.relocated, false);
    assert.ok(next.clearance >= 1);
    assert.notDeepEqual(next.target, target);
    position = next.position;
  }
});

test('a moving surfer cannot make a committed detour alternate left and right each frame', () => {
  const obstacles = [island(1, 500, 300, 150, 75)];
  const navigator = createSeaMonsterNavigator();
  let position = { x: 500, y: 0 };
  let side = 0;
  for (let frame = 0; frame < 150; frame++) {
    const target = { x: 500 + (frame % 2 ? 16 : -16), y: 650 };
    const next = navigator.step({ position, target, obstacles, footprint, bounds, maxDistance: 7.5 });
    verifyStep(position, next.position, obstacles, footprint, 7.5);
    if (next.position.y < 300 && Math.abs(next.position.x - 500) > 10) {
      const currentSide = Math.sign(next.position.x - 500);
      if (!side) side = currentSide;
      assert.equal(currentSide, side, 'a changing target flipped the selected side');
    }
    position = next.position;
  }
  assert.ok(position.y > 600);
});

test('pause freezes routing and resize relocation is permitted only when explicitly requested', () => {
  const obstacles = [island(1, 500, 300)];
  const navigator = createSeaMonsterNavigator();
  const position = { x: 500, y: 300 };
  const options = { position, target: { x: 500, y: 600 }, obstacles, footprint, bounds, maxDistance: 15 };
  const frozen = navigator.step({ ...options, maxDistance: 0, allowRelocate: true });
  assert.deepEqual(frozen.position, position);
  assert.equal(frozen.relocated, false);
  const blocked = navigator.step(options);
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.position, position);
  const resized = navigator.step({ ...options, allowRelocate: true });
  assert.equal(resized.relocated, true);
  assert.ok(resized.clearance >= 1);
  const after = navigator.step({ ...options, position: resized.position, maxDistance: 0 });
  assert.deepEqual(after.position, resized.position);
  navigator.reset();
  const water = findSeaMonsterWaterPoint(position, obstacles, footprint, bounds)!;
  assert.ok(water && length(water, position) > 0);
});

test('a closed water corridor stops safely rather than teleporting across an island wall', () => {
  const obstacles = [island(1, 500, 300, 480, 100)];
  const navigator = createSeaMonsterNavigator();
  const position = { x: 500, y: 0 };
  const next = navigator.step({ position, target: { x: 500, y: 700 }, obstacles, footprint, bounds, maxDistance: 2000 });
  assert.equal(next.blocked, true);
  assert.deepEqual(next.position, position);
});

test('the real enlarged course remains navigable at maximum chase speed without crossing frame chords', () => {
  const obstacles = [
    ...Array.from({ length: 8 }, (_, id) => courseObstacle(id)),
    ...Array.from({ length: 18 }, (_, id) => courseMarginObstacle(id)),
  ];
  const navigator = createSeaMonsterNavigator();
  const target = { x: 500, y: 5900 };
  let position = { x: 500, y: 0 };
  for (let frame = 0; frame < 1300 && length(position, target) > 1e-5; frame++) {
    const maxDistance = 453.125 * (frame % 90 === 0 ? 0.2 : 1 / 60);
    const next = navigator.step({ position, target, obstacles, footprint, bounds, maxDistance });
    verifyStep(position, next.position, obstacles, footprint, maxDistance);
    assert.equal(next.blocked, false, `routing stalled at frame ${frame}`);
    position = next.position;
  }
  assert.ok(length(position, target) < 1e-5);
});
