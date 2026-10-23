import { adaptiveWordSelector } from './adaptiveWordSelector.ts';
import { getShanghaiDateString } from '../utils/timezone.ts';
import { calculatePuzzlePracticeSummary } from '../utils/puzzleRules.ts';
import type {
  InputSession,
  PuzzleCardResult,
  PuzzleGameSelectionMode,
  PuzzleGameSummary,
  WordEntry,
} from '../types.ts';

const TOTAL_WORDS = 9;

const PUZZLE_DAILY_SELECTION_HISTORY_KEY = 'vibe_puzzle_daily_selection_history';
const PUZZLE_DAILY_HISTORY_LIMIT = 12;
const MAX_SCORING_OVERLAP_RATE = 0.8;

interface PuzzleDailySelectionHistory {
  date: string;
  rounds: string[][];
}

interface PuzzleSelectionResult {
  words: WordEntry[];
  selectionMode: PuzzleGameSelectionMode;
  overlapRate: number;
  rankingEligible: boolean;
  rankingIneligibleReason?: string | null;
}

const shuffleWords = (words: WordEntry[]) => {
  const result = [...words];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }

  return result;
};

const loadDailyPuzzleSelectionHistory = (): PuzzleDailySelectionHistory => {
  if (typeof window === 'undefined') {
    return { date: getShanghaiDateString(), rounds: [] };
  }

  try {
    const raw = window.localStorage.getItem(PUZZLE_DAILY_SELECTION_HISTORY_KEY);
    if (!raw) {
      return { date: getShanghaiDateString(), rounds: [] };
    }

    const parsed = JSON.parse(raw);
    const today = getShanghaiDateString();
    if (!parsed || typeof parsed !== 'object' || parsed.date !== today || !Array.isArray(parsed.rounds)) {
      return { date: today, rounds: [] };
    }

    return {
      date: today,
      rounds: parsed.rounds
        .filter((round: unknown): round is string[] => Array.isArray(round))
        .map((round) => round.filter((value): value is string => typeof value === 'string')),
    };
  } catch {
    return { date: getShanghaiDateString(), rounds: [] };
  }
};

export const recordCompletedPuzzleSelection = (words: WordEntry[]) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const today = getShanghaiDateString();
    const current = loadDailyPuzzleSelectionHistory();
    const nextRound = words.map((word) => word.id);
    const rounds = current.date === today ? current.rounds : [];

    window.localStorage.setItem(
      PUZZLE_DAILY_SELECTION_HISTORY_KEY,
      JSON.stringify({
        date: today,
        rounds: [...rounds, nextRound].slice(-PUZZLE_DAILY_HISTORY_LIMIT),
      })
    );
  } catch {
    // Ignore localStorage failures and keep selection functional.
  }
};

const buildSmartPriorityPool = (
  allWords: WordEntry[],
  candidates: WordEntry[],
  sessions: InputSession[],
  count: number,
) => {
  const prioritized = adaptiveWordSelector.calculateQueue(allWords, candidates, count, sessions);
  if (prioritized.length >= count) {
    return prioritized;
  }

  const selectedIds = new Set(prioritized.map((word) => word.id));
  const remainder = candidates.filter((word) => !selectedIds.has(word.id));
  return [...prioritized, ...shuffleWords(remainder)];
};

const calculateMaxOverlapRate = (selectedWords: WordEntry[], previousRounds: string[][]) => {
  if (selectedWords.length === 0 || previousRounds.length === 0) {
    return 0;
  }

  const selectedIds = new Set(selectedWords.map((word) => word.id));
  const maxOverlapCount = previousRounds.reduce((maxCount, round) => {
    const overlapCount = round.reduce((count, wordId) => count + (selectedIds.has(wordId) ? 1 : 0), 0);
    return Math.max(maxCount, overlapCount);
  }, 0);

  return maxOverlapCount / selectedWords.length;
};

export { normalizePuzzleAnswer } from '../utils/puzzleRules.ts';

export const getPuzzleImageUrl = (word: WordEntry): string | null => {
  if (word.image_url) return word.image_url;
  const path = word.image_path;
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const base = process.env.SUPABASE_URL;
  return base ? `${base.replace(/\/$/, '')}/storage/v1/object/public/vocab-images/${path.split('/').map(encodeURIComponent).join('/')}` : null;
};

export const hasPuzzleImage = (word: WordEntry) => Boolean(getPuzzleImageUrl(word));

// Check game eligibility first, then let the shared scheduler keep the most
// urgent copy of each word. Array order must not hide an overdue duplicate.
export const getPuzzleCandidateWords = (words: WordEntry[]) => adaptiveWordSelector
  .rankCandidates(words.filter((word) => !word.deleted && hasPuzzleImage(word)))
  .map(({ word }) => word);

export const selectPuzzleWords = (
  allWords: WordEntry[],
  sessions: InputSession[],
  smartSelectionEnabled: boolean,
  targetCount: number = TOTAL_WORDS
): PuzzleSelectionResult => {
  const candidates = getPuzzleCandidateWords(allWords);
  const count = Math.min(targetCount, candidates.length);

  if (count <= 0) {
    return {
      words: [],
      selectionMode: smartSelectionEnabled ? 'smart' : 'random',
      overlapRate: 0,
      rankingEligible: true,
      rankingIneligibleReason: null,
    };
  }

  if (smartSelectionEnabled) {
    const dailyHistory = loadDailyPuzzleSelectionHistory();
    const prioritizedSelection = buildSmartPriorityPool(allWords, candidates, sessions, count);
    // Practice must not suppress due reviews merely because they appeared today.
    // Shuffle positions only after the memory-priority shortlist has been chosen.
    const rotatedSelection = shuffleWords(prioritizedSelection.slice(0, count));
    const overlapRate = calculateMaxOverlapRate(rotatedSelection, dailyHistory.rounds);

    return {
      words: rotatedSelection,
      selectionMode: 'smart',
      overlapRate,
      rankingEligible: overlapRate <= MAX_SCORING_OVERLAP_RATE,
      rankingIneligibleReason: overlapRate > MAX_SCORING_OVERLAP_RATE ? 'overlap_too_high' : null,
    };
  }

  const shuffled = shuffleWords(candidates);
  const dailyHistory = loadDailyPuzzleSelectionHistory();
  const selection = shuffled.slice(0, count);
  const overlapRate = calculateMaxOverlapRate(selection, dailyHistory.rounds);

  return {
    words: selection,
    selectionMode: 'random',
    overlapRate,
    rankingEligible: overlapRate <= MAX_SCORING_OVERLAP_RATE,
    rankingIneligibleReason: overlapRate > MAX_SCORING_OVERLAP_RATE ? 'overlap_too_high' : null,
  };
};

// Keep the previous call signature compatible while the UI adopts versioned practice rules.
export const calculatePuzzleGameSummary = (
  results: PuzzleCardResult[],
  elapsedMs: number,
  selectionMode: PuzzleGameSelectionMode,
  overlapRate: number,
  _rankingEligible: boolean,
  _rankingIneligibleReason?: string | null,
): PuzzleGameSummary => calculatePuzzlePracticeSummary(results, elapsedMs, selectionMode, overlapRate);
