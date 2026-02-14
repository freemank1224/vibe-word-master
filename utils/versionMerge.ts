/**
 * Phase E: Data Consistency Utilities
 * Version comparison and merge strategies for statistics
 */

import { DayStats, DayStatsWithVersion } from '../types';

/**
 * Version comparison result
 */
export interface VersionComparison {
  hasConflict: boolean;
  localVersion: number | undefined;
  serverVersion: number | undefined;
  resolution: 'local' | 'server' | 'merged' | 'none';
}

/**
 * Compare local and server versions
 * @param local - Local stats state (may be undefined)
 * @param server - Server stats from database
 * @returns Comparison result
 */
export const compareVersions = (
  local: DayStatsWithVersion | undefined,
  server: DayStats
): VersionComparison => {
  // If no local version exists, server wins
  if (!local || local.version === undefined) {
    return {
      hasConflict: false,
      localVersion: undefined,
      serverVersion: server.version,
      resolution: 'server'
    };
  }

  const localVersion = local.version || 0;
  const serverVersion = server.version || 0;

  // Versions match - no conflict
  if (localVersion === serverVersion) {
    return {
      hasConflict: false,
      localVersion,
      serverVersion,
      resolution: 'none'
    };
  }

  // Version mismatch detected!
  return {
    hasConflict: true,
    localVersion,
    serverVersion,
    resolution: 'merged'  // Default to merge strategy
  };
};

/**
 * Merge strategy for conflicting stats
 * Uses MAX values to ensure no data is lost
 * @param local - Local stats
 * @param server - Server stats
 * @returns Merged stats
 */
export const mergeStats = (
  local: DayStatsWithVersion,
  server: DayStats
): DayStatsWithVersion => {
  // Use MAX values to preserve all data
  const merged: DayStatsWithVersion = {
    date: server.date,  // Always use server date as source of truth
    total: Math.max(local.total, server.total),
    correct: Math.max(local.correct, server.correct),
    points: Math.max(local.points || 0, server.points || 0),
    version: Math.max(local.version || 0, server.version || 0),
    updated_at: server.updated_at,
    is_frozen: server.is_frozen,

    // Mark as conflict-merged
    _conflict: true,
    _resolved: 'merged'
  };

  return merged;
};

/**
 * Resolve stats update with version awareness
 * This is the main function to call when loading stats from server
 * @param currentLocal - Current local stats state
 * @param serverStats - Stats loaded from server
 * @returns Updated stats map with conflict resolution
 */
export const resolveStatsUpdate = (
  currentLocal: Record<string, DayStatsWithVersion>,
  serverStats: DayStats[]
): Record<string, DayStatsWithVersion> => {
  const updated: Record<string, DayStatsWithVersion> = { ...currentLocal };

  for (const server of serverStats) {
    const local = updated[server.date];

    // No local data exists - use server directly
    if (!local) {
      updated[server.date] = {
        ...server,
        version: server.version || 1
      };
      continue;
    }

    // Compare versions
    const comparison = compareVersions(local, server);

    if (comparison.hasConflict) {
      console.warn(`[resolveStatsUpdate] ⚠️ Version conflict detected for ${server.date}:`, {
        localVersion: comparison.localVersion,
        serverVersion: comparison.serverVersion
      });

      // Merge the stats
      const merged = mergeStats(local, server);
      updated[server.date] = merged;

      console.info(`[resolveStatsUpdate] ✅ Merged stats for ${server.date}:`, {
        total: merged.total,
        correct: merged.correct,
        points: merged.points
      });
    } else {
      // No conflict - use server data
      updated[server.date] = {
        ...server,
        version: server.version || 1
      };
    }
  }

  return updated;
};

/**
 * Check if local stats are newer than server stats
 * @param local - Local stats
 * @param server - Server stats
 * @returns true if local is newer
 */
export const isLocalNewer = (
  local: DayStatsWithVersion,
  server: DayStats
): boolean => {
  const localVersion = local.version || 0;
  const serverVersion = server.version || 0;

  // Check timestamps if available
  if (local.updated_at && server.updated_at) {
    return new Date(local.updated_at) > new Date(server.updated_at);
  }

  // Fall back to version comparison
  return localVersion > serverVersion;
};
