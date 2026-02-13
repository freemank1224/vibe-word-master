/**
 * Offline Sync Queue Service (Phase C)
 *
 * Provides localStorage-based queue for pending test syncs when offline or sync fails.
 * Implements exponential backoff retry strategy (1s, 5s, 15s).
 * Max 3 retries per item before discarding.
 *
 * @module services/offlineSyncQueue
 */

import { PendingSyncItem } from '../types';
import { recordTestAndSyncStats } from './dataService';

const STORAGE_KEY = 'vibe_pending_syncs';
const MAX_RETRY_COUNT = 3;
const RETRY_DELAYS = [1000, 5000, 15000];  // 1s, 5s, 15s

/**
 * Get all pending sync items from localStorage
 *
 * @returns {PendingSyncItem[]} Array of pending items (empty array if parse fails)
 */
export const getPendingSyncs = (): PendingSyncItem[] => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error('[getPendingSyncs] Failed to parse:', error);
    return [];
  }
};

/**
 * Add a new pending sync item to the queue
 *
 * @param {Omit<PendingSyncItem, 'id' | 'retryCount'>} item - Item to enqueue (without id/retryCount)
 */
export const enqueuePendingSync = async (item: Omit<PendingSyncItem, 'id' | 'retryCount'>) => {
  const pending = getPendingSyncs();

  const newItem: PendingSyncItem = {
    ...item,
    id: crypto.randomUUID(),
    retryCount: 0
  };

  pending.push(newItem);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
    console.log('[enqueuePendingSync] Added to queue:', newItem.id);
  } catch (error) {
    console.error('[enqueuePendingSync] Failed to save:', error);
  }
};

/**
 * Process all pending sync items in the queue
 *
 * - Items exceeding max retries are discarded
 * - Successful syncs are removed from queue
 * - Failed items have retry count incremented and remain in queue
 * - Implements exponential backoff: retries wait before next attempt
 *
 * @returns {Promise<{ success: number; failed: number }>} Count of successful and failed syncs
 */
export const processPendingSyncs = async (): Promise<{ success: number; failed: number }> => {
  const pending = getPendingSyncs();

  if (pending.length === 0) {
    return { success: 0, failed: 0 };
  }

  console.log(`[processPendingSyncs] Processing ${pending.length} items...`);

  let successCount = 0;
  let failedCount = 0;
  const remaining: PendingSyncItem[] = [];

  for (const item of pending) {
    try {
      // Check retry limit
      if (item.retryCount && item.retryCount >= MAX_RETRY_COUNT) {
        console.error('[processPendingSyncs] Max retries exceeded:', item.id);
        failedCount++;
        continue;  // Discard item
      }

      // Attempt sync
      await recordTestAndSyncStats(
        item.testCount,
        item.correctCount,
        item.points
      );

      // Success: remove from queue
      successCount++;
      console.log('[processPendingSyncs] Synced:', item.id);

    } catch (error) {
      // Failure: increment retry count
      item.retryCount = (item.retryCount || 0) + 1;
      item.lastError = error instanceof Error ? error.message : String(error);

      // Calculate next retry delay
      const delayIndex = Math.min(
        item.retryCount - 1,
        RETRY_DELAYS.length - 1
      );
      const delay = RETRY_DELAYS[delayIndex];

      // Check if should delay retry
      if (delay > 0) {
        const nextRetry = item.timestamp + delay;
        if (Date.now() < nextRetry) {
          // Not yet time to retry, keep in queue
          remaining.push(item);
          continue;
        }
      }

      remaining.push(item);
      console.error('[processPendingSyncs] Failed, retrying:', item.id, item.retryCount);
    }
  }

  // Save remaining items
  localStorage.setItem(STORAGE_KEY, JSON.stringify(remaining));

  console.log(`[processPendingSyncs] Completed: ${successCount} success, ${failedCount} failed, ${remaining.length} pending`);

  return { success: successCount, failed: failedCount };
};

/**
 * Clear the pending sync queue (use with caution)
 *
 * This permanently discards all pending sync items.
 */
export const clearPendingSyncs = () => {
  localStorage.removeItem(STORAGE_KEY);
  console.log('[clearPendingSyncs] Queue cleared');
};

/**
 * Get the number of pending sync items in the queue
 *
 * @returns {number} Queue size
 */
export const getPendingSyncCount = (): number => {
  return getPendingSyncs().length;
};

/**
 * Get summary of pending syncs for UI display
 *
 * @returns {{ count: number; oldestTimestamp: number | null }} Queue summary
 */
export const getPendingSyncSummary = (): { count: number; oldestTimestamp: number | null } => {
  const pending = getPendingSyncs();
  if (pending.length === 0) {
    return { count: 0, oldestTimestamp: null };
  }

  const oldest = pending.reduce((min, item) =>
    item.timestamp < min ? item.timestamp : min,
    pending[0].timestamp
  );

  return { count: pending.length, oldestTimestamp: oldest };
};
