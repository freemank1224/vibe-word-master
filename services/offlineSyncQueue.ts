import { createPendingSyncQueue, type NewPendingSync } from './pendingSyncQueueCore.ts';

let queue: ReturnType<typeof createPendingSyncQueue> | undefined;
const getQueue = () => queue ||= createPendingSyncQueue({
  storage: localStorage,
  now: Date.now,
  currentUserId: async () => {
    const { supabase } = await import('../lib/supabaseClient');
    const { data, error } = await supabase.auth.getUser();
    if (error) throw error;
    return data.user?.id || null;
  },
  send: async item => {
    const { recordTestAndSyncStats } = await import('./dataService');
    return recordTestAndSyncStats(item.testCount, item.correctCount, item.points, item.expectedVersion, {
      eventId: item.id, occurredAt: item.timestamp, userId: item.userId!,
    });
  },
});

export const getPendingSyncs = (userId: string) => getQueue().read(userId);
export const enqueuePendingSync = async (item: NewPendingSync) => getQueue().enqueue(item);
export const processPendingSyncs = (userId: string) => getQueue().process(userId);
export const getPendingSyncCount = (userId: string) => getPendingSyncs(userId).length;
export const getPendingSyncSummary = (userId: string) => {
  const items = getPendingSyncs(userId);
  return { count: items.length, oldestTimestamp: items.length ? Math.min(...items.map(item => item.timestamp)) : null };
};

/** Old records have no owner. Keep them untouched instead of assigning them to whoever signs in. */
export const hasUnattributedLegacySyncs = () => {
  const raw = localStorage.getItem('vibe_pending_syncs');
  return !!raw && raw !== '[]';
};
