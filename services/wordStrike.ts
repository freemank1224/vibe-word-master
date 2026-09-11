// ================================================================
// WORD STRIKE — pure game logic for the physics typing-shooter.
//
// IMPORTANT: this module must stay free of matter-js and browser-only
// imports — `__tests__/wordStrike/*.test.ts` imports it directly under
// `node --test` (same contract as services/puzzleGame.ts, whose selection /
// summary shape this file mirrors 1:1).
//
// Sections:
//   1. constants + local storage history (daily overlap cap)
//   2. letter matching — the core game rule (per-position hit/miss)
//   3. candidate filter + word selection (smart via adaptiveWordSelector / random)
//   4. difficulty curve (gravity ramp + unit sizing)
//   5. summary calculation (0-1000, same spirit as calculatePuzzleGameSummary)
// ================================================================
// NOTE on imports: this module runs under `node --test` (type-stripping, real
// ESM resolution), so every runtime import must carry an explicit `.ts`
// extension and type-only imports must use `import type`. The smart selector
// is loaded lazily — its own module graph uses the `@/types` path alias which
// Node cannot resolve; in the browser (Vite) the dynamic import always
// succeeds, and if it ever fails we degrade to shuffled order gracefully.
import type {
  InputSession,
  PuzzleGameSelectionMode,
  WordEntry,
  WordStrikeCardResult,
  WordStrikeGameSummary,
} from '../types.ts';
import { getShanghaiDateString } from '../utils/timezone.ts';

export const WORD_STRIKE_BATCH_SIZE = 12;
export const WORD_STRIKE_MIN_WORDS = 5;
/** Bar must stay inside the 900px logical world — 14 units max (unit >= 26px). */
export const WORD_STRIKE_MAX_WORD_LENGTH = 14;
export const WORD_STRIKE_MIN_WORD_LENGTH = 2;
export const WORD_STRIKE_LIVES = 3;
/** Par duration used as the speed denominator (3s lives × ~60s per word pace). */
export const WORD_STRIKE_TOTAL_DURATION_SECONDS = 180;

const WORD_STRIKE_DAILY_SELECTION_HISTORY_KEY = 'vibe_word_strike_daily_selection_history';
const WORD_STRIKE_DAILY_HISTORY_LIMIT = 12;
const MAX_DAILY_OVERLAP_RATE = 0.6;
const MAX_SCORING_OVERLAP_RATE = 0.8;

interface WordStrikeDailySelectionHistory {
  date: string;
  rounds: string[][];
}

export interface WordStrikeSelectionResult {
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

// ----------------------------------------------------------------
// 1. daily selection history (prevents the same words every session)
// ----------------------------------------------------------------

const loadDailyStrikeSelectionHistory = (): WordStrikeDailySelectionHistory => {
  if (typeof window === 'undefined') {
    return { date: getShanghaiDateString(), rounds: [] };
  }

  try {
    const raw = window.localStorage.getItem(WORD_STRIKE_DAILY_SELECTION_HISTORY_KEY);
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

const saveDailyStrikeSelectionHistory = (words: WordEntry[]) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const today = getShanghaiDateString();
    const current = loadDailyStrikeSelectionHistory();
    const nextRound = words.map((word) => word.id);
    const rounds = current.date === today ? current.rounds : [];

    window.localStorage.setItem(
      WORD_STRIKE_DAILY_SELECTION_HISTORY_KEY,
      JSON.stringify({
        date: today,
        rounds: [...rounds, nextRound].slice(-WORD_STRIKE_DAILY_HISTORY_LIMIT),
      })
    );
  } catch {
    // Ignore localStorage failures and keep selection functional.
  }
};

type SmartQueueFn = (
  allWords: WordEntry[],
  candidates: WordEntry[],
  count: number,
  sessions?: InputSession[]
) => WordEntry[];

let smartQueueCache: SmartQueueFn | null = null;

/**
 * Lazy-load the adaptive selector. Kept dynamic (not a static import) because
 * the selector's module graph uses the `@/types` alias that plain Node cannot
 * resolve — under `node --test` this resolves to `null` and callers fall back
 * to shuffled order, which keeps the whole module unit-testable.
 */
const getSmartQueue = async (): Promise<SmartQueueFn | null> => {
  if (smartQueueCache) return smartQueueCache;
  try {
    const mod = await import('./adaptiveWordSelector');
    smartQueueCache = (allWords, candidates, count, sessions) =>
      mod.adaptiveWordSelector.calculateQueue(allWords, candidates, count, sessions);
  } catch {
    smartQueueCache = null;
  }
  return smartQueueCache;
};

const buildSmartPriorityPool = async (
  allWords: WordEntry[],
  candidates: WordEntry[],
  sessions: InputSession[]
): Promise<WordEntry[]> => {
  const smartQueue = await getSmartQueue();
  if (!smartQueue) {
    return shuffleWords(candidates);
  }

  const prioritized = smartQueue(allWords, candidates, candidates.length, sessions);
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

// ----------------------------------------------------------------
// 2. letter matching — the core rule, unit-tested
// ----------------------------------------------------------------

export const normalizeWordStrikeInput = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, '');

export interface LetterMatchResult {
  /** Target positions where the typed letter matches — these units shatter. */
  hits: number[];
  /** Target positions that are wrong or not yet typed — MISS floaters. */
  misses: number[];
  hitCount: number;
  missCount: number;
  /** Normalized typed string equals the target exactly (no extra letters). */
  isFullMatch: boolean;
}

/**
 * Compare the typed attempt against the target word position-by-position.
 * Both sides are normalized (trim / lowercase / inner whitespace stripped).
 * Extra typed letters beyond the target length are ignored (no unit maps to
 * them) but they do prevent a full match — the player must re-spell exactly.
 */
export const matchTypedWord = (target: string, typed: string): LetterMatchResult => {
  const normalizedTarget = normalizeWordStrikeInput(target);
  const normalizedTyped = normalizeWordStrikeInput(typed);

  const hits: number[] = [];
  const misses: number[] = [];

  for (let index = 0; index < normalizedTarget.length; index += 1) {
    if (index < normalizedTyped.length && normalizedTyped[index] === normalizedTarget[index]) {
      hits.push(index);
    } else {
      misses.push(index);
    }
  }

  return {
    hits,
    misses,
    hitCount: hits.length,
    missCount: misses.length,
    isFullMatch: normalizedTyped.length === normalizedTarget.length && normalizedTyped === normalizedTarget,
  };
};

// ----------------------------------------------------------------
// 3. candidate filter + selection
// ----------------------------------------------------------------

/**
 * Sampling scope for a round: the newest N input sessions, or the whole
 * library. Falls back to ALL words when the scoped pool is empty (e.g. fresh
 * account with no sessions yet, or session ids that no longer match).
 */
export type WordStrikeScope = 'recent3' | 'recent5' | 'all';

export const applyWordStrikeScope = (
  words: WordEntry[],
  sessions: InputSession[],
  scope: WordStrikeScope
): WordEntry[] => {
  if (scope === 'all') return words;

  const count = scope === 'recent3' ? 3 : 5;
  const recentIds = new Set(
    [...sessions]
      .filter((session) => !session.deleted)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, count)
      .map((session) => session.id)
  );

  if (recentIds.size === 0) return words;

  const scoped = words.filter((word) => recentIds.has(word.sessionId));
  return scoped.length > 0 ? scoped : words;
};


/**
 * Strike bricks are pure letter bars: anything with spaces, digits,
 * diacritics or CJK characters cannot render as units. Length is capped so
 * the bar physically fits the 900px logical world.
 */
export const getWordStrikeCandidateWords = (words: WordEntry[]): WordEntry[] => {
  const uniqueWords = new Map<string, WordEntry>();

  words
    .filter((word) => {
      if (word.deleted) return false;
      const text = word.text.trim();
      if (text.length < WORD_STRIKE_MIN_WORD_LENGTH || text.length > WORD_STRIKE_MAX_WORD_LENGTH) return false;
      return /^[a-z]+$/i.test(text);
    })
    .forEach((word) => {
      const key = normalizeText(word.text);
      if (!uniqueWords.has(key)) {
        uniqueWords.set(key, word);
      }
    });

  return Array.from(uniqueWords.values());
};

export const selectWordStrikeWords = async (
  allWords: WordEntry[],
  sessions: InputSession[],
  smartSelectionEnabled: boolean,
  targetCount: number = WORD_STRIKE_BATCH_SIZE
): Promise<WordStrikeSelectionResult> => {
  const candidates = getWordStrikeCandidateWords(allWords);
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
    const dailyHistory = loadDailyStrikeSelectionHistory();
    const prioritizedSelection = await buildSmartPriorityPool(allWords, candidates, sessions);
    const constrainedSelection = enforceDailyOverlapCap(prioritizedSelection, dailyHistory.rounds, count);
    const rotatedSelection = shuffleWords(constrainedSelection);
    const overlapRate = calculateMaxOverlapRate(rotatedSelection, dailyHistory.rounds);
    saveDailyStrikeSelectionHistory(rotatedSelection);

    return {
      words: rotatedSelection,
      selectionMode: 'smart',
      overlapRate,
      rankingEligible: overlapRate <= MAX_SCORING_OVERLAP_RATE,
      rankingIneligibleReason: overlapRate > MAX_SCORING_OVERLAP_RATE ? 'overlap_too_high' : null,
    };
  }

  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  const dailyHistory = loadDailyStrikeSelectionHistory();
  const selection = shuffled.slice(0, count);
  const overlapRate = calculateMaxOverlapRate(selection, dailyHistory.rounds);
  saveDailyStrikeSelectionHistory(selection);

  return {
    words: selection,
    selectionMode: 'random',
    overlapRate,
    rankingEligible: overlapRate <= MAX_SCORING_OVERLAP_RATE,
    rankingIneligibleReason: overlapRate > MAX_SCORING_OVERLAP_RATE ? 'overlap_too_high' : null,
  };
};

// ----------------------------------------------------------------
// 4. difficulty curve
// ----------------------------------------------------------------

/**
 * Gravity ramps with each spawned brick: word 0 floats gently (0.05),
 * +0.01 per brick, capped at 0.18 (3.6× the starting pull, reached around
 * brick 13 so a full 12-word round keeps accelerating throughout). Pure so
 * the ramp is unit-testable and the physics layer stays dumb.
 */
export const getWordStrikeGravityScale = (brickIndex: number): number =>
  clamp(0.05 + 0.01 * brickIndex, 0.05, 0.18);

/**
 * Square unit edge for a letter bar inside `worldWidth`: the whole bar spans
 * ~62% of the world, clamped to [26, 52]px. 26px is also the tunnelling
 * floor — the bullet moves 26px/step, so it can never skip a unit.
 */
export const getWordStrikeUnitSize = (letterCount: number, worldWidth: number): number => {
  if (letterCount <= 0) return 26;
  return clamp(Math.floor((worldWidth * 0.62) / letterCount), 26, 52);
};

// ----------------------------------------------------------------
// 5. summary (0-1000)
// ----------------------------------------------------------------

/** Per-word speed factor from brick activation to full shatter. */
const getWordSpeedFactor = (activatedAtMs: number | null, solvedAtMs: number | null) => {
  if (activatedAtMs == null || solvedAtMs == null || solvedAtMs <= activatedAtMs) {
    return 0.5;
  }

  const seconds = (solvedAtMs - activatedAtMs) / 1000;
  if (seconds <= 6) return 1.0;
  if (seconds <= 8) return 0.9;
  if (seconds <= 12) return 0.8;
  if (seconds <= 20) return 0.7;
  return 0.5;
};

export interface WordStrikeSummaryOptions {
  lettersHit: number;
  lettersFired: number;
  maxCombo: number;
  livesLost: number;
  livesRemaining: number;
  elapsedMs: number;
  selectionMode: PuzzleGameSelectionMode;
  overlapRate: number;
  rankingEligible: boolean;
  rankingIneligibleReason?: string | null;
}

export const calculateWordStrikeGameSummary = (
  results: WordStrikeCardResult[],
  options: WordStrikeSummaryOptions
): WordStrikeGameSummary => {
  const wordsTotal = results.length || WORD_STRIKE_BATCH_SIZE;
  const wordsCorrect = results.filter((result) => result.correct).length;
  const accuracyRate = wordsTotal > 0 ? wordsCorrect / wordsTotal : 0;
  const timeUsedSeconds = clamp(Math.ceil(options.elapsedMs / 1000), 0, WORD_STRIKE_TOTAL_DURATION_SECONDS);

  const lettersFired = Math.max(options.lettersFired, 0);
  const letterPrecision = lettersFired > 0 ? clamp(options.lettersHit / lettersFired, 0, 1) : 0;
  const accuracyScore = letterPrecision * 500;

  const correctResults = results.filter((result) => result.correct);
  const speedComponent =
    correctResults.length > 0
      ? correctResults.reduce(
          (sum, result) => sum + getWordSpeedFactor(result.activatedAtMs, result.solvedAtMs),
          0
        ) / correctResults.length
      : 0;
  const speedScore = speedComponent * 250;

  const comboComponent = Math.min(options.maxCombo / Math.max(wordsTotal, 1), 1);
  const comboScore = comboComponent * 150;

  const survivalScore = (wordsCorrect / wordsTotal) * 100;

  const totalScore = Math.round(
    clamp(accuracyScore + speedScore + comboScore + survivalScore, 0, 1000)
  );

  return {
    totalScore,
    accuracyRate: Number(accuracyRate.toFixed(4)),
    speedScore: accuracyRate >= 0.85 ? Math.round(speedComponent * 1000) : 0,
    comboScore: accuracyRate >= 0.85 ? Math.round(comboComponent * 1000) : 0,
    wordsCorrect,
    wordsTotal,
    livesLost: options.livesLost,
    livesRemaining: options.livesRemaining,
    maxCombo: options.maxCombo,
    lettersHit: options.lettersHit,
    lettersFired,
    timeUsedSeconds,
    selectionMode: options.selectionMode,
    overlapRate: Number(options.overlapRate.toFixed(4)),
    rankingEligible: options.rankingEligible,
    rankingIneligibleReason: options.rankingIneligibleReason || null,
    results,
  };
};
