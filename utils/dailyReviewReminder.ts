/** Account-scoped daily reminder history; rewards and reviews share Shanghai days. */
export interface ReminderStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const dailyReviewReminderKey = (userId: string) => `vibe_review_reminder_v1:${userId}`;

export function createReviewReminderHistory(storage: () => ReminderStorage | undefined) {
  const seen = new Map<string, string>();
  return {
    hasSeen(userId: string, day: string) {
      if (seen.get(userId) === day) return true;
      try { return storage()?.getItem(dailyReviewReminderKey(userId)) === day; } catch { return false; }
    },
    markSeen(userId: string, day: string) {
      seen.set(userId, day);
      try { storage()?.setItem(dailyReviewReminderKey(userId), day); } catch { /* Session guard still works without storage. */ }
    },
  };
}

export function shouldShowDailyReviewReminder(state: {
  userId: string | null; day: string; dueCount: number;
  dataReady: boolean; rewardReady: boolean; blocked: boolean;
}, history: Pick<ReturnType<typeof createReviewReminderHistory>, 'hasSeen'>): boolean {
  return !!state.userId && state.dueCount > 0 && state.dataReady && state.rewardReady
    && !state.blocked && !history.hasSeen(state.userId, state.day);
}
