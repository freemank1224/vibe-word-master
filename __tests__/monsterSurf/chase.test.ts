import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startSurf, setSurfInput, submitSurf, currentSurfWord, tickSurf, pauseSurf, resumeSurf,
} from '../../features/monster-surf/game.ts';
import {
  SURF_BASE_SPEED, surfSpeedMultiplier, SURF_CHASE_WARNING_MS, SURF_CHASE_RETREAT_MS,
  SURF_CHASE_ATTACK_MS, SURF_CHASE_BOOST_MS, SURF_CHASE_BOOST_MULTIPLIER, SURF_RIDER_COLLISION_RY,
} from '../../features/monster-surf/constants.ts';
import { courseObstacle, maintainSurfCourse } from '../../features/monster-surf/course.ts';
import type { SurfState } from '../../features/monster-surf/types.ts';

const correct = (state: SurfState) => submitSurf(setSurfInput(state, currentSurfWord(state).answer));
const success = (state: SurfState) => tickSurf(correct(state), 650);
const wrong = (state: SurfState) => submitSurf(setSurfInput(state, 'not-the-word'));
function reachWarning(initial = startSurf()): SurfState {
  let state = initial;
  while (state.correct < 9) state = success(state);
  return correct(state);
}
const warningInput = () => tickSurf(reachWarning(), 650);
const baseSpeed = (state: SurfState) => SURF_BASE_SPEED * surfSpeedMultiplier(state.correct);

test('the tenth complete word triggers one warning and is not counted toward the five-word escape', () => {
  let state = startSurf();
  for (let count = 1; count <= 9; count++) {
    state = success(state);
    assert.equal(state.correct, count);
    assert.equal(state.chase.phase, 'dormant');
    assert.equal(state.chase.phaseMs, 0);
  }
  const prefix = setSurfInput(state, currentSurfWord(state).answer.slice(0, -1));
  assert.equal(prefix.chase.phase, 'dormant');
  state = correct(state);
  assert.equal(state.correct, 10);
  assert.equal(state.chase.phase, 'warning');
  assert.equal(state.chase.phaseMs, 0);
  assert.equal(state.chase.escapeStreak, 0);
  assert.equal(state.chase.mistakes, 0);
  assert.equal(state.chase.gap, 260);
  assert.equal(state.chase.targetGap, 260);
  assert.equal(state.chase.boostMs, 0);
  assert.equal(state.event?.kind, 'sea-warning');
  const stillWarning = tickSurf(state, SURF_CHASE_WARNING_MS - 1);
  assert.equal(stillWarning.chase.phase, 'warning');
  const chasing = tickSurf(stillWarning, 1);
  assert.equal(chasing.chase.phase, 'chasing');
  assert.equal(chasing.chase.phaseMs, 0);
  assert.equal(chasing.chase.action, 'follow');
});

test('answers during the warning count, boost real movement, and smoothly open the gap', () => {
  const initial = warningInput();
  let state = correct(initial);
  assert.equal(state.chase.phase, 'warning');
  assert.equal(state.chase.escapeStreak, 1);
  assert.equal(state.chase.targetGap, 330);
  assert.equal(state.chase.gap, initial.chase.gap);
  assert.equal(state.chase.boostMs, SURF_CHASE_BOOST_MS);
  assert.equal(state.chase.action, 'surge');
  assert.equal(state.chase.actionMs, 0);
  assert.equal(state.event?.kind, 'correct');
  assert.equal(state.speed, baseSpeed(state) * SURF_CHASE_BOOST_MULTIPLIER);
  const distance = state.distance;
  const speed = state.speed;
  state = tickSurf(state, 100);
  assert.ok(state.chase.gap > initial.chase.gap && state.chase.gap < state.chase.targetGap);
  assert.equal(state.chase.actionMs, 100);
  assert.equal(state.chase.boostMs, SURF_CHASE_BOOST_MS - 100);
  assert.ok(Math.abs(state.distance - distance - speed * 0.1) < 1e-7);
  state = tickSurf(state, 550);
  state = correct(state);
  assert.equal(state.chase.phase, 'warning');
  assert.equal(state.chase.escapeStreak, 2);
  assert.equal(state.chase.boostMs, SURF_CHASE_BOOST_MS, 'a new word refreshes rather than stacks the timer');
});

test('five consecutive chase words make the sea monster retreat and permanently leave this run', () => {
  let state = warningInput();
  for (let count = 1; count <= 5; count++) {
    state = correct(state);
    assert.equal(state.chase.escapeStreak, count);
    if (count < 5) {
      assert.ok(state.chase.phase === 'warning' || state.chase.phase === 'chasing');
      state = tickSurf(state, 650);
    }
  }
  assert.equal(state.correct, 15);
  assert.equal(state.chase.phase, 'retreating');
  assert.equal(state.chase.phaseMs, 0);
  assert.equal(state.chase.targetGap, 950);
  assert.equal(state.event?.kind, 'sea-escape');
  state = tickSurf(state, SURF_CHASE_RETREAT_MS - 1);
  assert.equal(state.chase.phase, 'retreating');
  state = tickSurf(state, 1);
  assert.equal(state.chase.phase, 'escaped');
  assert.equal(state.chase.boostMs, 0);
  assert.equal(state.speed, baseSpeed(state));
  for (let count = 0; count < 10; count++) {
    state = success(state);
    assert.equal(state.chase.phase, 'escaped');
    assert.notEqual(state.event?.kind, 'sea-warning');
  }
  assert.equal(state.chase.escapeStreak, 5);
});

test('chase mistakes reset only escape streak and cumulatively bring the creature closer', () => {
  let state = success(warningInput());
  state = success(state);
  assert.equal(state.chase.escapeStreak, 2);
  const oldGap = state.chase.gap;
  const oldTarget = state.chase.targetGap;
  const oldHits = state.hits;
  state = wrong(state);
  assert.equal(state.phase, 'hurt');
  assert.equal(state.chase.escapeStreak, 0);
  assert.equal(state.chase.mistakes, 1);
  assert.equal(state.chase.targetGap, oldTarget - 90);
  assert.equal(state.chase.action, 'close');
  assert.equal(state.chase.boostMs, 0);
  assert.equal(state.hits, oldHits);
  assert.equal(state.speed, baseSpeed(state));
  assert.equal(state.event?.kind, 'sea-approach');
  assert.equal(submitSurf(state), state);
  state = tickSurf(state, 650);
  assert.ok(state.chase.gap < oldGap);
  state = success(state);
  assert.equal(state.chase.escapeStreak, 1);
  assert.equal(state.chase.mistakes, 1, 'a later success does not erase cumulative mistakes');
  state = wrong(state);
  assert.equal(state.chase.escapeStreak, 0);
  assert.equal(state.chase.mistakes, 2);
  assert.equal(state.hits, oldHits);
});

test('three chase mistakes attack only on the third even with two existing island injuries', () => {
  let state = tickSurf(wrong(startSurf()), 650);
  state = tickSurf(wrong(state), 650);
  assert.equal(state.hits, 2);
  state = tickSurf(reachWarning(state), 650);
  for (let mistakes = 1; mistakes <= 3; mistakes++) {
    state = wrong(state);
    assert.equal(state.chase.mistakes, mistakes);
    assert.equal(state.hits, 2);
    if (mistakes < 3) {
      assert.equal(state.phase, 'hurt');
      assert.notEqual(state.chase.phase, 'attacking');
      state = tickSurf(state, 650);
    }
  }
  assert.equal(state.phase, 'sinking');
  assert.equal(state.chase.phase, 'attacking');
  assert.equal(state.chase.phaseMs, 0);
  assert.equal(state.chase.targetGap, 20);
  assert.equal(state.event?.kind, 'sea-attack');
  const distance = state.distance;
  state = tickSurf(state, SURF_CHASE_ATTACK_MS - 1);
  assert.equal(state.phase, 'sinking');
  assert.equal(state.chase.phase, 'attacking');
  assert.equal(state.distance, distance);
  state = tickSurf(state, 1);
  assert.equal(state.phase, 'over');
  assert.equal(state.chase.phase, 'attacking', 'the result screen retains its failure reason');
  assert.equal(state.event?.kind, 'over');
  assert.equal(tickSurf(state, 5000), state);
});

test('island collisions still use the original injury limit and ordinary sinking duration during a chase', () => {
  const firstIsland = courseObstacle(0);
  const initial = maintainSurfCourse({ ...warningInput(), x: firstIsland.x, vx: 0, hits: 2,
    distance: firstIsland.y - firstIsland.ry - SURF_RIDER_COLLISION_RY - 4, input: '', navigation: 'waiting', invulnerableMs: 0 });
  let state = tickSurf(initial, 100);
  assert.equal(state.hits, 3);
  assert.equal(state.chase.mistakes, 0);
  assert.equal(state.phase, 'sinking');
  assert.notEqual(state.chase.phase, 'attacking');
  assert.equal(state.feedback, 'collision');
  const remaining = 1100 - state.phaseMs;
  state = tickSurf(state, remaining - 1);
  assert.equal(state.phase, 'sinking');
  state = tickSurf(state, 1);
  assert.equal(state.phase, 'over');
});

test('empty answers and repeated submits during feedback do not advance or penalize the chase', () => {
  const initial = warningInput();
  const empty = submitSurf(setSurfInput(initial, ' \t\n'));
  assert.equal(empty.feedback, 'empty');
  assert.deepEqual(empty.chase, initial.chase);
  assert.equal(empty.hits, initial.hits);
  const accepted = correct(initial);
  assert.equal(submitSurf(accepted), accepted);
  assert.equal(setSurfInput(accepted, 'x'), accepted);
  const rejected = wrong(initial);
  assert.equal(submitSurf(rejected), rejected);
});

test('pause freezes warning, chase boosts, closing, retreat and attack clocks and resumes without jumps', () => {
  const warning = warningInput();
  const chasing = tickSurf(warning, SURF_CHASE_WARNING_MS);
  let retreating = warning;
  for (let index = 0; index < 4; index++) retreating = success(retreating);
  retreating = correct(retreating);
  let attacking = warning;
  for (let index = 0; index < 2; index++) attacking = tickSurf(wrong(attacking), 650);
  attacking = wrong(attacking);
  for (const active of [warning, chasing, correct(warning), wrong(warning), retreating, attacking]) {
    const progressed = tickSurf(active, 150);
    const paused = pauseSurf(progressed);
    assert.equal(tickSurf(paused, 10000), paused);
    assert.equal(setSurfInput(paused, 'o'), paused);
    assert.deepEqual(paused.chase, progressed.chase);
    assert.deepEqual(resumeSurf(paused), progressed);
  }
});

test('boosted pace returns exactly to the earned base speed after the timed surge', () => {
  let state = correct(warningInput());
  const expected = baseSpeed(state);
  state = tickSurf(state, SURF_CHASE_BOOST_MS - 1);
  assert.equal(state.chase.boostMs, 1);
  assert.equal(state.speed, expected * SURF_CHASE_BOOST_MULTIPLIER);
  assert.equal(state.chase.action, 'follow');
  state = tickSurf(state, 1);
  assert.equal(state.chase.boostMs, 0);
  assert.equal(state.speed, expected);
  const before = state.distance;
  state = tickSurf(state, 100);
  assert.ok(Math.abs(state.distance - before - expected * 0.1) < 1e-7);
});

test('restart clears the entire chase and can trigger a fresh encounter at ten words', () => {
  const active = correct(warningInput());
  const restarted = startSurf(active.monster);
  assert.equal(restarted.correct, 0);
  assert.equal(restarted.hits, 0);
  assert.equal(restarted.chase.phase, 'dormant');
  assert.equal(restarted.chase.mistakes, 0);
  assert.equal(restarted.chase.escapeStreak, 0);
  assert.equal(restarted.chase.boostMs, 0);
  assert.equal(restarted.chase.gap, 260);
  assert.equal(reachWarning(restarted).chase.phase, 'warning');
});

test('small and large frames produce the same chase clocks, smooth gap and speed recovery', () => {
  const initial = correct(warningInput());
  const large = tickSurf(initial, 2400);
  let small = initial;
  for (let index = 0; index < 240; index++) small = tickSurf(small, 10);
  assert.deepEqual(small.chase, large.chase);
  assert.equal(small.speed, large.speed);
  assert.equal(small.distance, large.distance);
  assert.equal(small.phase, large.phase);
});

test('following alone never attacks or consumes another mistake, even after two errors', () => {
  let state = warningInput();
  for (let mistakes = 0; mistakes < 2; mistakes++) state = tickSurf(wrong(state), 650);
  state = setSurfInput(state, currentSurfWord(state).answer.slice(0, 1));
  for (let second = 0; second < 120; second++) state = tickSurf(state, 1_000);
  assert.equal(state.phase, 'surfing');
  assert.equal(state.chase.phase, 'chasing');
  assert.equal(state.chase.mistakes, 2);
  assert.equal(state.chase.escapeStreak, 0);
  assert.equal(state.correct, 10);
  assert.equal(state.hits, 0);
  assert.ok(Math.abs(state.chase.gap - state.chase.targetGap) < 1e-7);
});

test('correct navigation remains safe and bounded under the maximum chase surge and a huge magnet', () => {
  // Hold the worst-case surge beyond its normal duration to exercise many island
  // combinations, including after the magnet has collected every visible coin.
  let state = startSurf();
  state = setSurfInput({ ...state, correct: 23,
    speed: SURF_BASE_SPEED * surfSpeedMultiplier(23) * SURF_CHASE_BOOST_MULTIPLIER,
    chase: { ...state.chase, phase: 'chasing', mistakes: 2, boostMs: 1_000_000 } }, 'o');
  let minX = state.x;
  let maxX = state.x;
  for (let second = 0; second < 240; second++) {
    state = tickSurf(state, 1_000);
    minX = Math.min(minX, state.x);
    maxX = Math.max(maxX, state.x);
    assert.equal(state.hits, 0, `unavoidable island damage at second ${second}`);
    assert.equal(state.chase.mistakes, 2);
    assert.equal(state.phase, 'surfing');
    assert.ok(state.items.length <= 210);
    assert.ok(state.obstacles.length <= 28);
    assert.ok(Number.isFinite(state.x) && Number.isFinite(state.distance));
  }
  assert.ok(maxX - minX > 200, 'the surfer still changes course after distant coins are collected');
  assert.ok(state.coins > 100);
});

test('correcting mistakes can still complete all five escapes without erasing the danger count', () => {
  let state = warningInput();
  for (let index = 0; index < 2; index++) state = tickSurf(wrong(state), 650);
  for (let index = 1; index <= 5; index++) {
    state = correct(state);
    assert.equal(state.chase.mistakes, 2);
    assert.equal(state.chase.escapeStreak, index);
    assert.equal(state.hits, 0);
    state = tickSurf(state, 650);
  }
  assert.equal(state.chase.phase, 'retreating');
  state = tickSurf(setSurfInput(state, currentSurfWord(state).answer.slice(0, 1)), SURF_CHASE_RETREAT_MS);
  assert.equal(state.chase.phase, 'escaped');
  assert.equal(state.phase, 'surfing');
  const afterEscape = wrong(state);
  assert.equal(afterEscape.hits, 1, 'after the encounter, normal word injury rules resume');
  assert.equal(afterEscape.chase.mistakes, 2);
  assert.equal(afterEscape.chase.phase, 'escaped');
  assert.equal(afterEscape.event?.kind, 'hurt');
});
