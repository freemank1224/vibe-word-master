/** Invalidation only: each tab reads its own authenticated wallet from the server. */
export const WALLET_CHANGE_EVENT = 'vocab:wallet-changed';
export const WALLET_CHANGE_STORAGE_KEY = 'vocab_wallet_changed_v1';
let walletRefreshRevision = 0;
const observedEvents = new WeakSet<Event>();
export const getWalletRefreshRevision = () => walletRefreshRevision;

export function notifyWalletChanged(target: Window | undefined = typeof window === 'undefined' ? undefined : window): void {
  if (!target) return;
  target.dispatchEvent(new Event(WALLET_CHANGE_EVENT));
  try {
    // A fresh token also notifies other tabs after two transactions in the same millisecond.
    target.localStorage.setItem(WALLET_CHANGE_STORAGE_KEY, `${Date.now()}:${Math.random()}`);
  } catch {
    // Disabled storage must never turn a committed payment into a failed request.
  }
}

/** Return-to-tab and bfcache restoration cover missed notifications while a page was suspended. */
export function subscribeToWalletChanges(refresh: () => void, target: Window = window): () => void {
  const onWalletEvent = (event: Event) => {
    // Multiple views observing one event share a request; a later payment requires a new read.
    if (!observedEvents.has(event)) { observedEvents.add(event); walletRefreshRevision++; }
    refresh();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === WALLET_CHANGE_STORAGE_KEY && event.newValue !== null) onWalletEvent(event);
  };
  const onVisible = (event: Event) => { if (target.document.visibilityState === 'visible') onWalletEvent(event); };
  const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) onVisible(event); };
  target.addEventListener(WALLET_CHANGE_EVENT, onWalletEvent);
  target.addEventListener('storage', onStorage);
  target.addEventListener('focus', onVisible);
  target.addEventListener('online', onVisible);
  target.addEventListener('pageshow', onPageShow);
  target.document.addEventListener('visibilitychange', onVisible);
  return () => {
    target.removeEventListener(WALLET_CHANGE_EVENT, onWalletEvent);
    target.removeEventListener('storage', onStorage);
    target.removeEventListener('focus', onVisible);
    target.removeEventListener('online', onVisible);
    target.removeEventListener('pageshow', onPageShow);
    target.document.removeEventListener('visibilitychange', onVisible);
  };
}
