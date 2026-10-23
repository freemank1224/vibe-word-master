/**
 * Phase E: Unit Tests for Version Comparison and Merge
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compareVersions, mergeStats, resolveStatsUpdate, isLocalNewer } from '../../utils/versionMerge.ts';
import type { DayStats, DayStatsWithVersion } from '../../types.ts';

describe('Version Comparison', () => {
  describe('compareVersions', () => {
    it('should return no conflict when versions match', () => {
      const local: DayStatsWithVersion = {
        date: '2025-02-13',
        total: 10,
        correct: 6,
        points: 15.0,
        version: 1
      };

      const server: DayStats = {
        date: '2025-02-13',
        total: 10,
        correct: 6,
        points: 15.0,
        version: 1
      };

      const result = compareVersions(local, server);

      assert.equal(result.hasConflict, false);
      assert.equal(result.resolution, 'none');
      assert.equal(result.localVersion, 1);
      assert.equal(result.serverVersion, 1);
    });

    it('should detect conflict when versions differ', () => {
      const local: DayStatsWithVersion = {
        date: '2025-02-13',
        total: 10,
        correct: 6,
        points: 15.0,
        version: 1
      };

      const server: DayStats = {
        date: '2025-02-13',
        total: 20,  // Server has more data
        correct: 12,
        points: 30.0,
        version: 2  // Higher version
      };

      const result = compareVersions(local, server);

      assert.equal(result.hasConflict, true);
      assert.equal(result.resolution, 'merged');
      assert.equal(result.localVersion, 1);
      assert.equal(result.serverVersion, 2);
    });

    it('should return server resolution when no local version exists', () => {
      const local = undefined;
      const server: DayStats = {
        date: '2025-02-13',
        total: 20,
        correct: 12,
        points: 30.0,
        version: 2
      };

      const result = compareVersions(local, server);

      assert.equal(result.hasConflict, false);
      assert.equal(result.resolution, 'server');
      assert.equal(result.localVersion, undefined);
      assert.equal(result.serverVersion, 2);
    });
  });

  describe('mergeStats', () => {
    it('should merge using MAX values to preserve all data', () => {
      const local: DayStatsWithVersion = {
        date: '2025-02-13',
        total: 10,
        correct: 6,
        points: 15.0,
        version: 1
      };

      const server: DayStats = {
        date: '2025-02-13',
        total: 20,  // Device B tested 10 more words
        correct: 12,
        points: 30.0,
        version: 2
      };

      const merged = mergeStats(local, server);

      assert.equal(merged.total, 20);  // MAX(10, 20)
      assert.equal(merged.correct, 12);  // MAX(6, 12)
      assert.equal(merged.points, 30.0);  // MAX(15, 30)
      assert.equal(merged.version, 2);  // MAX(1, 2)
      assert.equal(merged._conflict, true);
      assert.equal(merged._resolved, 'merged');
    });

    it('should include server metadata', () => {
      const local: DayStatsWithVersion = {
        date: '2025-02-13',
        total: 10,
        correct: 6
      };

      const server: DayStats = {
        date: '2025-02-13',
        total: 20,
        correct: 12,
        version: 2,
        updated_at: '2025-02-13T12:00:00Z',
        is_frozen: false
      };

      const merged = mergeStats(local, server);

      assert.equal(merged.updated_at, '2025-02-13T12:00:00Z');
      assert.equal(merged.is_frozen, false);
    });
  });

  describe('resolveStatsUpdate', () => {
    it('should use server data when no local data exists', () => {
      const local: Record<string, DayStatsWithVersion> = {};
      const serverStats: DayStats[] = [
        {
          date: '2025-02-13',
          total: 20,
          correct: 12,
          points: 30.0,
          version: 2
        }
      ];

      const result = resolveStatsUpdate(local, serverStats);

      assert.notEqual(result['2025-02-13'], undefined);
      assert.equal(result['2025-02-13'].total, 20);
      assert.equal(result['2025-02-13'].version, 2);
    });

    it('should merge conflicting stats', () => {
      const local: Record<string, DayStatsWithVersion> = {
        '2025-02-13': {
          date: '2025-02-13',
          total: 10,
          correct: 6,
          points: 15.0,
          version: 1
        }
      };

      const serverStats: DayStats[] = [
        {
          date: '2025-02-13',
          total: 20,  // More data from server
          correct: 12,
          points: 30.0,
          version: 2  // Higher version
        }
      ];

      const result = resolveStatsUpdate(local, serverStats);

      assert.equal(result['2025-02-13']._conflict, true);
      assert.equal(result['2025-02-13']._resolved, 'merged');
      assert.equal(result['2025-02-13'].total, 20);  // Merged MAX
    });

    it('should preserve non-conflicting dates', () => {
      const local: Record<string, DayStatsWithVersion> = {
        '2025-02-12': {
          date: '2025-02-12',
          total: 5,
          correct: 3,
          points: 7.5,
          version: 1
        },
        '2025-02-13': {
          date: '2025-02-13',
          total: 10,
          correct: 6,
          points: 15.0,
          version: 1
        }
      };

      const serverStats: DayStats[] = [
        {
          date: '2025-02-13',
          total: 20,
          correct: 12,
          points: 30.0,
          version: 2  // Only update 2025-02-13
        }
      ];

      const result = resolveStatsUpdate(local, serverStats);

      assert.equal(result['2025-02-12'].total, 5);  // Unchanged
      assert.equal(result['2025-02-13']._conflict, true);  // Merged
      assert.equal(result['2025-02-13'].total, 20);
    });
  });

  describe('isLocalNewer', () => {
    it('should return true when local version is higher', () => {
      const local: DayStatsWithVersion = {
        date: '2025-02-13',
        total: 10,
        correct: 6,
        version: 3,
        updated_at: '2025-02-13T12:00:00Z'
      };

      const server: DayStats = {
        date: '2025-02-13',
        total: 10,
        correct: 6,
        version: 2,
        updated_at: '2025-02-13T11:00:00Z'
      };

      assert.equal(isLocalNewer(local, server), true);
    });

    it('should return false when server version is higher', () => {
      const local: DayStatsWithVersion = {
        date: '2025-02-13',
        total: 10,
        correct: 6,
        version: 1,
        updated_at: '2025-02-13T11:00:00Z'
      };

      const server: DayStats = {
        date: '2025-02-13',
        total: 20,
        correct: 12,
        version: 2,
        updated_at: '2025-02-13T12:00:00Z'
      };

      assert.equal(isLocalNewer(local, server), false);
    });

    it('should compare timestamps when versions are equal', () => {
      const local: DayStatsWithVersion = {
        date: '2025-02-13',
        total: 10,
        correct: 6,
        version: 2,
        updated_at: '2025-02-13T12:05:00Z'  // Later timestamp
      };

      const server: DayStats = {
        date: '2025-02-13',
        total: 10,
        correct: 6,
        version: 2,
        updated_at: '2025-02-13T12:00:00Z'
      };

      assert.equal(isLocalNewer(local, server), true);
    });
  });
});
