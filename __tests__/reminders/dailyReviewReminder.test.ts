import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewReminderHistory, dailyReviewReminderKey, shouldShowDailyReviewReminder } from '../../utils/dailyReviewReminder.ts';
import { getShanghaiDateString } from '../../utils/timezone.ts';

const ready = { userId: 'account-a', day: '2026-10-23', dueCount: 362, dataReady: true, rewardReady: true, blocked: false };
function storageFixture() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
test('waits for both data and the asynchronous daily reward, then waits for coin dismissal', () => {
  const history = createReviewReminderHistory(() => storageFixture());
  for (const state of [{ dataReady: false }, { rewardReady: false }, { blocked: true }, { userId: null }, { dueCount: 0 }]) {
    assert.equal(shouldShowDailyReviewReminder({ ...ready, ...state }, history), false);
  }
  assert.equal(shouldShowDailyReviewReminder(ready, history), true);
});
test('refreshes and repeated logins do not repeat the reminder; accounts and days remain independent', () => {
  const storage = storageFixture();
  const history = createReviewReminderHistory(() => storage);
  history.markSeen(ready.userId, ready.day);
  assert.equal(shouldShowDailyReviewReminder(ready, history), false);
  const reloaded = createReviewReminderHistory(() => storage);
  assert.equal(shouldShowDailyReviewReminder(ready, reloaded), false);
  assert.equal(shouldShowDailyReviewReminder({ ...ready, userId: 'account-b' }, reloaded), true);
  assert.equal(shouldShowDailyReviewReminder({ ...ready, day: '2026-10-24' }, reloaded), true);
  assert.equal(storage.getItem(dailyReviewReminderKey(ready.userId)), ready.day);
});
test('storage denial never crashes login or repeatedly interrupts the current session', () => {
  const history = createReviewReminderHistory(() => { throw new Error('storage unavailable'); });
  assert.equal(shouldShowDailyReviewReminder(ready, history), true);
  history.markSeen(ready.userId, ready.day);
  assert.equal(shouldShowDailyReviewReminder(ready, history), false);
});
test('reminder day matches reward day across Shanghai midnight', () => {
  assert.equal(getShanghaiDateString(Date.parse('2026-10-23T15:59:59Z')), '2026-10-23');
  assert.equal(getShanghaiDateString(Date.parse('2026-10-23T16:00:00Z')), '2026-10-24');
});
