import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notifyWalletChanged, subscribeToWalletChanges, WALLET_CHANGE_EVENT, WALLET_CHANGE_STORAGE_KEY } from '../walletUpdates.ts';

function browser() {
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const writes: Array<[string, string]> = [];
  const target = Object.assign(new EventTarget(), {
    document,
    localStorage: { setItem: (key: string, value: string) => { writes.push([key, value]); } },
  });
  return { target: target as unknown as Window, document, writes };
}
function storageEvent(key: string, newValue: string | null): Event {
  return Object.assign(new Event('storage'), { key, newValue });
}

test('a payment invalidates this tab and another tab without sharing an account or balance', () => {
  const source = browser(), other = browser();
  let sourceReads = 0, otherReads = 0;
  const stopSource = subscribeToWalletChanges(() => { sourceReads++; }, source.target);
  const stopOther = subscribeToWalletChanges(() => { otherReads++; }, other.target);
  notifyWalletChanged(source.target);
  assert.equal(sourceReads, 1);
  assert.equal(source.writes.length, 1);
  const [key, token] = source.writes[0];
  assert.equal(key, WALLET_CHANGE_STORAGE_KEY);
  assert.match(token, /^\d+:/);
  const nonce = Number(token.split(':')[1]);
  assert.ok(nonce >= 0 && nonce < 1);
  other.target.dispatchEvent(storageEvent(key, token));
  assert.equal(otherReads, 1);
  other.target.dispatchEvent(storageEvent('unrelated', 'anything'));
  other.target.dispatchEvent(storageEvent(key, null));
  assert.equal(otherReads, 1);
  stopSource(); stopOther();
  source.target.dispatchEvent(new Event(WALLET_CHANGE_EVENT));
  other.target.dispatchEvent(storageEvent(key, token));
  assert.equal(sourceReads, 1);
  assert.equal(otherReads, 1);
});

test('returning from Surf or a suspended page refreshes the wallet and removes every listener on cleanup', () => {
  const page = browser();
  let reads = 0;
  const stop = subscribeToWalletChanges(() => { reads++; }, page.target);
  page.target.dispatchEvent(new Event('focus'));
  page.target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  page.target.dispatchEvent(new Event('online'));
  page.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(reads, 4);
  page.target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
  page.document.visibilityState = 'hidden';
  page.document.dispatchEvent(new Event('visibilitychange'));
  page.target.dispatchEvent(new Event('focus'));
  assert.equal(reads, 4);
  stop();
  page.document.visibilityState = 'visible';
  page.target.dispatchEvent(new Event('focus'));
  page.target.dispatchEvent(new Event('online'));
  page.document.dispatchEvent(new Event('visibilitychange'));
  page.target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  assert.equal(reads, 4);
});

test('disabled storage cannot fail a committed transaction or suppress the current-tab refresh', () => {
  const page = browser();
  let reads = 0;
  const stop = subscribeToWalletChanges(() => { reads++; }, page.target);
  page.target.localStorage.setItem = () => { throw new Error('storage disabled'); };
  assert.doesNotThrow(() => notifyWalletChanged(page.target));
  assert.equal(reads, 1);
  stop();
});
