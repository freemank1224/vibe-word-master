/** Deterministic, explainable selection: overdue reviews never lose to random sampling. */
import type { WordEntry, InputSession } from '../types.ts';
import { WORD_LEARNING_CONFIG } from '../config/wordLearningConfig.ts';
import { getReviewSchedule, type ReviewSchedule } from './reviewScheduler.ts';

export type ReviewSelectionCategory = 'due_relearning' | 'due_review' | 'new' | 'upcoming';
export interface RankedReviewWord {
  word: WordEntry;
  category: ReviewSelectionCategory;
  reason: string;
  dueAt: number | null;
  overdueDays: number;
  estimatedRetention: number | null;
  priority: number;
  schedule: ReviewSchedule;
}

export interface ReviewQueueSummary {
  candidateCount: number;
  selectedCount: number;
  dueRelearningCount: number;
  dueReviewCount: number;
  newCount: number;
  upcomingCount: number;
  remainingDueCount: number;
  nextDueAt: number | null;
}

export interface ReviewQueueResult {
  words: WordEntry[];
  selected: RankedReviewWord[];
  summary: ReviewQueueSummary;
}

const bands: Record<ReviewSelectionCategory, number> = { due_relearning: 0, due_review: 1, new: 2, upcoming: 3 };
const finiteOrZero = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
const textKey = (word: WordEntry) => `${(word.language || 'en').trim().toLowerCase()}:${word.text.normalize('NFKC').trim().toLowerCase()}`;
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export class AdaptiveWordSelector {
  private now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Sort before deduplication, so the most urgent copy of a word survives. */
  rankCandidates(availablePool: WordEntry[], now = this.now()): RankedReviewWord[] {
    const ranked = availablePool.filter(word => !word.deleted && typeof word.id === 'string' && word.id.trim() && typeof word.text === 'string' && word.text.trim()).map(word => {
      const schedule = getReviewSchedule(word, now);
      const category: ReviewSelectionCategory = schedule.isNew ? 'new' : schedule.isDue ? schedule.phase === 'review' ? 'due_review' : 'due_relearning' : 'upcoming';
      const relativeOverdue = schedule.overdueDays / Math.max(schedule.state?.stabilityDays ?? 1, 0.25);
      const priority = Math.min(1_000_000, relativeOverdue * 100) + (1 - (schedule.estimatedRetention ?? 1)) * 20 + (schedule.state?.difficulty ?? 0) + Math.min(20, schedule.state?.lapses ?? 0);
      const reason = category === 'due_relearning' ? schedule.phase === 'learning' ? '短期学习检查已到期' : '提示或失误后的重学已到期' : category === 'due_review' ? schedule.overdueDays > 0 ? '间隔复习已逾期' : '间隔复习已到期' : category === 'new' ? '本轮新词预算' : '到期词已优先安排，未到期词补位';
      return { word, schedule, category, reason, dueAt: schedule.dueAt, overdueDays: schedule.overdueDays, estimatedRetention: schedule.estimatedRetention, priority };
    });
    ranked.sort((a, b) => bands[a.category] - bands[b.category] ||
      (a.category === 'upcoming' ? (a.dueAt ?? 0) - (b.dueAt ?? 0) : a.category === 'new' ? finiteOrZero(a.word.timestamp) - finiteOrZero(b.word.timestamp) : b.priority - a.priority || (a.dueAt ?? 0) - (b.dueAt ?? 0)) ||
      compareText(textKey(a.word), textKey(b.word)) || compareText(a.word.id, b.word.id));
    const ids = new Set<string>();
    const texts = new Set<string>();
    return ranked.filter(({ word }) => {
      const text = textKey(word);
      if (ids.has(word.id) || texts.has(text)) return false;
      ids.add(word.id);
      texts.add(text);
      return true;
    });
  }

  /** Existing entry point retained for Classic, Puzzle and game callers. */
  calculateQueue(allWords: WordEntry[], availablePool: WordEntry[], targetCount: number, sessions?: InputSession[]): WordEntry[] {
    return this.calculateQueueWithSummary(allWords, availablePool, targetCount, sessions).words;
  }

  calculateQueueWithSummary(
    _allWords: WordEntry[], availablePool: WordEntry[], targetCount: number,
    _sessions?: InputSession[], now = this.now(),
  ): ReviewQueueResult {
    // The user's chosen pool is the boundary; never import unchecked words.
    const ranked = this.rankCandidates(availablePool, now);
    const count = Math.min(ranked.length, Math.floor(finiteOrZero(targetCount)));
    const due = ranked.filter(item => item.category === 'due_relearning' || item.category === 'due_review');
    const fresh = ranked.filter(item => item.category === 'new');
    const upcoming = ranked.filter(item => item.category === 'upcoming');
    const selected = due.slice(0, count);
    const newBudget = Math.min(count - selected.length, Math.ceil(count * WORD_LEARNING_CONFIG.reviewScheduler.newWordFraction));
    selected.push(...fresh.slice(0, newBudget));
    selected.push(...upcoming.slice(0, count - selected.length));
    // A new-only pool can still satisfy an explicitly requested practice size.
    selected.push(...fresh.slice(newBudget, newBudget + count - selected.length));
    return {
      words: selected.map(item => item.word), selected,
      summary: {
        candidateCount: ranked.length, selectedCount: selected.length,
        dueRelearningCount: selected.filter(item => item.category === 'due_relearning').length,
        dueReviewCount: selected.filter(item => item.category === 'due_review').length,
        newCount: selected.filter(item => item.category === 'new').length,
        upcomingCount: selected.filter(item => item.category === 'upcoming').length,
        remainingDueCount: due.length - selected.filter(item => item.schedule.isDue).length,
        nextDueAt: upcoming.length ? upcoming[0].dueAt : null,
      },
    };
  }
}

export const adaptiveWordSelector = new AdaptiveWordSelector();
