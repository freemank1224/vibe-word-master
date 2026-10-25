import test from 'node:test';
import assert from 'node:assert/strict';
import { startSurf, tickSurf } from '../../features/monster-surf/game.ts';
import { createSurfRenderer } from '../../features/monster-surf/renderer.ts';
import { SURF_BASE_SPEED, SURF_MAX_VISIBLE_GULLS, surfMagnetMultiplier, surfMagnetRadius, surfSpeedMultiplier } from '../../features/monster-surf/constants.ts';

test('2500 correct words keep Endless physics finite and collect the entire active sea', () => {
  // Isolate long-running course generation and magnet arithmetic from injury
  // termination. A retained correct prefix no longer grants automatic steering.
  let state = { ...startSurf(), correct: 2500, speed: SURF_BASE_SPEED * surfSpeedMultiplier(2500), invulnerableMs: 100_000 };
  const initialCrystals = state.items.filter(item => item.collectedAt === null).length;
  state = tickSurf(state, 16);
  assert.equal(state.coins, initialCrystals);
  for (let index = 0; index < 60; index++) {
    state = tickSurf(state, 1000);
    for (const value of [state.x, state.vx, state.distance, state.speed, state.score, state.coins,
      surfMagnetMultiplier(state.correct), surfMagnetRadius(state.correct)]) assert.ok(Number.isFinite(value));
    assert.equal(state.x, 500);
    assert.equal(state.vx, 0);
    assert.ok(state.items.length <= 210);
    assert.ok(state.obstacles.length <= 28);
  }
  assert.equal(state.correct, 2500);
});

test('long-run renderer keeps32 birds on screen with finite drawing coordinates and a new arrival each word', () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { devicePixelRatio: 1 } });
  const gull = { complete: true, naturalWidth: 2200 } as HTMLImageElement;
  let birdDraws = 0;
  const birdPositions: number[][] = [];
  let lastTranslation: number[] = [];
  const context = new Proxy({} as CanvasRenderingContext2D, {
    get(_target, property) {
      if (property === 'createLinearGradient' || property === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (property === 'measureText') return (label: string) => ({ width: label.length * 8 });
      return (...args: unknown[]) => {
        for (const arg of args) if (typeof arg === 'number') assert.ok(Number.isFinite(arg), `${String(property)} received ${arg}`);
        if (property === 'translate') lastTranslation = args as number[];
        if (property === 'drawImage' && args[0] === gull) { birdDraws++; birdPositions.push(lastTranslation); }
      };
    },
    set: () => true,
  });
  const canvas = {
    dataset: {} as Record<string, string>, width: 0, height: 0,
    getContext: () => context, getBoundingClientRect: () => ({ width: 1318, height: 596 }),
  } as unknown as HTMLCanvasElement;
  const renderer = createSurfRenderer(canvas, [], undefined, gull);
  try {
    const state = { ...startSurf(), correct: 2500, elapsedMs: 50_000 };
    renderer.render(state, false);
    assert.equal(birdDraws, SURF_MAX_VISIBLE_GULLS);
    assert.equal(canvas.dataset.gullEarnedCount, '2500');
    assert.equal(canvas.dataset.gullVisibleCount, '32');
    birdDraws = 0; birdPositions.length = 0;
    renderer.render({ ...state, elapsedMs: 52_000 }, false);
    assert.equal(birdDraws, SURF_MAX_VISIBLE_GULLS);
    assert.equal(birdPositions.filter(([x]) => x > 1318).length, 0, 'initial arrivals finish their fly-in');
    birdDraws = 0; birdPositions.length = 0;
    renderer.render({ ...state, correct: 2501, elapsedMs: 52_016 }, false);
    assert.equal(birdDraws, SURF_MAX_VISIBLE_GULLS);
    assert.equal(birdPositions.filter(([x]) => x > 1318).length, 1, 'a fresh bird flies in after the next correct answer');
    assert.equal(canvas.dataset.gullEarnedCount, '2501');
    assert.equal(state.correct, 2500, 'rendering never changes earned gameplay state');
  } finally {
    renderer.destroy();
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
