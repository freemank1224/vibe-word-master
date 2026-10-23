import type { PendingSyncItem } from '../types.ts';
import { parseTestStatsReceipt, validateTestStatsEvent, type TestStatsReceipt } from './testStatsEvents.ts';

type QueueStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type NewPendingSync = Omit<PendingSyncItem, 'retryCount' | 'lastError' | 'nextRetryAt'> & { userId: string };
export interface PendingSyncResult { success: number; failed: number; pending: number; receipts: TestStatsReceipt[]; }
export const pendingSyncKey = (userId: string) => `vibe_pending_syncs_v2:${userId}`;

export function createPendingSyncQueue(deps: {
  storage: QueueStorage;
  now: () => number;
  currentUserId: () => Promise<string | null>;
  send: (item: PendingSyncItem) => Promise<unknown>;
}) {
  const inFlight = new Map<string, Promise<PendingSyncResult>>();
  function read(userId: string): PendingSyncItem[] {
    if (!userId) return [];
    const raw = deps.storage.getItem(pendingSyncKey(userId));
    if (!raw) return [];
    const items: unknown = JSON.parse(raw);
    if (!Array.isArray(items)) throw new Error('离线记录格式异常，请保留本机数据。');
    const ids = new Set<string>();
    for (const item of items) {
      validateTestStatsEvent(item);
      if (item.userId !== userId || ids.has(item.id)) throw new Error('离线记录账号或编号异常。');
      ids.add(item.id);
    }
    return items;
  }
  function write(userId: string, items: PendingSyncItem[]) { deps.storage.setItem(pendingSyncKey(userId), JSON.stringify(items)); }
  function enqueue(item: NewPendingSync): boolean {
    validateTestStatsEvent(item);
    const items = read(item.userId);
    const old = items.find(entry => entry.id === item.id);
    if (old) {
      for (const field of ['date', 'timestamp', 'testCount', 'correctCount', 'points'] as const) {
        if (old[field] !== item[field]) throw new Error('同一测试事件的内容发生变化。');
      }
      return false;
    }
    write(item.userId, [...items, { ...item, retryCount: 0 }]);
    return true;
  }
  function process(userId: string): Promise<PendingSyncResult> {
    const active = inFlight.get(userId);
    if (active) return active;
    const work = (async () => {
      const result: PendingSyncResult = { success: 0, failed: 0, pending: 0, receipts: [] };
      for (const item of read(userId)) {
        if (item.nextRetryAt && item.nextRetryAt > deps.now()) continue;
        if (await deps.currentUserId() !== userId) break;
        try {
          const receipt = parseTestStatsReceipt(await deps.send(item), item);
          if (await deps.currentUserId() !== userId) break;
          // Preserve items added during the request.
          write(userId, read(userId).filter(entry => entry.id !== item.id));
          result.success++;
          result.receipts.push(receipt);
        } catch (error) {
          const items = read(userId);
          const current = items.find(entry => entry.id === item.id);
          if (current) {
            current.retryCount = (current.retryCount || 0) + 1;
            current.lastError = error instanceof Error ? error.message : String(error);
            current.nextRetryAt = deps.now() + Math.min(300_000, 1000 * 2 ** Math.min(current.retryCount - 1, 9));
            write(userId, items);
          }
          result.failed++;
        }
      }
      result.pending = read(userId).length;
      return result;
    })().finally(() => inFlight.delete(userId));
    inFlight.set(userId, work);
    return work;
  }
  return { read, enqueue, process };
}
