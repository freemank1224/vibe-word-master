/**
 * Unit tests for the vertical-drop rework pure logic (services/wordStrike.ts
 * §4.5/§4.7): deterministic spawn columns across the fall zone, the constant
 * brick-speed ramp, the fully-visible spawn height, and aim lead toward a
 * falling target.
 *
 * Pure module: no matter-js / DOM APIs, runs under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getWordStrikeSpawnColumnX,
  getWordStrikeSpawnColumnSlot,
  WORD_STRIKE_COLUMN_SLOTS,
  WORD_STRIKE_ZONE_X,
  WORD_STRIKE_SPAWN_CENTER_Y,
  getWordStrikeBrickSpeed,
  getWordStrikeAimAngle,
  getWordStrikeSpritePaths,
  getWordStrikeUnitSize,
  hashBrickIndex,
} from '../../services/wordStrike.ts';

const WORLD = 900;

// ----------------------------------------------------------------
// hashBrickIndex
// ----------------------------------------------------------------

test('hashBrickIndex is deterministic and well spread across 4 columns', () => {
  for (let i = 0; i < 100; i += 1) {
    assert.equal(hashBrickIndex(i), hashBrickIndex(i));
  }
  const seen = new Set<number>();
  for (let i = 0; i < 60; i += 1) seen.add(hashBrickIndex(i) % WORD_STRIKE_COLUMN_SLOTS);
  assert.ok(seen.size >= 3, `expected >=3 distinct columns, got ${seen.size}`);
});

// ----------------------------------------------------------------
// getWordStrikeSpawnColumnSlot
// ----------------------------------------------------------------

test('spawn slot is always one of the four column slots', () => {
  for (let index = 0; index <= 200; index += 1) {
    const slot = getWordStrikeSpawnColumnSlot(index);
    assert.ok(
      Number.isInteger(slot) && slot >= 0 && slot < WORD_STRIKE_COLUMN_SLOTS,
      `index=${index} slot=${slot} out of range`
    );
  }
});

test('first brick uses the teaching column slot', () => {
  assert.equal(getWordStrikeSpawnColumnSlot(0), 2);
});

test('consecutive bricks never share a column slot', () => {
  for (let index = 1; index <= 60; index += 1) {
    const prev = getWordStrikeSpawnColumnSlot(index - 1);
    const curr = getWordStrikeSpawnColumnSlot(index);
    assert.notEqual(curr, prev, `bricks ${index - 1}/${index} share slot=${curr}`);
  }
});

test('spawn slot is deterministic', () => {
  for (let index = 1; index < 20; index += 1) {
    const first = getWordStrikeSpawnColumnSlot(index);
    for (let k = 0; k < 100; k += 1) {
      assert.equal(getWordStrikeSpawnColumnSlot(index), first);
    }
  }
});

test('short rounds visit at least 3 distinct column slots', () => {
  const seen = new Set<number>();
  for (let index = 1; index <= 12; index += 1) {
    seen.add(getWordStrikeSpawnColumnSlot(index));
  }
  assert.ok(seen.size >= 3, `expected >=3 distinct slots, got ${seen.size}`);
});

// ----------------------------------------------------------------
// getWordStrikeSpawnColumnX (vertical-drop spawn)
// ----------------------------------------------------------------

test('spawn X keeps the WHOLE bar inside the fall zone for any word length', () => {
  const zoneWidth = WORD_STRIKE_ZONE_X.max - WORD_STRIKE_ZONE_X.min;
  for (let len = 2; len <= 14; len += 1) {
    const unitSize = getWordStrikeUnitSize(len, WORLD);
    const barWidth = len * unitSize;
    // Longest chain must physically fit the zone (fully-visible guarantee).
    assert.ok(barWidth <= zoneWidth, `len=${len} bar ${barWidth}px exceeds zone ${zoneWidth}px`);
    for (let index = 0; index < 24; index += 1) {
      const x = getWordStrikeSpawnColumnX(index, barWidth);
      assert.ok(x - barWidth / 2 >= WORD_STRIKE_ZONE_X.min - 1e-9, `len=${len} index=${index} left edge ${x - barWidth / 2}`);
      assert.ok(x + barWidth / 2 <= WORD_STRIKE_ZONE_X.max + 1e-9, `len=${len} index=${index} right edge ${x + barWidth / 2}`);
      // Deterministic — no hidden randomness.
      assert.equal(getWordStrikeSpawnColumnX(index, barWidth), x);
    }
  }
});

test('spawn center Y keeps the whole chain on-screen at materialization', () => {
  assert.equal(WORD_STRIKE_SPAWN_CENTER_Y, 130);
  for (let len = 2; len <= 14; len += 1) {
    const unitSize = getWordStrikeUnitSize(len, WORLD);
    assert.ok(WORD_STRIKE_SPAWN_CENTER_Y - unitSize / 2 >= 0, `len=${len} chain top off-screen`);
  }
});

// ----------------------------------------------------------------
// getWordStrikeBrickSpeed
// ----------------------------------------------------------------

test('brick speed starts at the gentle base and ramps monotonically', () => {
  assert.equal(getWordStrikeBrickSpeed(0), 0.8);
  // Strict ramp only up to the cap (0.8 + 0.04·i reaches 2.2 at brick 35).
  for (let index = 1; index <= 30; index += 1) {
    assert.ok(
      getWordStrikeBrickSpeed(index) > getWordStrikeBrickSpeed(index - 1),
      `speed not increasing at index=${index}`
    );
  }
  assert.equal(getWordStrikeBrickSpeed(100), 2.2);
  assert.equal(getWordStrikeBrickSpeed(1000), 2.2);
});

// ----------------------------------------------------------------
// getWordStrikeAimAngle
// ----------------------------------------------------------------

test('aim angle: straight right, and coincident fallback to straight right', () => {
  assert.equal(getWordStrikeAimAngle(150, 490, 700, 490), 0);
  assert.equal(getWordStrikeAimAngle(150, 490, 150, 490), 0);
  assert.equal(getWordStrikeAimAngle(150, 490, 150, 140), -Math.PI / 2);
});

test('aim angle leads a falling target (aims below the raw bearing)', () => {
  const raw = Math.atan2(500 - 0, 500 - 0);
  const led = getWordStrikeAimAngle(0, 0, 500, 500, 0, 1.5);
  assert.ok(led > raw, `led=${led} should be > raw=${raw}`);
  // Lead stays sane: still pointing down-right, never past horizontal.
  assert.ok(led > 0 && led < Math.PI / 2);
});

test('aim angle lead is bounded and finite across the fall zone and heights', () => {
  for (let targetY = 120; targetY <= 540; targetY += 60) {
    for (let dist = 150; dist <= 800; dist += 100) {
      const angle = getWordStrikeAimAngle(150, 400, 150 + dist, targetY, 0, 1.5);
      assert.ok(Number.isFinite(angle));
      assert.ok(angle >= -Math.PI / 2 - 1e-9, `y=${targetY} dist=${dist} angle=${angle}`);
      assert.ok(angle <= Math.PI / 2 + 1e-9, 'angle in plausible range');
    }
  }
});

// ----------------------------------------------------------------
// sprite paths
// ----------------------------------------------------------------

test('sprite paths follow the daily strike naming scheme', () => {
  const paths = getWordStrikeSpritePaths(3);
  assert.deepEqual(paths, {
    idle: '/monsterImages/strike/M3_idle.webp',
    shoot: '/monsterImages/strike/M3_shoot.webp',
    hurt: '/monsterImages/strike/M3_hurt.webp',
    cheer: '/monsterImages/strike/M3_cheer.webp',
  });
});
