import type { PendingSyncItem } from '../types.ts';
import { getShanghaiDateString } from '../utils/timezone.ts';

export interface TestStatsReceipt {
  event_id: string;
  synced_date: string;
  total_tests: number;
  correct_tests: number;
  total_points: number;
  version: number;
  coins_awarded: number;
}

/** An HTTP success is not an acknowledgement without the matching event. */
export function parseTestStatsReceipt(data: unknown, event: Pick<PendingSyncItem, 'id' | 'date'>): TestStatsReceipt {
  const value = Array.isArray(data) && data.length === 1 ? data[0] : data;
  if (!value || typeof value !== 'object') throw new Error('统计同步未返回确认记录。');
  const row = value as Record<string, unknown>;
  if (row.event_id !== event.id || row.synced_date !== event.date) throw new Error('统计同步确认与原始事件不一致。');
  for (const field of ['total_tests', 'correct_tests', 'total_points', 'version', 'coins_awarded'] as const) {
    if (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] < 0) throw new Error(`统计同步确认缺少有效 ${field}。`);
  }
  if (Number(row.correct_tests) > Number(row.total_tests)) throw new Error('统计同步正确数超过总数。');
  return row as unknown as TestStatsReceipt;
}

export function validateTestStatsEvent(event: PendingSyncItem): void {
  if (!event || !event.id || !event.userId || !Number.isFinite(event.timestamp) || event.timestamp <= 0 || event.date !== getShanghaiDateString(event.timestamp)) throw new Error('测试记录缺少账号、事件编号或原始日期。');
  if (!Number.isInteger(event.testCount) || event.testCount <= 0 || !Number.isInteger(event.correctCount) || event.correctCount < 0 || event.correctCount > event.testCount || !Number.isFinite(event.points) || event.points < 0) throw new Error('测试记录的数量或分数无效。');
}
