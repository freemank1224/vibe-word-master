import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurfState } from '../../features/monster-surf/game.ts';
import { createSeaMonsterRenderer, seaChaseCameraOffset, seaNavigationCameraOffset } from '../../features/monster-surf/seaMonsterRenderer.ts';
import { INKFIN_CROPS } from '../../features/monster-surf/seaMonsterArt.ts';
import type { SurfState } from '../../features/monster-surf/types.ts';

// Layout checks use the production actor's prepare step, without a browser or a mock game engine.
const context = {} as CanvasRenderingContext2D;
const chaseState = (): SurfState => ({ ...createSurfState(), phase: 'surfing', elapsedMs: 9000,
  correct: 10, chase: { ...createSurfState().chase, phase: 'chasing', phaseMs: 3000 } });
const viewport = (width = 1366, height = 596) => ({ width, height, heroX: width * 0.5, heroY: height * 0.57 });

test('the whole sea creature remains visible below the HUD on every supported desktop size', () => {
  for (const [width, height] of [[1366, 596], [1440, 728], [1920, 908]]) {
    const actor = createSeaMonsterRenderer(context);
    const view = viewport(width, height);
    for (const elapsedMs of [9000, 9500, 10000]) {
      const state = { ...chaseState(), elapsedMs };
      const frame = actor.prepare(state, view, false)!;
      const crop = INKFIN_CROPS[frame.pose];
      assert.ok(frame.top >= (width >= 1900 ? 214 : 208), `${width}: sprite top ${frame.top}`);
      assert.ok(frame.y < view.heroY, `${width}: waterline remains behind the surfer`);
      assert.ok(frame.x - crop.anchorX * frame.scale >= 0);
      assert.ok(frame.x + (crop.width - crop.anchorX) * frame.scale <= width);
      assert.ok(frame.top + crop.height * frame.scale <= height);
    }
  }
});

test('paused simulation freezes pose, paddle cycle and all follower motion', () => {
  const actor = createSeaMonsterRenderer(context);
  const state = chaseState();
  actor.prepare(state, viewport(), false);
  const moved = { ...state, elapsedMs: 9100, x: 550 };
  const frame = actor.prepare(moved, { ...viewport(), heroX: 751.3 }, false);
  const paused = { ...moved, phase: 'paused' as const, resumePhase: 'surfing' as const };
  assert.deepEqual(actor.prepare(paused, { ...viewport(), heroX: 751.3 }, false), frame);
  assert.deepEqual(actor.prepare(paused, { ...viewport(), heroX: 751.3 }, false), frame);
});

test('five-word retreat and third-mistake attack produce distinct staging, and dormant is hidden', () => {
  const actor = createSeaMonsterRenderer(context);
  const state = chaseState();
  const view = viewport();
  assert.equal(actor.prepare(createSurfState(), view, false), null);
  const attack = { ...state, phase: 'sinking' as const, chase: { ...state.chase,
    phase: 'attacking' as const, mistakes: 3, phaseMs: 0 } };
  const coil = actor.prepare(attack, view, false)!;
  assert.equal(coil.pose, 'close'); assert.equal(coil.foreground, false);
  const hit = actor.prepare({ ...attack, elapsedMs: 10000, chase: { ...attack.chase, phaseMs: 1000 } }, view, false)!;
  assert.equal(hit.pose, 'attack'); assert.equal(hit.foreground, true);
  assert.ok(Math.abs(hit.x - view.heroX) < 12, 'tentacles reach the board before sinking');
  const retreat = actor.prepare({ ...state, elapsedMs: 11000, chase: { ...state.chase,
    phase: 'retreating', phaseMs: 1200, escapeStreak: 5 } }, view, false)!;
  assert.equal(retreat.pose, 'retreat'); assert.ok(retreat.opacity < 1); assert.ok(retreat.submerged > 0);
  assert.equal(actor.prepare({ ...state, chase: { ...state.chase, phase: 'escaped' } }, view, false), null);
});

test('reduced motion retains readable threat stages without bobbing or rotating', () => {
  const actor = createSeaMonsterRenderer(context);
  const state = chaseState();
  const frame = actor.prepare(state, viewport(), true)!;
  assert.equal(frame.pose, 'emerge'); assert.equal(frame.bob, 0); assert.equal(frame.angle, 0); assert.equal(frame.stroke, 0);
  const close = actor.prepare({ ...state, chase: { ...state.chase, mistakes: 2 } }, viewport(), true)!;
  assert.equal(close.pose, 'close');
});


test('short-screen camera gently opens a real rear corridor and never jumps back after escape', () => {
  const chase = chaseState().chase;
  assert.equal(seaChaseCameraOffset(596, { ...chase, phase: 'dormant' }), 0);
  assert.equal(seaChaseCameraOffset(596, { ...chase, phase: 'warning', phaseMs: 0 }), 0);
  const halfway = seaChaseCameraOffset(596, { ...chase, phase: 'warning', phaseMs: 500 });
  assert.equal(halfway, 27);
  const offset = seaChaseCameraOffset(596, chase);
  assert.equal(offset, 54);
  assert.equal(seaChaseCameraOffset(596, { ...chase, phase: 'escaped' }), offset);
  assert.equal(seaChaseCameraOffset(728, chase), 0);
  const view = viewport(); view.heroY += offset;
  const frame = createSeaMonsterRenderer(context).prepare(chaseState(), view, false)!;
  assert.ok(view.heroY - frame.y > 50, 'visible sea creature follows above the board rather than alongside it');
});

test('detour camera fits the actor without stealing all water ahead or snapping back after escape', () => {
  const offset = seaNavigationCameraOffset(1316, 594, 392.58, 156, 0);
  assert.equal(offset, 60);
  assert.equal(seaNavigationCameraOffset(1316, 594, 392.58, 250, offset), offset);
  assert.equal(seaNavigationCameraOffset(1316, 594, 392.58, undefined, offset), offset);
  const capped = seaNavigationCameraOffset(1316, 594, 392.58, -400, offset);
  assert.equal(594 - 392.58 - capped, 110, 'leave visible water in front of the board');
  assert.equal(seaNavigationCameraOffset(1316, 594, 392.58, 156, offset), offset, 'a repeated paused projection is unchanged');
});
