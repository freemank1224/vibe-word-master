import type { WordEntry } from '../../types.ts';
import { adaptiveWordSelector, type ReviewQueueSummary } from '../../services/adaptiveWordSelector.ts';
import type { SurfWord } from './types.ts';

/** Default fixed round. Infinity explicitly selects every eligible word once. */
export const SURF_REVIEW_LIMIT = 20;
const han = /\p{Script=Han}/u;
const normalizeAnswer = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/[‐‑]/g, '-');
const cleanMeaning = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

export interface SurfReviewSummary extends ReviewQueueSummary {
  /** Invalid spelling, missing Chinese meaning, deleted or non-English entries. */
  excludedCount: number;
  duplicateCount: number;
}

export interface SurfReviewVocabulary {
  strategy: 'spaced-review';
  deck: readonly SurfWord[];
  /** Original records in exactly the deck order, for learning-event persistence. */
  entries: WordEntry[];
  summary: SurfReviewSummary;
}

/** Use the learner's chosen meaning; never invent a clue or expose its answer. */
export function toSurfReviewWord(word: WordEntry): SurfWord | null {
  const answer = normalizeAnswer(word.text || '');
  const language = (word.language || 'en').trim().toLowerCase();
  if (word.deleted || typeof word.id !== 'string' || !word.id.trim()
    || !/^en(?:-[a-z]{2,})?$/.test(language)
    || !/^[a-z]+(?:[-'][a-z]+)*$/.test(answer) || answer.length < 2 || answer.length > 24) return null;
  const selected = word.meaning_options?.find(option => option.key === word.selected_meaning_key);
  const meaningZh = cleanMeaning(selected?.meaningZh || word.definition_cn);
  const meaningEn = cleanMeaning(selected ? selected.definitionEn : word.definition_en);
  const answerInClue = new RegExp(`\\b${answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  if (!han.test(meaningZh) || meaningZh.length > 240 || answerInClue.test(meaningZh)) return null;
  return {
    wordId: word.id, answer, meaningZh,
    audioUrl: word.audio_url ?? null,
    meaningEn: han.test(meaningEn) ? '' : meaningEn.replace(new RegExp(answerInClue.source, 'gi'), '____').slice(0, 240),
  };
}

/**
 * The same forgetting-curve ranking as the rest of the app, with no shuffle:
 * due learning/relearning → due review (overdue/weak first) → new → upcoming.
 * Surf uses a finite deck, so every remaining due word outranks every filler.
 */
export function selectSurfReviewVocabulary(
  words: readonly WordEntry[], options: { limit?: number; now?: number } = {},
): SurfReviewVocabulary {
  const eligible = words.filter(word => toSurfReviewWord(word) !== null);
  const ranked = adaptiveWordSelector.rankCandidates(eligible, options.now ?? Date.now());
  // The app selector preserves language variants; Surf has one English answer
  // space, so en/en-US duplicates must also collapse after urgency ranking.
  const answers = new Set<string>();
  const unique = ranked.filter(({ word }) => {
    const answer = normalizeAnswer(word.text);
    if (answers.has(answer)) return false;
    answers.add(answer);
    return true;
  });
  const requested = options.limit ?? SURF_REVIEW_LIMIT;
  const count = requested === Infinity ? unique.length
    : Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0;
  const selected = unique.slice(0, count);
  const dueCount = unique.filter(item => item.schedule.isDue).length;
  const selectedDueCount = selected.filter(item => item.schedule.isDue).length;
  const upcoming = unique.find(item => item.category === 'upcoming');
  return {
    strategy: 'spaced-review',
    deck: Object.freeze(selected.map(item => Object.freeze({ ...toSurfReviewWord(item.word)!, reviewCategory: item.category }))),
    entries: selected.map(item => item.word),
    summary: {
      candidateCount: unique.length, selectedCount: selected.length,
      dueRelearningCount: selected.filter(item => item.category === 'due_relearning').length,
      dueReviewCount: selected.filter(item => item.category === 'due_review').length,
      newCount: selected.filter(item => item.category === 'new').length,
      upcomingCount: selected.filter(item => item.category === 'upcoming').length,
      remainingDueCount: dueCount - selectedDueCount,
      nextDueAt: upcoming?.dueAt ?? null,
      excludedCount: words.length - eligible.length,
      duplicateCount: eligible.length - unique.length,
    },
  };
}
