/**
 * Phase E: Unit Tests for Version Comparison and Merge
 */

import { compareVersions, mergeStats, resolveStatsUpdate, isLocalNewer } from '../../utils/versionMerge';
import { DayStats, DayStatsWithVersion } from '../../types';

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

      expect(result.hasConflict).toBe(false);
      expect(result.resolution).toBe('none');
      expect(result.localVersion).toBe(1);
      expect(result.serverVersion).toBe(1);
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

      expect(result.hasConflict).toBe(true);
      expect(result.resolution).toBe('merged');
      expect(result.localVersion).toBe(1);
      expect(result.serverVersion).toBe(2);
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

      expect(result.hasConflict).toBe(false);
      expect(result.resolution).toBe('server');
      expect(result.localVersion).toBeUndefined();
      expect(result.serverVersion).toBe(2);
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

      expect(merged.total).toBe(20);  // MAX(10, 20)
      expect(merged.correct).toBe(12);  // MAX(6, 12)
      expect(merged.points).toBe(30.0);  // MAX(15, 30)
      expect(merged.version).toBe(2);  // MAX(1, 2)
      expect(merged._conflict).toBe(true);
      expect(merged._resolved).toBe('merged');
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

      expect(merged.updated_at).toBe('2025-02-13T12:00:00Z');
      expect(merged.is_frozen).toBe(false);
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

      expect(result['2025-02-13']).toBeDefined();
      expect(result['2025-02-13'].total).toBe(20);
      expect(result['2025-02-13'].version).toBe(2);
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

      expect(result['2025-02-13']._conflict).toBe(true);
      expect(result['2025-02-13']._resolved).toBe('merged');
      expect(result['2025-02-13'].total).toBe(20);  // Merged MAX
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

      expect(result['2025-02-12'].total).toBe(5);  // Unchanged
      expect(result['2025-02-13']._conflict).toBe(true);  // Merged
      expect(result['2025-02-13'].total).toBe(20);
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

      expect(isLocalNewer(local, server)).toBe(true);
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

      expect(isLocalNewer(local, server)).toBe(false);
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

      expect(isLocalNewer(local, server)).toBe(true);
    });
  });
});
