/**
 * Unit tests for Offline Sync Queue Service (Phase C)
 *
 * @module __tests__/services/offlineSyncQueue.test
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  getPendingSyncs,
  enqueuePendingSync,
  processPendingSyncs,
  clearPendingSyncs,
  getPendingSyncCount,
  getPendingSyncSummary
} from '../offlineSyncQueue';
import { PendingSyncItem } from '../../types';

// Mock dataService
jest.mock('../dataService', () => ({
  recordTestAndSyncStats: jest.fn()
}));

describe('Offline Sync Queue', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
  });

  describe('getPendingSyncs', () => {
    it('should return empty array when queue is empty', () => {
      const result = getPendingSyncs();
      expect(result).toEqual([]);
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return items from localStorage', () => {
      const testItem: PendingSyncItem = {
        id: 'test-123',
        date: '2025-02-13',
        testCount: 10,
        correctCount: 6,
        points: 15.0,
        expectedVersion: 0,
        timestamp: Date.now()
      };

      localStorage.setItem('vibe_pending_syncs', JSON.stringify([testItem]));

      const result = getPendingSyncs();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(testItem);
    });

    it('should handle corrupted localStorage gracefully', () => {
      localStorage.setItem('vibe_pending_syncs', 'invalid-json{');

      const result = getPendingSyncs();
      expect(result).toEqual([]);
    });
  });

  describe('enqueuePendingSync', () => {
    it('should add item to empty queue', async () => {
      await enqueuePendingSync({
        date: '2025-02-13',
        testCount: 10,
        correctCount: 6,
        points: 15.0,
        expectedVersion: 0,
        timestamp: Date.now()
      });

      const result = getPendingSyncs();
      expect(result).toHaveLength(1);
      expect(result[0].toMatchObject({
        date: '2025-02-13',
        testCount: 10,
        correctCount: 6,
        points: 15.0,
        expectedVersion: 0,
        retryCount: 0
      });
      expect(result[0].id).toBeDefined();
      expect(typeof result[0].id).toBe('string');
    });

    it('should add multiple items to queue', async () => {
      await enqueuePendingSync({
        date: '2025-02-13',
        testCount: 10,
        correctCount: 6,
        points: 15.0,
        expectedVersion: 0,
        timestamp: Date.now()
      });

      await enqueuePendingSync({
        date: '2025-02-14',
        testCount: 5,
        correctCount: 4,
        points: 7.2,
        expectedVersion: 1,
        timestamp: Date.now()
      });

      const result = getPendingSyncs();
      expect(result).toHaveLength(2);
    });
  });

  describe('getPendingSyncCount', () => {
    it('should return 0 for empty queue', () => {
      const count = getPendingSyncCount();
      expect(count).toBe(0);
    });

    it('should return correct count for non-empty queue', async () => {
      await enqueuePendingSync({
        date: '2025-02-13',
        testCount: 10,
        correctCount: 6,
        points: 15.0,
        expectedVersion: 0,
        timestamp: Date.now()
      });

      await enqueuePendingSync({
        date: '2025-02-14',
        testCount: 5,
        correctCount: 4,
        points: 7.2,
        expectedVersion: 1,
        timestamp: Date.now()
      });

      const count = getPendingSyncCount();
      expect(count).toBe(2);
    });
  });

  describe('getPendingSyncSummary', () => {
    it('should return empty summary for empty queue', () => {
      const summary = getPendingSyncSummary();
      expect(summary).toEqual({
        count: 0,
        oldestTimestamp: null
      });
    });

    it('should return correct summary for non-empty queue', async () => {
      const now = Date.now();
      const olderTimestamp = now - 10000;

      await enqueuePendingSync({
        date: '2025-02-13',
        testCount: 10,
        correctCount: 6,
        points: 15.0,
        expectedVersion: 0,
        timestamp: now
      });

      await enqueuePendingSync({
        date: '2025-02-14',
        testCount: 5,
        correctCount: 4,
        points: 7.2,
        expectedVersion: 1,
        timestamp: olderTimestamp
      });

      const summary = getPendingSyncSummary();
      expect(summary.count).toBe(2);
      expect(summary.oldestTimestamp).toBe(olderTimestamp);
    });
  });

  describe('clearPendingSyncs', () => {
    it('should remove all items from queue', async () => {
      await enqueuePendingSync({
        date: '2025-02-13',
        testCount: 10,
        correctCount: 6,
        points: 15.0,
        expectedVersion: 0,
        timestamp: Date.now()
      });

      expect(getPendingSyncCount()).toBe(1);

      clearPendingSyncs();

      expect(getPendingSyncCount()).toBe(0);
      expect(localStorage.getItem('vibe_pending_syncs')).toBeNull();
    });
  });

  describe('processPendingSyncs', () => {
    it('should return zeros for empty queue', async () => {
      const result = await processPendingSyncs();
      expect(result).toEqual({
        success: 0,
        failed: 0
      });
    });

    it('should process items successfully (mock)', async () => {
      const { recordTestAndSyncStats } = await import('../dataService');

      // Mock successful sync
      (recordTestAndSyncStats as jest.Mock).mockResolvedValue({});

      await enqueuePendingSync({
        date: '2025-02-13',
        testCount: 10,
        correctCount: 6,
        points: 15.0,
        expectedVersion: 0,
        timestamp: Date.now()
      });

      const result = await processPendingSyncs();

      expect(result.success).toBe(1);
      expect(result.failed).toBe(0);
      expect(getPendingSyncCount()).toBe(0);
    });

    it('should increment retry count on failure (mock)', async () => {
      const { recordTestAndSyncStats } = await import('../dataService');

      // Mock failed sync
      (recordTestAndSyncStats as jest.Mock).mockRejectedValue(new Error('Network error'));

      await enqueuePendingSync({
        date: '2025-02-13',
        testCount: 10,
        correctCount: 6,
        points: 15.0,
        expectedVersion: 0,
        timestamp: Date.now()
      });

      const result = await processPendingSyncs();

      expect(result.success).toBe(0);
      expect(result.failed).toBe(0);  // Not failed yet, just retrying
      expect(getPendingSyncCount()).toBe(1);

      const pending = getPendingSyncs();
      expect(pending[0].retryCount).toBe(1);
      expect(pending[0].lastError).toBe('Network error');
    });

    it('should discard items exceeding max retries', async () => {
      const { recordTestAndSyncStats } = await import('../dataService');

      // Mock failed sync
      (recordTestAndSyncStats as jest.Mock).mockRejectedValue(new Error('Network error'));

      await enqueuePendingSync({
        date: '2025-02-13',
        testCount: 10,
        correctCount: 6,
        points: 15.0,
        expectedVersion: 0,
        timestamp: Date.now()
      });

      // Process 4 times (exceeds MAX_RETRY_COUNT of 3)
      await processPendingSyncs();  // retry 1
      await processPendingSyncs();  // retry 2
      await processPendingSyncs();  // retry 3
      const result = await processPendingSyncs();  // retry 4 - should discard

      expect(result.failed).toBe(1);
      expect(getPendingSyncCount()).toBe(0);
    });
  });
});
