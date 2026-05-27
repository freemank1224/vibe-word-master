import { adaptiveWordSelector } from './adaptiveWordSelector';
import { getShanghaiDateString } from '../utils/timezone';
import {
  InputSession,
  PuzzleCardResult,
  PuzzleGameSelectionMode,
  PuzzleGameSummary,
  WordEntry,
} from '../types';

const TOTAL_WORDS = 9;
const TOTAL_DURATION_SECONDS = 90;
const PUZZLE_DAILY_SELECTION_HISTORY_KEY = 'vibe_puzzle_daily_selection_history';
const PUZZLE_DAILY_HISTORY_LIMIT = 12;
const MAX_DAILY_OVERLAP_RATE = 0.6;
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

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const normalizeText = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

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

const saveDailyPuzzleSelectionHistory = (words: WordEntry[]) => {
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
  sessions: InputSession[]
) => {
  const prioritized = adaptiveWordSelector.calculateQueue(allWords, candidates, candidates.length, sessions);
  if (prioritized.length >= candidates.length) {
    return prioritized;
  }

  const selectedIds = new Set(prioritized.map((word) => word.id));
  const remainder = candidates.filter((word) => !selectedIds.has(word.id));
  return [...prioritized, ...shuffleWords(remainder)];
};

const enforceDailyOverlapCap = (
  prioritizedWords: WordEntry[],
  previousRounds: string[][],
  count: number
) => {
  if (previousRounds.length === 0) {
    return prioritizedWords.slice(0, count);
  }

  const maxOverlap = Math.floor(count * MAX_DAILY_OVERLAP_RATE);
  const roundSets = previousRounds.map((round) => new Set(round));
  const overlapCounts = roundSets.map(() => 0);
  const selected: WordEntry[] = [];
  const selectedIds = new Set<string>();

  for (const word of prioritizedWords) {
    if (selected.length >= count || selectedIds.has(word.id)) {
      continue;
    }

    const violatesCap = roundSets.some((roundSet, index) => roundSet.has(word.id) && overlapCounts[index] + 1 > maxOverlap);
    if (violatesCap) {
      continue;
    }

    selected.push(word);
    selectedIds.add(word.id);
    roundSets.forEach((roundSet, index) => {
      if (roundSet.has(word.id)) {
        overlapCounts[index] += 1;
      }
    });
  }

  if (selected.length >= count) {
    return selected.slice(0, count);
  }

  // If the candidate pool is too small to satisfy the cap, fill the remainder while minimizing repeats.
  for (const word of prioritizedWords) {
    if (selected.length >= count || selectedIds.has(word.id)) {
      continue;
    }

    selected.push(word);
    selectedIds.add(word.id);
  }

  return selected.slice(0, count);
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

export const normalizePuzzleAnswer = (value: string) => normalizeText(value);

export const hasPuzzleImage = (word: WordEntry) => Boolean(word.image_url || word.image_path);

export const getPuzzleImageUrl = (word: WordEntry) => word.image_url || null;

export const getPuzzleCandidateWords = (words: WordEntry[]) => {
  const uniqueWords = new Map<string, WordEntry>();

  words
    .filter((word) => !word.deleted && hasPuzzleImage(word))
    .forEach((word) => {
      const key = normalizeText(word.text);
      if (!uniqueWords.has(key)) {
        uniqueWords.set(key, word);
      }
    });

  return Array.from(uniqueWords.values());
};

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
    const prioritizedSelection = buildSmartPriorityPool(allWords, candidates, sessions);
    const constrainedSelection = enforceDailyOverlapCap(prioritizedSelection, dailyHistory.rounds, count);
    const rotatedSelection = shuffleWords(constrainedSelection);
    const overlapRate = calculateMaxOverlapRate(rotatedSelection, dailyHistory.rounds);
    saveDailyPuzzleSelectionHistory(rotatedSelection);

    return {
      words: rotatedSelection,
      selectionMode: 'smart',
      overlapRate,
      rankingEligible: overlapRate <= MAX_SCORING_OVERLAP_RATE,
      rankingIneligibleReason: overlapRate > MAX_SCORING_OVERLAP_RATE ? 'overlap_too_high' : null,
    };
  }

  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  const dailyHistory = loadDailyPuzzleSelectionHistory();
  const selection = shuffled.slice(0, count);
  const overlapRate = calculateMaxOverlapRate(selection, dailyHistory.rounds);
  saveDailyPuzzleSelectionHistory(selection);

  return {
    words: selection,
    selectionMode: 'random',
    overlapRate,
    rankingEligible: overlapRate <= MAX_SCORING_OVERLAP_RATE,
    rankingIneligibleReason: overlapRate > MAX_SCORING_OVERLAP_RATE ? 'overlap_too_high' : null,
  };
};

const getAttemptFactor = (attemptsUsed: number) => {
  if (attemptsUsed <= 1) return 1;
  if (attemptsUsed === 2) return 0.85;
  return 0.7;
};

const getSpeedFactor = (activatedAtMs: number | null, solvedAtMs: number | null) => {
  if (activatedAtMs == null || solvedAtMs == null || solvedAtMs <= activatedAtMs) {
    return 0.75;
  }

  const seconds = (solvedAtMs - activatedAtMs) / 1000;
  if (seconds <= 4) return 1.1;
  if (seconds <= 8) return 1.0;
  if (seconds <= 15) return 0.9;
  if (seconds <= 25) return 0.8;
  return 0.7;
};

export const calculatePuzzleGameSummary = (
  results: PuzzleCardResult[],
  elapsedMs: number,
  selectionMode: PuzzleGameSelectionMode,
  overlapRate: number,
  rankingEligible: boolean,
  rankingIneligibleReason?: string | null,
): PuzzleGameSummary => {
  const wordsTotal = results.length || TOTAL_WORDS;
  const wordsCorrect = results.filter((result) => result.correct).length;
  const hintsUsed = results.filter((result) => result.hintUsed).length;
  const solvedWithoutHint = results.filter((result) => result.correct && !result.hintUsed).length;
  const accuracyRate = wordsTotal > 0 ? wordsCorrect / wordsTotal : 0;
  const timeUsedSeconds = clamp(Math.ceil(elapsedMs / 1000), 0, TOTAL_DURATION_SECONDS);
  const secondsRemaining = clamp(TOTAL_DURATION_SECONDS - timeUsedSeconds, 0, TOTAL_DURATION_SECONDS);

  const rawQualityTotal = results.reduce((sum, result) => {
    if (!result.correct) return sum;

    const attemptFactor = getAttemptFactor(result.attemptsUsed);
    const hintFactor = result.hintUsed ? 0.8 : 1;
    const speedFactor = getSpeedFactor(result.activatedAtMs, result.solvedAtMs);

    return sum + (100 * attemptFactor * hintFactor * speedFactor);
  }, 0);

  const accuracyScore = accuracyRate * 700;
  const speedScore = (secondsRemaining / TOTAL_DURATION_SECONDS) * 200;
  const efficiencyBonus = (rawQualityTotal / (wordsTotal * 110)) * 100;
  const totalScore = Math.round(clamp(accuracyScore + speedScore + efficiencyBonus, 0, 1000));

  return {
    totalScore,
    accuracyRate: Number(accuracyRate.toFixed(4)),
    speedScore: accuracyRate >= 0.85 ? Math.round((secondsRemaining / TOTAL_DURATION_SECONDS) * 1000) : 0,
    noHintScore: accuracyRate >= 0.85 ? Math.round((solvedWithoutHint / wordsTotal) * 1000) : 0,
    wordsCorrect,
    wordsTotal,
    hintsUsed,
    solvedWithoutHint,
    timeUsedSeconds,
    secondsRemaining,
    selectionMode,
    overlapRate: Number(overlapRate.toFixed(4)),
    rankingEligible,
    rankingIneligibleReason: rankingIneligibleReason || null,
    results,
  };
};