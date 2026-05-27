import { adaptiveWordSelector } from './adaptiveWordSelector';
import {
  InputSession,
  PuzzleCardResult,
  PuzzleGameSelectionMode,
  PuzzleGameSummary,
  WordEntry,
} from '../types';

const TOTAL_WORDS = 9;
const TOTAL_DURATION_SECONDS = 90;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const normalizeText = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

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
): { words: WordEntry[]; selectionMode: PuzzleGameSelectionMode } => {
  const candidates = getPuzzleCandidateWords(allWords);
  const count = Math.min(targetCount, candidates.length);

  if (count <= 0) {
    return { words: [], selectionMode: smartSelectionEnabled ? 'smart' : 'random' };
  }

  if (smartSelectionEnabled) {
    return {
      words: adaptiveWordSelector.calculateQueue(allWords, candidates, count, sessions),
      selectionMode: 'smart',
    };
  }

  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  return {
    words: shuffled.slice(0, count),
    selectionMode: 'random',
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
  selectionMode: PuzzleGameSelectionMode
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
    results,
  };
};