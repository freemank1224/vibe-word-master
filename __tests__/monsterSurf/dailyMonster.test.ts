import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createSurfState, startSurf, pauseSurf } from '../../features/monster-surf/game.ts';
import { getDailySurfMonster, millisecondsUntilNextSurfDay, refreshDailySurfMonster } from '../../features/monster-surf/dailyMonster.ts';

test('all seven local weekdays use the same M0–M6 mapping as the homepage', () => {
  for (let day = 0; day < 7; day++) {
    const localDate = new Date(2026, 9, 25 + day, 12, 0, 0);
    assert.equal(getDailySurfMonster(localDate), day);
  }
});

test('the local calendar switches exactly at midnight, including a week rollover', () => {
  const beforeMidnight = new Date(2026, 9, 31, 23, 59, 59, 750);
  const midnight = new Date(2026, 10, 1, 0, 0, 0);
  assert.equal(getDailySurfMonster(beforeMidnight), 6);
  assert.equal(getDailySurfMonster(midnight), 0);
  assert.equal(millisecondsUntilNextSurfDay(beforeMidnight), 250);
  const ready = createSurfState(6);
  const next = refreshDailySurfMonster(ready, midnight);
  assert.equal(next.monster, 0);
  assert.equal(next.phase, 'ready');
  assert.equal(refreshDailySurfMonster(next, midnight), next);
  assert.equal(ready.monster, 6);
});

test('midnight does not replace the rider in a live, paused or completed run', () => {
  const date = new Date(2026, 10, 1);
  const surfing = startSurf(6);
  for (const state of [surfing, pauseSurf(surfing), { ...surfing, phase: 'over' as const }]) {
    assert.equal(refreshDailySurfMonster(state, date), state);
    assert.equal(state.monster, 6);
  }
  assert.equal(startSurf(getDailySurfMonster(date)).monster, 0);
});

test('weekday and next midnight follow local time, not UTC or a fixed 24-hour interval', () => {
  const helper = new URL('../../features/monster-surf/dailyMonster.ts', import.meta.url).href;
  const source = `
    import { getDailySurfMonster, millisecondsUntilNextSurfDay } from ${JSON.stringify(helper)};
    const utcSunday = new Date('2026-11-01T02:00:00.000Z');
    console.log(JSON.stringify({
      localWeekday: getDailySurfMonster(utcSunday),
      springHours: millisecondsUntilNextSurfDay(new Date(2026, 2, 8, 0)) / 3600000,
      autumnHours: millisecondsUntilNextSurfDay(new Date(2026, 10, 1, 0)) / 3600000,
    }));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' },
  });
  assert.deepEqual(JSON.parse(output), { localWeekday: 6, springHours: 23, autumnHours: 25 });
});
