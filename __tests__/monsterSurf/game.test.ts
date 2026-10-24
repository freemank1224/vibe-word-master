import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSurfState, startSurf, selectSurfMonster, currentSurfWord, tickSurf,
  setSurfInput, submitSurf, pauseSurf, resumeSurf, SURF_WORDS,
} from '../../features/monster-surf/game.ts';
import { SURF_BASE_SPEED, SURF_RIDER_COLLISION_RX, SURF_RIDER_COLLISION_RY,
  surfMagnetMultiplier, surfMagnetRadius, surfSpeedMultiplier } from '../../features/monster-surf/constants.ts';
import { courseObstacle, courseMarginObstacle, courseCoins, maintainSurfCourse } from '../../features/monster-surf/course.ts';
import type { SurfState } from '../../features/monster-surf/types.ts';
import { SURF_ISLAND_ART, SURF_ISLAND_SOURCE_TO_WORLD } from '../../features/monster-surf/islandArt.ts';
import { SURF_MONSTERS } from '../../features/monster-surf/monsters.ts';

const answer = (state: SurfState) => submitSurf(setSurfInput(state, currentSurfWord(state).answer));
const clearWord = (state: SurfState) => tickSurf(answer(state), 650);
const wrong = (state: SurfState) => submitSurf(setSurfInput(state, 'wrong'));

test('seven original monsters can be selected and starting resets the session', () => {
  const ready = createSurfState();
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.monster, 1);
  assert.equal(tickSurf(ready, 5_000), ready);
  assert.deepEqual(SURF_MONSTERS.map(monster => monster.id), [0, 1, 2, 3, 4, 5, 6]);
  for (const { id } of SURF_MONSTERS) {
    assert.equal(selectSurfMonster(ready, id).monster, id);
    assert.equal(startSurf(id).monster, id);
  }
  for (const id of [-1, 7, NaN, 1.5]) assert.equal(selectSurfMonster(ready, id), ready);
  assert.equal(startSurf(7).monster, 1);
  const moving = startSurf(6);
  assert.equal(selectSurfMonster(moving, 2), moving);
  assert.equal(moving.phase, 'surfing');
  assert.equal(moving.speed, SURF_BASE_SPEED);
});

test('practice words are unique, bilingual and cycle only by completed word count', () => {
  assert.ok(SURF_WORDS.length >= 20 && SURF_WORDS.length <= 30);
  assert.equal(new Set(SURF_WORDS.map(word => word.answer)).size, SURF_WORDS.length);
  for (const word of SURF_WORDS) {
    assert.match(word.answer, /^[a-z]+$/);
    assert.ok(word.meaningZh && word.meaningEn);
    assert.doesNotMatch(word.meaningEn, /\p{Script=Han}/u);
  }
  assert.equal(currentSurfWord(createSurfState()).answer, 'ocean');
  assert.equal(currentSurfWord({ ...createSurfState(), checkpoint: SURF_WORDS.length }).answer, 'ocean');
});

test('dictation is available immediately and the sea keeps moving with five safe opening seconds', () => {
  const initial = setSurfInput(startSurf(), 'oce');
  const next = tickSurf(initial, 5_000);
  assert.equal(next.phase, 'surfing');
  assert.equal(next.input, 'oce');
  assert.equal(next.hits, 0);
  assert.ok(Math.abs(next.distance - SURF_BASE_SPEED * 5) < 1e-7);
  assert.equal(next.checkpoint, 0);
  assert.notEqual(next.x, initial.x);
  assert.ok(next.coins > 0);
});

test('correct prefixes enable guidance, wrong letters lock it, and editing repairs navigation', () => {
  const initial = startSurf();
  assert.equal(initial.navigation, 'waiting');
  for (const value of ['o', 'OC', 'ｏｃｅ', ' ocean ']) {
    assert.equal(setSurfInput(initial, value).navigation, 'guided');
  }
  for (const value of ['x', 'ocx', 'oceans', 'oce an']) {
    assert.equal(setSurfInput(initial, value).navigation, 'locked');
  }
  const wrongLetter = setSurfInput(initial, 'ocx');
  assert.equal(setSurfInput(wrongLetter, 'oc').navigation, 'guided');
  assert.equal(setSurfInput(wrongLetter, '').navigation, 'waiting');
});

test('wrong prefixes hold the current heading instead of secretly avoiding hazards', () => {
  const moving = tickSurf(setSurfInput(startSurf(), 'o'), 1_000);
  assert.ok(moving.vx < 0);
  const locked = setSurfInput(moving, 'ox');
  const drifted = tickSurf(locked, 600);
  assert.equal(drifted.vx, locked.vx);
  assert.ok(Math.abs(drifted.x - locked.x - locked.vx * 0.6) < 1e-7);
  assert.equal(drifted.targetX, locked.targetX);
  assert.ok(drifted.distance > locked.distance);
  const repaired = tickSurf(setSurfInput(drifted, 'oce'), 600);
  assert.notEqual(repaired.vx, drifted.vx);
});

test('manual arrow or pointer controls cannot divert the automatic route', () => {
  const initial = setSurfInput(startSurf(), 'o');
  const automatic = tickSurf(initial, 3_000);
  assert.deepEqual(tickSurf(initial, 3_000, { steer: -1, targetX: 900 }), automatic);
  assert.deepEqual(tickSurf(initial, 3_000, { steer: NaN, targetX: Infinity }), automatic);
});

test('guidance bends toward coins and avoids the first solid island while a locked course hits it', () => {
  const first = courseObstacle(0);
  const crossingMs = (first.y - first.ry - SURF_RIDER_COLLISION_RY) / SURF_BASE_SPEED * 1000 + 200;
  const guided = tickSurf(setSurfInput(startSurf(), 'o'), crossingMs);
  const locked = tickSurf(setSurfInput(startSurf(), 'x'), crossingMs);
  assert.equal(guided.hits, 0);
  assert.ok(guided.coins > locked.coins);
  assert.equal(locked.hits, 1);
  assert.equal(locked.obstacles.find(obstacle => obstacle.id === 0)?.hit, true);
  assert.ok(locked.distance < guided.distance, 'a collision physically slows forward travel');
  assert.equal(locked.feedback, 'collision');
});

test('autopilot safely navigates diverse islands at both starting and maximum earned speed', () => {
  for (const correct of [0, 3, 8, 20]) {
    let state = setSurfInput({ ...startSurf(), correct, speed: SURF_BASE_SPEED * surfSpeedMultiplier(correct) }, 'o');
    let minX = state.x;
    let maxX = state.x;
    for (let index = 0; index < 120; index++) {
      state = tickSurf(state, 1_000);
      minX = Math.min(minX, state.x);
      maxX = Math.max(maxX, state.x);
      assert.equal(state.hits, 0, `correct ${correct}, second ${index}`);
    }
    assert.ok(maxX - minX > 200, 'course must curve through several different passages');
    assert.ok(state.coins > 60);
    assert.equal(state.phase, 'surfing');
  }
  const obstacles = Array.from({ length: 8 }, (_, id) => courseObstacle(id));
  assert.deepEqual(obstacles.map(obstacle => obstacle.variant), [3, 4, 5, 6, 7, 3, 5, 4]);
  assert.ok(new Set(obstacles.map(obstacle => obstacle.rx * obstacle.ry)).size >= 3);
});

test('shore islands appear immediately, remain collidable, and cannot hide a central navigation hazard', () => {
  const initial = startSurf();
  const shore = courseMarginObstacle(0);
  const shoreArt = SURF_ISLAND_ART[shore.variant];
  // At 1366 × 768, the near edge of the ocean is about 195 world units ahead.
  // The first island's canopy is already visible above it on the opening frame.
  assert.ok(initial.obstacles.some(obstacle => obstacle.id === shore.id));
  assert.ok(shore.y - shoreArt.anchorY * SURF_ISLAND_SOURCE_TO_WORLD < 195);
  assert.equal(new Set(initial.obstacles.map(obstacle => obstacle.id)).size, initial.obstacles.length);
  assert.ok(initial.obstacles.every((obstacle, index, list) => index === 0 || obstacle.y >= list[index - 1].y));
  const hit = tickSurf({ ...initial, x: shore.x, distance: shore.y - shore.ry - SURF_RIDER_COLLISION_RY - 4 }, 50);
  assert.equal(hit.hits, 1);
  assert.equal(hit.obstacles.find(obstacle => obstacle.id === shore.id)?.hit, true);
  const guided = tickSurf(setSurfInput(initial, 'o'), 10_000);
  assert.equal(guided.hits, 0);
  assert.ok(guided.distance > courseObstacle(0).y);
});

test('each art variant has one native collision size everywhere, with small islands reserved for shores', () => {
  const main = Array.from({ length: 64 }, (_, index) => courseObstacle(index));
  const shore = Array.from({ length: 64 }, (_, index) => courseMarginObstacle(index));
  for (const obstacle of [...main, ...shore]) {
    const art = SURF_ISLAND_ART[obstacle.variant];
    assert.equal(obstacle.rx, art.collisionRx);
    assert.equal(obstacle.ry, art.collisionRy);
  }
  assert.ok(main.every(obstacle => obstacle.variant >= 3));
  assert.ok(shore.every(obstacle => obstacle.variant <= 2));
  assert.deepEqual([...new Set(shore.map(obstacle => obstacle.variant))], [0, 1, 2]);
  const smallestMain = Math.min(...main.map(obstacle => obstacle.rx * obstacle.ry));
  const largestShore = Math.max(...shore.map(obstacle => obstacle.rx * obstacle.ry));
  assert.ok(smallestMain > largestShore, 'area differs because of the native landform, not instance scaling');
});

test('enlarged coast islands remain separate from main beaches and leave a navigable sea corridor', () => {
  const shoreGap = courseMarginObstacle(1).y - courseMarginObstacle(0).y;
  const firstShoreY = courseMarginObstacle(0).y;
  for (let id = 0; id < 1_000; id++) {
    const island = courseObstacle(id);
    const nearest = Math.round((island.y - firstShoreY) / shoreGap);
    for (let index = Math.max(0, nearest - 1); index <= nearest + 1; index++) {
      const shore = courseMarginObstacle(index);
      const clearance = ((island.x - shore.x) / (island.rx + shore.rx)) ** 2
        + ((island.y - shore.y) / (island.ry + shore.ry)) ** 2;
      assert.ok(clearance > 1, `main island ${id} overlaps shore ${index}`);
      assert.ok(Math.abs(island.y - shore.y) > island.ry + shore.ry + SURF_RIDER_COLLISION_RY * 2,
        `there must be a board-width water passage between main island ${id} and shore ${index}`);
    }
    const openSide = Math.max(island.x - island.rx, 1000 - island.x - island.rx);
    assert.ok(openSide > SURF_RIDER_COLLISION_RX * 2 + 250);
  }
  const first = courseObstacle(0);
  assert.ok((first.y - first.ry - SURF_RIDER_COLLISION_RY) / SURF_BASE_SPEED > 5);
});

test('the smaller board can skim the enlarged beach without invisible oversized collision padding', () => {
  const island = courseObstacle(0);
  const contactX = island.x + island.rx + SURF_RIDER_COLLISION_RX;
  const besideBeach = { ...startSurf(), x: contactX + 2, vx: 0, distance: island.y };
  assert.equal(tickSurf(besideBeach, 10).hits, 0, 'water beyond the reduced board footprint is safe');
  const touchingBeach = { ...besideBeach, x: contactX - 2 };
  const impacted = tickSurf(touchingBeach, 10);
  assert.equal(impacted.hits, 1, 'the outer edge of the enlarged sand is solid');
  assert.equal(impacted.feedback, 'collision');
  assert.equal(impacted.obstacles.find(obstacle => obstacle.id === island.id)?.hit, true);
});

test('seeded coin courses alternate true matrices, diamonds, arcs and fans with connecting ribbons', () => {
  const seen = new Set<string>();
  for (let section = 0; section < 5; section++) {
    const coins = courseCoins(section);
    assert.deepEqual(coins, courseCoins(section));
    assert.equal(new Set(coins.map(coin => coin.id)).size, coins.length);
    assert.ok(coins.every(coin => coin.group === section && Number.isFinite(coin.guideX)));
    assert.ok(coins.every((coin, index) => index === 0 || coin.y >= coins[index - 1].y));
    assert.equal(coins.filter(coin => coin.formation === 'ribbon').length, 5);
    const cluster = coins.filter(coin => coin.formation !== 'ribbon');
    seen.add(cluster[0].formation!);
    assert.equal(new Set(cluster.map(coin => coin.guideX)).size, 1);
    if (section === 0 || section === 3) {
      const rows = [...new Set(cluster.map(coin => coin.y))];
      assert.equal(rows.length, section === 0 ? 3 : 4);
      assert.equal(new Set(cluster.map(coin => coin.x)).size, 3);
      for (const row of rows) assert.equal(cluster.filter(coin => coin.y === row).length, 3);
      assert.equal(cluster.length, section === 0 ? 9 : 12);
    }
  }
  assert.deepEqual([...seen].sort(), ['arc', 'diamond', 'fan', 'matrix']);
  const openingMatrix = courseCoins(0).filter(coin => coin.formation === 'matrix');
  assert.ok(openingMatrix.every(coin => coin.y >= 80 && coin.y <= 180), 'the full first matrix is visible in desktop play');
});

test('every coin formation stays clear of both island footprints and the board collision clearance', () => {
  const allIds = new Set<number>();
  for (let section = 0; section < 3000; section++) {
    const coins = courseCoins(section);
    const lowY = coins[0].y - 200;
    const highY = coins.at(-1)!.y + 200;
    const mainGap = courseObstacle(1).y - courseObstacle(0).y;
    const shoreGap = courseMarginObstacle(1).y - courseMarginObstacle(0).y;
    const mainFrom = Math.max(0, Math.floor(lowY / mainGap) - 3);
    const shoreFrom = Math.max(0, Math.floor(lowY / shoreGap) - 2);
    const obstacles = [
      ...Array.from({ length: Math.ceil(highY / mainGap) - mainFrom + 2 }, (_, index) => courseObstacle(mainFrom + index)),
      ...Array.from({ length: Math.ceil(highY / shoreGap) - shoreFrom + 2 }, (_, index) => courseMarginObstacle(shoreFrom + index)),
    ].filter(obstacle => obstacle.y >= lowY && obstacle.y <= highY);
    for (let index = 0; index < coins.length; index++) for (let next = index + 1; next < coins.length; next++) {
      assert.ok(Math.hypot(coins[index].x - coins[next].x, coins[index].y - coins[next].y) >= 30, `readable spacing in section ${section}`);
    }
    for (const coin of coins) {
      assert.equal(allIds.has(coin.id), false);
      allIds.add(coin.id);
      for (const obstacle of obstacles) {
        const clearance = ((coin.x - obstacle.x) / (obstacle.rx + SURF_RIDER_COLLISION_RX)) ** 2
          + ((coin.y - obstacle.y) / (obstacle.ry + SURF_RIDER_COLLISION_RY)) ** 2;
        assert.ok(clearance > 1, `section ${section}, coin ${coin.id}, island ${obstacle.id}`);
      }
    }
  }
});

test('autopilot follows the formation spine instead of twitching toward its remaining columns', () => {
  const initial = setSurfInput(startSurf(), 'o');
  const opening = initial.items.filter(coin => coin.group === 0 && coin.formation === 'matrix');
  const spine = opening[0].guideX!;
  const onlyLeft = { ...initial, items: initial.items.map(coin => ({ ...coin,
    collectedAt: coin.group === 0 && coin.formation === 'matrix' && coin.x < spine ? null : 0 })) };
  const onlyRight = { ...initial, items: initial.items.map(coin => ({ ...coin,
    collectedAt: coin.group === 0 && coin.formation === 'matrix' && coin.x > spine ? null : 0 })) };
  const left = tickSurf(onlyLeft, 10);
  const right = tickSurf(onlyRight, 10);
  assert.equal(left.targetX, spine);
  assert.equal(right.targetX, spine);
  assert.equal(left.x, right.x);
  assert.equal(left.vx, right.vx);
});

test('a shifted formation cannot pull the surfer across an island hidden by a marginal shore threat', () => {
  for (const correct of [0, 3]) {
    const initial = setSurfInput(maintainSurfCourse({ ...startSurf(), correct,
      speed: SURF_BASE_SPEED * surfSpeedMultiplier(correct), distance: 134900,
      x: 657, vx: -3, targetX: 655.8 }), 'o');
    const navigated = tickSurf(initial, 2500);
    assert.equal(navigated.hits, 0);
    assert.equal(navigated.phase, 'surfing');
    assert.ok(navigated.distance > courseObstacle(200).y + courseObstacle(200).ry);
  }
});

test('a magnet batch records the whole matrix pickup once without duplicating its score', () => {
  const initial = startSurf();
  const group = initial.items.filter(coin => coin.group === 0 && coin.formation === 'matrix');
  const positioned = { ...initial, x: group[0].guideX!, distance: 130, correct: 3,
    items: initial.items.map(coin => ({ ...coin, collectedAt: coin.group === 0 && coin.formation === 'matrix' ? null : 0 })) };
  const collected = tickSurf(positioned, 1);
  assert.equal(collected.coins, 9);
  assert.equal(collected.score, 90);
  assert.equal(collected.event?.kind, 'coin');
  assert.equal(collected.event?.count, 9);
  const again = tickSurf(collected, 10);
  assert.equal(again.coins, 9);
  assert.equal(again.score, 90);
  assert.equal(again.eventId, collected.eventId);
});

test('empty submission neither injures the player nor consumes the word', () => {
  const state = setSurfInput(startSurf(), ' \t\n');
  const next = submitSurf(state);
  assert.equal(next.feedback, 'empty');
  assert.equal(next.phase, 'surfing');
  assert.equal(next.hits, 0);
  assert.equal(next.checkpoint, 0);
  assert.equal(next.eventId, state.eventId);
});

test('complete answers normalize case, outer whitespace and fullwidth letters', () => {
  for (const input of ['ocean', '  OCEAN \n', 'ｏｃｅａｎ']) {
    const state = submitSurf(setSurfInput(startSurf(), input));
    assert.equal(state.phase, 'cleared');
    assert.equal(state.correct, 1);
    assert.equal(state.streak, 1);
    assert.equal(state.feedback, 'correct');
    assert.equal(state.event?.kind, 'correct');
  }
  assert.equal(submitSurf(setSurfInput(startSurf(), 'oce an')).hits, 1);
});

test('success sails through feedback and then advances to the next word', () => {
  const initial = startSurf();
  let state = answer(initial);
  assert.equal(state.input, 'ocean');
  assert.equal(state.checkpoint, 0);
  assert.equal(state.score, initial.score + 100);
  assert.equal(submitSurf(state), state);
  assert.equal(setSurfInput(state, 'sun'), state);
  state = tickSurf(state, 649);
  assert.equal(state.phase, 'cleared');
  assert.ok(state.distance > 0);
  assert.equal(currentSurfWord(state).answer, 'ocean');
  state = tickSurf(state, 1);
  assert.equal(state.phase, 'surfing');
  assert.equal(state.checkpoint, 1);
  assert.equal(state.input, '');
  assert.equal(state.navigation, 'waiting');
  assert.equal(currentSurfWord(state).answer, 'sun');
});

test('each correct word compounds the actual pickup radius by 50% without a gameplay cap', () => {
  let state = startSurf();
  for (let correct = 1; correct <= 12; correct++) {
    const previousRadius = surfMagnetRadius(state.correct);
    state = answer(state);
    assert.equal(state.correct, correct);
    assert.ok(Math.abs(surfMagnetRadius(correct) / previousRadius - 1.5) < 1e-10);
    assert.equal(surfMagnetMultiplier(correct), 1.5 ** correct);
    state = tickSurf(state, 650);
  }
  assert.equal(surfMagnetMultiplier(1), 1.5);
  assert.equal(surfMagnetMultiplier(2), 2.25);
  assert.equal(surfMagnetMultiplier(3), 3.375);
  assert.ok(surfMagnetRadius(12) > 2000);
});

test('wrong answers preserve text, break the combo, and briefly slow down without stopping', () => {
  const initial = tickSurf(startSurf(), 300);
  let state = wrong(initial);
  assert.equal(state.phase, 'hurt');
  assert.equal(state.hits, 1);
  assert.equal(state.input, 'wrong');
  assert.equal(state.event?.kind, 'hurt');
  assert.equal(submitSurf(state), state);
  state = tickSurf(state, 650);
  assert.equal(state.phase, 'surfing');
  assert.equal(state.input, 'wrong');
  assert.equal(state.hits, 1);
  assert.equal(state.checkpoint, 0);
  assert.ok(state.distance > initial.distance);
  assert.ok(state.distance < initial.distance + SURF_BASE_SPEED * 0.65);
  const correction = clearWord(state);
  assert.equal(correction.hits, 1);
  assert.equal(correction.correct, 1);
});

test('an island impact deflects the board, slows travel, and cannot repeatedly damage on overlap', () => {
  const firstIsland = courseObstacle(0);
  const initial = { ...startSurf(), distance: firstIsland.y - firstIsland.ry - SURF_RIDER_COLLISION_RY - 4, x: firstIsland.x };
  let state = tickSurf(initial, 100);
  assert.equal(state.phase, 'hurt');
  assert.equal(state.hits, 1);
  assert.equal(state.feedback, 'collision');
  assert.ok(state.vx !== 0);
  assert.ok(state.invulnerableMs > 1000);
  assert.equal(state.obstacles.find(obstacle => obstacle.id === 0)?.hit, true);
  state = tickSurf(state, 700);
  assert.equal(state.phase, 'surfing');
  assert.equal(state.hits, 1);
  assert.ok(state.x !== initial.x);
  const alreadyHit = { ...state, x: 500, vx: 0, distance: 1050, invulnerableMs: 0 };
  assert.equal(tickSurf(alreadyHit, 100).hits, 1);
});

test('three cumulative injuries sink the monster once, including obstacle damage', () => {
  let state = wrong(startSurf());
  state = wrong(tickSurf(state, 650));
  assert.equal(state.hits, 2);
  state = tickSurf(state, 650);
  const firstIsland = courseObstacle(0);
  state = tickSurf({ ...state, x: firstIsland.x, vx: 0, distance: firstIsland.y - firstIsland.ry - SURF_RIDER_COLLISION_RY - 4, invulnerableMs: 0 }, 100);
  assert.equal(state.hits, 3);
  assert.equal(state.phase, 'sinking');
  const distance = state.distance;
  const remaining = 1100 - state.phaseMs;
  state = tickSurf(state, remaining - 1);
  assert.equal(state.phase, 'sinking');
  state = tickSurf(state, 1);
  assert.equal(state.phase, 'over');
  assert.equal(state.event?.kind, 'over');
  assert.equal(state.distance, distance);
  assert.equal(tickSurf(state, 1_000), state);
  assert.equal(pauseSurf(state), state);
  assert.equal(submitSurf(state), state);
  assert.equal(startSurf(state.monster).hits, 0);
});

test('speed grows with total correct words and survives combo breaks; success never heals', () => {
  let state = startSurf();
  for (let correct = 1; correct <= 3; correct++) {
    state = clearWord(state);
    assert.equal(state.correct, correct);
    assert.equal(state.speed, SURF_BASE_SPEED * surfSpeedMultiplier(correct));
  }
  const speed = state.speed;
  const radius = surfMagnetRadius(state.correct);
  state = wrong(state);
  assert.equal(state.streak, 0);
  assert.equal(state.bestStreak, 3);
  assert.equal(state.speed, speed);
  assert.equal(surfMagnetRadius(state.correct), radius);
  state = clearWord(tickSurf(state, 650));
  assert.equal(state.correct, 4);
  assert.equal(state.hits, 1);
  assert.equal(state.streak, 1);
  assert.equal(state.speed, SURF_BASE_SPEED * surfSpeedMultiplier(4));
  assert.equal(surfSpeedMultiplier(1000), 2.5);
});

test('pausing freezes every active phase, input, cooldowns and feedback timing', () => {
  const sinking = wrong(tickSurf(wrong(tickSurf(wrong(startSurf()), 650)), 650));
  for (const active of [startSurf(), wrong(startSurf()), answer(startSurf()), sinking]) {
    const progressed = tickSurf(active, 150);
    const paused = pauseSurf(progressed);
    assert.equal(paused.phase, 'paused');
    assert.equal(paused.resumePhase, progressed.phase);
    assert.equal(tickSurf(paused, 100_000), paused);
    assert.equal(setSurfInput(paused, 'x'), paused);
    assert.equal(submitSurf(paused), paused);
    assert.equal(pauseSurf(paused), paused);
    assert.deepEqual(resumeSurf(paused), progressed);
  }
});

test('the expanded magnet picks up coins beyond the original radius exactly once', () => {
  const base = startSurf();
  const positioned = { ...base, items: base.items.map(coin => ({ ...coin, x: coin.id === 0 ? 555 : 940, y: coin.id === 0 ? 0 : coin.y })) };
  const ordinary = tickSurf(positioned, 1);
  const upgraded = tickSurf({ ...positioned, correct: 1 }, 1);
  assert.equal(ordinary.coins, 0);
  assert.equal(upgraded.coins, 1);
  assert.equal(upgraded.score, 10);
  assert.notEqual(upgraded.items[0].collectedAt, null);
  assert.equal(tickSurf(upgraded, 10).coins, 1);
  assert.equal(tickSurf(pauseSurf(upgraded), 1000).coins, 1);
});

test('equivalent small and large simulation updates yield identical routes and feedback transitions', () => {
  const initial = setSurfInput(startSurf(), 'o');
  const large = tickSurf(initial, 10_000);
  let small = initial;
  for (let index = 0; index < 1000; index++) small = tickSurf(small, 10);
  for (const key of ['phase', 'distance', 'x', 'vx', 'coins', 'score', 'checkpoint', 'eventId'] as const) assert.equal(small[key], large[key]);
  const accepted = answer(startSurf());
  const afterLarge = tickSurf(accepted, 1200);
  let afterSmall = accepted;
  for (let index = 0; index < 120; index++) afterSmall = tickSurf(afterSmall, 10);
  assert.ok(Math.abs(afterLarge.distance - afterSmall.distance) < 1e-7);
  assert.equal(afterLarge.phase, afterSmall.phase);
  assert.equal(afterLarge.coins, afterSmall.coins);
});

test('the active sea remains bounded even after enormous magnet upgrades, without resurrecting coins', () => {
  let state = setSurfInput({ ...startSurf(), correct: 100, speed: SURF_BASE_SPEED * surfSpeedMultiplier(100) }, 'o');
  const retired = new Set<number>();
  let previousIds = new Set(state.items.map(coin => coin.id));
  for (let index = 0; index < 80; index++) {
    state = tickSurf(state, 5_000);
    const ids = new Set(state.items.map(coin => coin.id));
    assert.ok(state.items.length <= 210);
    assert.ok(state.obstacles.length <= 28);
    assert.equal(ids.size, state.items.length);
    for (const id of retired) assert.equal(ids.has(id), false);
    for (const id of previousIds) if (!ids.has(id)) retired.add(id);
    previousIds = ids;
    assert.equal(state.hits, 0);
  }
  assert.ok(retired.size > 100);
  assert.ok(Number.isFinite(surfMagnetRadius(100)));
});

test('invalid deltas are ignored and updates preserve immutable prior states', () => {
  const state = setSurfInput(startSurf(), 'o');
  for (const delta of [-1, NaN, Infinity, -Infinity, 0]) assert.equal(tickSurf(state, delta), state);
  for (const coin of state.items) Object.freeze(coin);
  for (const island of state.obstacles) Object.freeze(island);
  Object.freeze(state.items);
  Object.freeze(state.obstacles);
  Object.freeze(state);
  const next = tickSurf(state, 1_000);
  assert.equal(state.distance, 0);
  assert.equal(state.coins, 0);
  assert.ok(next.distance > 0);
  assert.ok(next.items.every(coin => Number.isFinite(coin.x) && Number.isFinite(coin.y)));
});
