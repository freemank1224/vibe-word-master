import { adaptiveWordSelector } from './adaptiveWordSelector';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import { getShanghaiDateString } from '../utils/timezone';
import {
  InputSession,
  PuzzleGameSelectionMode,
  SceneAsset,
  SceneCardResult,
  SceneGameSummary,
  SceneLeaderboardEntry,
  SceneLeaderboardMetric,
  SceneLeaderboardScope,
  ScenePlayMode,
  SceneWordMeta,
  WordEntry,
  WordRegion,
} from '../types';

// ================================================================
// Scene Fusion Game — client service
// Selection (smart/random), prompt meta, scene generation request,
// haystack candidates, and scoring. Self-contained: mirrors the
// puzzleGame.ts structure but with a scene-specific daily-overlap
// history key and scene scoring.
// ================================================================

const SCENE_DAILY_SELECTION_HISTORY_KEY = 'vibe_scene_daily_selection_history';
const SCENE_DAILY_HISTORY_LIMIT = 12;
const MAX_DAILY_OVERLAP_RATE = 0.6;
const MAX_SCORING_OVERLAP_RATE = 0.8;

export const MIN_SCENE_WORDS = 5;
export const MAX_SCENE_WORDS = 10;

interface SceneDailySelectionHistory {
  date: string;
  rounds: string[][];
}

interface SceneSelectionResult {
  words: WordEntry[];
  selectionMode: PuzzleGameSelectionMode;
  overlapRate: number;
  rankingEligible: boolean;
  rankingIneligibleReason?: string | null;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const normalizeText = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

const shuffleWords = <T>(items: T[]): T[] => {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
};

// ----------------------------------------------------------------
// POS helpers
// ----------------------------------------------------------------
/** Map a raw partOfSpeech token ('n.', 'adj.', ...) to a prompt category. */
export const categorizePos = (raw: string | null | undefined): SceneWordMeta['pos'] => {
  if (!raw) return 'noun';
  const p = raw.trim().toLowerCase().replace(/\./g, '');
  if (p === 'noun' || p === 'n') return 'noun';
  if (p === 'adjective' || p === 'adj') return 'adjective';
  if (p === 'verb' || p === 'v') return 'verb';
  if (p === 'adverb' || p === 'adv') return 'adverb';
  // determiners / prepositions / conjunctions etc. -> render as objects
  return 'other';
};

/** POS category for a WordEntry, using its selected meaning. */
export const posOf = (word: WordEntry): SceneWordMeta['pos'] => {
  const selected = word.meaning_options?.find((m) => m.key === word.selected_meaning_key) || word.meaning_options?.[0];
  return categorizePos(selected?.partOfSpeech);
};

const definitionCnOf = (word: WordEntry): string => {
  const selected = word.meaning_options?.find((m) => m.key === word.selected_meaning_key) || word.meaning_options?.[0];
  const fromMeaning = selected?.meaningZh?.trim();
  if (fromMeaning) return fromMeaning;
  return (word.definition_cn || '').trim();
};

/** Build the per-word metadata sent to the scene-generate edge function. */
export const gatherWordMeta = (words: WordEntry[]): SceneWordMeta[] =>
  words.map((word) => ({
    text: word.text.trim(),
    pos: posOf(word),
    definitionCn: definitionCnOf(word),
  }));

// ----------------------------------------------------------------
// Daily-overlap history (mirrors puzzle, separate storage key)
// ----------------------------------------------------------------
const loadDailyHistory = (): SceneDailySelectionHistory => {
  if (typeof window === 'undefined') return { date: getShanghaiDateString(), rounds: [] };
  try {
    const raw = window.localStorage.getItem(SCENE_DAILY_SELECTION_HISTORY_KEY);
    if (!raw) return { date: getShanghaiDateString(), rounds: [] };
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

const saveDailyHistory = (words: WordEntry[]) => {
  if (typeof window === 'undefined') return;
  try {
    const today = getShanghaiDateString();
    const current = loadDailyHistory();
    const nextRound = words.map((word) => word.id);
    const rounds = current.date === today ? current.rounds : [];
    window.localStorage.setItem(
      SCENE_DAILY_SELECTION_HISTORY_KEY,
      JSON.stringify({ date: today, rounds: [...rounds, nextRound].slice(-SCENE_DAILY_HISTORY_LIMIT) }),
    );
  } catch {
    // ignore
  }
};

const enforceDailyOverlapCap = (prioritized: WordEntry[], previousRounds: string[][], count: number) => {
  if (previousRounds.length === 0) return prioritized.slice(0, count);

  const maxOverlap = Math.floor(count * MAX_DAILY_OVERLAP_RATE);
  const roundSets = previousRounds.map((round) => new Set(round));
  const overlapCounts = roundSets.map(() => 0);
  const selected: WordEntry[] = [];
  const selectedIds = new Set<string>();

  for (const word of prioritized) {
    if (selected.length >= count || selectedIds.has(word.id)) continue;
    const violatesCap = roundSets.some((set, i) => set.has(word.id) && overlapCounts[i] + 1 > maxOverlap);
    if (violatesCap) continue;
    selected.push(word);
    selectedIds.add(word.id);
    roundSets.forEach((set, i) => {
      if (set.has(word.id)) overlapCounts[i] += 1;
    });
  }

  if (selected.length >= count) return selected.slice(0, count);
  for (const word of prioritized) {
    if (selected.length >= count || selectedIds.has(word.id)) continue;
    selected.push(word);
    selectedIds.add(word.id);
  }
  return selected.slice(0, count);
};

const calculateMaxOverlapRate = (selectedWords: WordEntry[], previousRounds: string[][]) => {
  if (selectedWords.length === 0 || previousRounds.length === 0) return 0;
  const selectedIds = new Set(selectedWords.map((word) => word.id));
  const maxOverlapCount = previousRounds.reduce((maxCount, round) => {
    const overlapCount = round.reduce((count, wordId) => count + (selectedIds.has(wordId) ? 1 : 0), 0);
    return Math.max(maxCount, overlapCount);
  }, 0);
  return maxOverlapCount / selectedWords.length;
};

// ----------------------------------------------------------------
// Word selection
// ----------------------------------------------------------------
/** Candidate pool: non-deleted, deduped by normalized text. No image gate —
 *  the scene generates its own fused image. */
export const getSceneCandidateWords = (words: WordEntry[]): WordEntry[] => {
  const uniqueWords = new Map<string, WordEntry>();
  words
    .filter((word) => !word.deleted)
    .forEach((word) => {
      const key = normalizeText(word.text);
      if (!uniqueWords.has(key)) uniqueWords.set(key, word);
    });
  return Array.from(uniqueWords.values());
};

export const selectSceneWords = (
  allWords: WordEntry[],
  sessions: InputSession[],
  smartSelectionEnabled: boolean,
  targetCount: number,
): SceneSelectionResult => {
  const candidates = getSceneCandidateWords(allWords);
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
    const prioritized = adaptiveWordSelector.calculateQueue(allWords, candidates, candidates.length, sessions);
    const pool = prioritized.length >= candidates.length
      ? prioritized
      : [...prioritized, ...shuffleWords(candidates.filter((w) => !prioritized.includes(w)))];
    const dailyHistory = loadDailyHistory();
    const constrained = enforceDailyOverlapCap(pool, dailyHistory.rounds, count);
    const rotated = shuffleWords(constrained);
    const overlapRate = calculateMaxOverlapRate(rotated, dailyHistory.rounds);
    saveDailyHistory(rotated);
    return {
      words: rotated,
      selectionMode: 'smart',
      overlapRate,
      rankingEligible: overlapRate <= MAX_SCORING_OVERLAP_RATE,
      rankingIneligibleReason: overlapRate > MAX_SCORING_OVERLAP_RATE ? 'overlap_too_high' : null,
    };
  }

  const shuffled = shuffleWords(candidates);
  const dailyHistory = loadDailyHistory();
  const selection = shuffled.slice(0, count);
  const overlapRate = calculateMaxOverlapRate(selection, dailyHistory.rounds);
  saveDailyHistory(selection);
  return {
    words: selection,
    selectionMode: 'random',
    overlapRate,
    rankingEligible: overlapRate <= MAX_SCORING_OVERLAP_RATE,
    rankingIneligibleReason: overlapRate > MAX_SCORING_OVERLAP_RATE ? 'overlap_too_high' : null,
  };
};

// ----------------------------------------------------------------
// Scene generation request
// ----------------------------------------------------------------
const SCENE_GENERATION_TIMEOUT_MS = 150_000; // image gen (up to 90s) + vision (up to 60s)

export interface SceneGenerationResult {
  source: 'cache-hit' | 'generated';
  asset: SceneAsset;
  degraded: boolean;
}

/** Normalize a raw edge-function asset payload into a typed SceneAsset. */
const normalizeAsset = (raw: any): SceneAsset => ({
  id: String(raw?.id || ''),
  wordSetHash: String(raw?.word_set_hash || raw?.wordSetHash || ''),
  dayIndex: Number(raw?.day_index ?? raw?.dayIndex ?? 0),
  language: String(raw?.language || 'en'),
  imageUrl: String(raw?.public_url || raw?.imageUrl || raw?.publicUrl || ''),
  storagePath: String(raw?.storage_path || raw?.storagePath || ''),
  prompt: String(raw?.prompt || ''),
  regions: (Array.isArray(raw?.regions) ? raw.regions : []).map((r: any) => ({
    word: String(r?.word || ''),
    x: Number(r?.x) || 0,
    y: Number(r?.y) || 0,
    w: Number(r?.w) || 0,
    h: Number(r?.h) || 0,
    confidence: Number(r?.confidence) || 0,
    detectionFailed: Boolean(r?.detectionFailed),
  })) as WordRegion[],
  model: String(raw?.model || ''),
  visionModel: String(raw?.vision_model || raw?.visionModel || ''),
  status: raw?.status === 'failed' ? 'failed' : 'ready',
  createdAt: String(raw?.created_at || raw?.createdAt || ''),
});

export const requestSceneGeneration = async (
  words: SceneWordMeta[],
  dayIndex: number,
  language: string = 'en',
  signal?: AbortSignal,
): Promise<SceneGenerationResult> => {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured for scene generation');
  }

  const invokePromise = supabase.functions.invoke('scene-generate', {
    body: { words, dayIndex, language, force: false },
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error(`scene-generate invoke timeout after ${SCENE_GENERATION_TIMEOUT_MS}ms`)), SCENE_GENERATION_TIMEOUT_MS);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); });
  });

  const { data, error } = await Promise.race([invokePromise, timeoutPromise]);
  if (error) throw new Error(error.message || 'scene-generate invoke failed');
  if (!data || data.ok !== true || !data.asset) {
    throw new Error(data?.error || 'scene-generate returned no asset');
  }

  return {
    source: data.source === 'cache-hit' ? 'cache-hit' : 'generated',
    asset: normalizeAsset(data.asset),
    degraded: Boolean(data.degraded),
  };
};

/** Force-regenerate the scene for an already-selected word set (skips cache). */
export const requestSceneRegeneration = async (
  words: SceneWordMeta[],
  dayIndex: number,
  language: string = 'en',
): Promise<SceneGenerationResult> => {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured for scene generation');
  }
  const { data, error } = await Promise.race([
    supabase.functions.invoke('scene-generate', { body: { words, dayIndex, language, force: true } }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('scene-generate timeout')), 150000)),
  ]);
  if (error) throw new Error(error.message || 'scene-generate invoke failed');
  if (!data || data.ok !== true || !data.asset) {
    throw new Error(data?.error || 'scene-generate returned no asset');
  }
  return {
    source: 'generated',
    asset: normalizeAsset(data.asset),
    degraded: Boolean(data.degraded),
  };
};

// ----------------------------------------------------------------
// Haystack candidate selection (pure client, no LLM)
// ----------------------------------------------------------------
const normalizeDefinition = (value: string): string =>
  value.trim().toLowerCase().replace(/[\s,，。.;；:：、()（）"''`']/g, '');

const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
};

/** Build 5 candidates (1 correct + 4 distractors). POS-matched + Chinese-
 *  definition dedup to avoid near-synonyms. Falls back to any-POS if needed. */
export const buildHaystackCandidates = (
  target: WordEntry,
  library: WordEntry[],
): { candidates: WordEntry[]; fallbackReason: string | null } => {
  const targetPos = posOf(target);
  const targetDef = normalizeDefinition(definitionCnOf(target));

  const isUsable = (w: WordEntry) => !w.deleted && w.id !== target.id && w.text.trim().length > 0;

  const dedupe = (pool: WordEntry[]): WordEntry[] => {
    const seen = new Set<string>();
    return pool.filter((w) => {
      const def = normalizeDefinition(definitionCnOf(w));
      // Exact same meaning as target -> drop (near-synonym).
      if (targetDef && targetDef.length >= 2 && def === targetDef) return false;
      // Very similar meaning (Levenshtein <= 2, len >= 3) -> drop.
      if (targetDef.length >= 3 && def.length >= 3 && levenshtein(def, targetDef) <= 2) return false;
      // Dedupe within the candidate set by definition too.
      const dedKey = def || normalizeText(w.text);
      if (seen.has(dedKey)) return false;
      seen.add(dedKey);
      return true;
    });
  };

  const samePos = dedupe(library.filter((w) => isUsable(w) && posOf(w) === targetPos));
  let pool = samePos;
  let fallbackReason: string | null = null;

  if (pool.length < 4) {
    // Relax: keep only exact-match dedupe (drop Levenshtein).
    const relaxed = library.filter((w) => isUsable(w) && posOf(w) === targetPos).filter((w) => {
      const def = normalizeDefinition(definitionCnOf(w));
      return !(targetDef && def === targetDef);
    });
    pool = relaxed;
    fallbackReason = 'pos-dedup-relaxed';
  }

  if (pool.length < 4) {
    // Fall back to any POS.
    pool = dedupe(library.filter(isUsable));
    fallbackReason = 'any-pos';
  }

  const distractors = shuffleWords(pool).slice(0, 4);
  return { candidates: shuffleWords([target, ...distractors]).slice(0, 5), fallbackReason };
};

// ----------------------------------------------------------------
// Scoring (mirrors puzzleGame factors, mode-aware totals)
// ----------------------------------------------------------------
const getAttemptFactor = (attemptsUsed: number) => {
  if (attemptsUsed <= 1) return 1;
  if (attemptsUsed === 2) return 0.85;
  return 0.7;
};

const getSpeedFactor = (activatedAtMs: number | null, solvedAtMs: number | null) => {
  if (activatedAtMs == null || solvedAtMs == null || solvedAtMs <= activatedAtMs) return 0.75;
  const seconds = (solvedAtMs - activatedAtMs) / 1000;
  if (seconds <= 4) return 1.1;
  if (seconds <= 8) return 1.0;
  if (seconds <= 15) return 0.9;
  if (seconds <= 25) return 0.8;
  return 0.7;
};

export const sceneDurationSeconds = (playMode: ScenePlayMode, wordCount: number) =>
  wordCount * (playMode === 'spell' ? 30 : 15);

export const calculateSceneGameSummary = (params: {
  results: SceneCardResult[];
  elapsedMs: number;
  selectionMode: PuzzleGameSelectionMode;
  playMode: ScenePlayMode;
  dayIndex: number;
  wordCount: number;
  overlapRate: number;
  rankingEligible: boolean;
  rankingIneligibleReason?: string | null;
  sceneAssetId?: string | null;
}): SceneGameSummary => {
  const { results, elapsedMs, selectionMode, playMode, dayIndex, wordCount, overlapRate, rankingEligible, rankingIneligibleReason, sceneAssetId } = params;
  const totalDurationSeconds = sceneDurationSeconds(playMode, wordCount);
  const wordsTotal = results.length || wordCount;
  const wordsCorrect = results.filter((r) => r.correct).length;
  const hintsUsed = results.filter((r) => r.hintUsed).length;
  const solvedWithoutHint = results.filter((r) => r.correct && !r.hintUsed).length;
  const accuracyRate = wordsTotal > 0 ? wordsCorrect / wordsTotal : 0;
  const timeUsedSeconds = clamp(Math.ceil(elapsedMs / 1000), 0, totalDurationSeconds);
  const secondsRemaining = clamp(totalDurationSeconds - timeUsedSeconds, 0, totalDurationSeconds);

  const rawQualityTotal = results.reduce((sum, r) => {
    if (!r.correct) return sum;
    // Haystack: attempt factor is binary (1 if first-pick, else 0.85).
    const attemptFactor = playMode === 'haystack' ? (r.attemptsUsed <= 1 ? 1 : 0.85) : getAttemptFactor(r.attemptsUsed);
    const hintFactor = r.hintUsed ? 0.8 : 1;
    const speedFactor = getSpeedFactor(r.activatedAtMs, r.solvedAtMs);
    return sum + 100 * attemptFactor * hintFactor * speedFactor;
  }, 0);

  const accuracyScore = accuracyRate * 700;
  const speedScore = (secondsRemaining / totalDurationSeconds) * 200;
  const efficiencyBonus = (rawQualityTotal / (wordsTotal * 110)) * 100;
  const totalScore = Math.round(clamp(accuracyScore + speedScore + efficiencyBonus, 0, 1000));

  return {
    totalScore,
    accuracyRate: Number(accuracyRate.toFixed(4)),
    speedScore: accuracyRate >= 0.85 ? Math.round((secondsRemaining / totalDurationSeconds) * 1000) : 0,
    noHintScore: accuracyRate >= 0.85 ? Math.round((solvedWithoutHint / wordsTotal) * 1000) : 0,
    wordsCorrect,
    wordsTotal,
    hintsUsed,
    solvedWithoutHint,
    timeUsedSeconds,
    secondsRemaining,
    totalDurationSeconds,
    selectionMode,
    playMode,
    dayIndex,
    wordCount,
    overlapRate: Number(overlapRate.toFixed(4)),
    rankingEligible,
    rankingIneligibleReason: rankingIneligibleReason || null,
    sceneAssetId: sceneAssetId || null,
    results,
  };
};

// ----------------------------------------------------------------
// DB sync wrappers
// ----------------------------------------------------------------
export const recordSceneGameRound = async (summary: SceneGameSummary) => {
  const clientDate = getShanghaiDateString();
  const { data, error } = await supabase.rpc('record_scene_game_round', {
    p_play_mode: summary.playMode,
    p_selection_mode: summary.selectionMode,
    p_day_index: summary.dayIndex,
    p_word_count: summary.wordCount,
    p_total_duration_seconds: summary.totalDurationSeconds,
    p_total_score: summary.totalScore,
    p_accuracy_rate: summary.accuracyRate,
    p_speed_score: summary.speedScore,
    p_no_hint_score: summary.noHintScore,
    p_time_used_seconds: summary.timeUsedSeconds,
    p_seconds_remaining: summary.secondsRemaining,
    p_hints_used: summary.hintsUsed,
    p_words_total: summary.wordsTotal,
    p_words_correct: summary.wordsCorrect,
    p_solved_without_hint: summary.solvedWithoutHint,
    p_scene_asset_id: summary.sceneAssetId || null,
    p_client_date: clientDate,
  });
  if (error) {
    console.error('[recordSceneGameRound] failed:', error.message);
    throw error;
  }
  return Array.isArray(data) && data.length > 0 ? data[0] : data;
};

export const fetchSceneGameLeaderboard = async (
  scope: SceneLeaderboardScope,
  metric: SceneLeaderboardMetric,
  playMode?: ScenePlayMode,
  date?: Date,
  limit: number = 8,
): Promise<SceneLeaderboardEntry[]> => {
  const targetDate = date || new Date();
  const year = targetDate.getFullYear();
  const month = String(targetDate.getMonth() + 1).padStart(2, '0');
  const day = String(targetDate.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;

  const { data, error } = await supabase.rpc('get_scene_game_leaderboard', {
    p_scope: scope,
    p_metric: metric,
    p_play_mode: playMode || null,
    p_date: dateStr,
    p_limit: limit,
  });
  if (error) {
    console.error('[fetchSceneGameLeaderboard] failed:', error.message);
    throw error;
  }
  return (data || []) as SceneLeaderboardEntry[];
};
