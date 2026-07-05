
export interface WordMeaningOption {
  key: string;
  meaningZh: string;
  partOfSpeech?: string | null;
  definitionEn?: string | null;
  sourceProvider?: string | null;
}

export interface WordEntry {
  id: string;
  text: string;
  timestamp: number; // Date.now() when added
  sessionId: string;
  correct: boolean;
  tested: boolean;
  image_path?: string | null; // Path in Supabase Storage (legacy, being phased out)
  image_url?: string | null; // Public URL (computed from image_asset or legacy image_path)
  image_asset_id?: string | null; // FK to shared image_assets table
  // V2 Fields
  error_count: number;
  best_time_ms: number | null;
  last_tested: number | null;
  phonetic: string | null;
  audio_url: string | null;
  language?: string | null; // e.g. 'en', 'ja', 'ko'
  lexeme_id?: string | null;
  definition_cn: string | null;
  definition_en: string | null;
  meaning_options?: WordMeaningOption[] | null;
  selected_meaning_key?: string | null;
  deleted?: boolean;
  tags?: string[];
  score?: number; // Added for point system (3 for direct, 2.4 for hint)
  consecutive_correct?: number; // Error decay mechanism: consecutive correct answers without hints
}

export interface InputSession {
  id: string;
  timestamp: number;
  wordCount: number;
  targetCount: number;
  deleted?: boolean;
  libraryTag?: string; // Which library this session belongs to (Custom, CET-4, etc.)
  syncStatus?: 'synced' | 'syncing' | 'pending' | 'failed' | 'conflict'; // ☁️ Cloud sync status for UI
}

export interface CompletedTestWordResult {
  id: string;
  correct: boolean;
  score: number;
  timeSpentMs: number;
  averageCharsPerMinute: number;
}

export interface CompletedTestSummary {
  results: CompletedTestWordResult[];
  totalTimeMs: number;
  rawPoints: number;
  timeBonusPoints: number;
  totalScore: number;
  timeEfficiencyRatio: number;
  averageWordTimeMs: number;
  fastestWordTimeMs: number | null;
  slowestWordTimeMs: number | null;
}

export type TestModeKind = 'CLASSIC' | 'PUZZLE' | 'SCENE';

export type PuzzleGamePhase = 'INTRO' | 'PREPARING' | 'READY' | 'COUNTDOWN' | 'PLAYING' | 'RESULT';

export type PuzzleGameSelectionMode = 'smart' | 'random';

export type PuzzleLeaderboardScope = 'daily' | 'all_time';

export type PuzzleLeaderboardMetric = 'total_score' | 'accuracy_rate' | 'speed_score' | 'no_hint_score';

export interface PuzzleGameConfig {
  kind: 'PUZZLE';
}

export interface ClassicTestConfig {
  kind?: 'CLASSIC';
  sessionIds?: string[];
  wordIds?: string[];
}

export interface PuzzleCardResult {
  wordId: string;
  wordText: string;
  correct: boolean;
  attemptsUsed: number;
  hintUsed: boolean;
  solvedAtMs: number | null;
  activatedAtMs: number | null;
}

export interface PuzzleGameSummary {
  totalScore: number;
  accuracyRate: number;
  speedScore: number;
  noHintScore: number;
  wordsCorrect: number;
  wordsTotal: number;
  hintsUsed: number;
  solvedWithoutHint: number;
  timeUsedSeconds: number;
  secondsRemaining: number;
  selectionMode: PuzzleGameSelectionMode;
  overlapRate: number;
  rankingEligible: boolean;
  rankingIneligibleReason?: string | null;
  results: PuzzleCardResult[];
}

export interface PuzzleGameCardState {
  word: WordEntry;
  imageUrl: string | null;
  attemptsUsed: number;
  hintUsed: boolean;
  inputValue: string;
  isInputOpen: boolean;
  isSolved: boolean;
  isLocked: boolean;
  activatedAtMs: number | null;
  solvedAtMs: number | null;
}

// ================================================================
// Scene Fusion Game Mode (完形填空 cloze)
// ================================================================

export type SceneGamePhase =
  | 'INTRO'
  | 'PREPARING'
  | 'COUNTDOWN'
  | 'PLAYING'
  | 'RESULT';

/**
 * As of the cloze-sentence refactor, only one gameplay style remains: a single
 * picture + multiple cloze sentences shown side-by-side. The player navigates
 * sentences with arrow keys / mouse and fills in the blank for each.
 *
 * The type is kept as a single-literal union (and stays a string) for DB
 * backward-compat with the `scene_game_rounds.play_mode` column.
 */
export type ScenePlayMode = 'cloze';

export interface SceneGameConfig {
  kind: 'SCENE';
}

/** Metadata for one selected word, sent to the scene-generate edge function. */
export interface SceneWordMeta {
  text: string;
  pos: string; // 'noun' | 'adjective' | 'verb' | 'adverb' | 'other'
  definitionCn: string;
}

/** A per-word region of a fused scene image. Coordinates are normalized 0..1. */
export interface WordRegion {
  word: string;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
  detectionFailed?: boolean;
  /** Optional cloze-style description sentence containing `word` verbatim. */
  sentence?: string;
}

/** A generated + cached fused scene image with per-word regions. */
export interface SceneAsset {
  id: string;
  wordSetHash: string;
  dayIndex: number; // 0..6 (Sun..Sat)
  language: string;
  imageUrl: string;
  storagePath: string;
  prompt: string;
  regions: WordRegion[];
  model: string;
  visionModel: string;
  status: 'ready' | 'failed';
  createdAt: string;
  /** Index of word (lowercase) → cloze sentence. Missing/empty = degraded UI mode. */
  sentences?: Record<string, string>;
  /** Optional AI-generated storyboard (the natural-language scene skeleton the
   *  cloze sentences are derived from). Surfaced in the PREPARING stage so the
   *  player can preview the scene idea before play. */
  storyboard?: string;
}

export interface SceneCardResult {
  wordId: string;
  wordText: string;
  correct: boolean;
  attemptsUsed: number;
  hintUsed: boolean;
  solvedAtMs: number | null;
  activatedAtMs: number | null;
}

export interface SceneGameSummary {
  totalScore: number;
  accuracyRate: number;
  speedScore: number;
  noHintScore: number;
  wordsCorrect: number;
  wordsTotal: number;
  hintsUsed: number;
  solvedWithoutHint: number;
  timeUsedSeconds: number;
  secondsRemaining: number;
  totalDurationSeconds: number;
  selectionMode: PuzzleGameSelectionMode;
  playMode: ScenePlayMode;
  dayIndex: number;
  wordCount: number;
  overlapRate: number;
  rankingEligible: boolean;
  rankingIneligibleReason?: string | null;
  sceneAssetId?: string | null;
  results: SceneCardResult[];
}

export type SceneLeaderboardScope = 'daily' | 'all_time';
export type SceneLeaderboardMetric = 'total_score' | 'accuracy_rate' | 'speed_score';

export interface SceneLeaderboardEntry {
  user_id: string;
  rank_position: number;
  metric_value: number;
  total_score: number;
  accuracy_rate: number;
  speed_score: number;
  play_mode: ScenePlayMode;
  words_total: number;
  words_correct: number;
  time_used_seconds: number;
  played_date: string;
  display_name?: string;
  email_masked?: string;
  is_current_user?: boolean;
}

export type AppMode = 'DASHBOARD' | 'INPUT' | 'TEST' | 'LIBRARY';

export interface DayStats {
  date: string; // YYYY-MM-DD
  total: number;
  correct: number;
  /** @deprecated points field is deprecated for UI display (kept for backward compatibility). Accuracy now uses correct/total calculation only. */
  points?: number;
  is_frozen?: boolean; // Whether this day's stats are frozen (immutable)
  version?: number; // Version number for optimistic locking (Phase B)
  updated_at?: string; // Last update timestamp (ISO 8601) for conflict detection
}

/**
 * Extended DayStats with version control metadata
 * Used for handling version conflicts
 */
export interface DayStatsWithVersion extends DayStats {
  _conflict?: boolean;  // Whether this record resulted from a conflict merge
  _resolved?: 'local' | 'server' | 'merged';  // How the conflict was resolved
}

/**
 * Pending sync item for offline queue (Phase C)
 * Stores test data locally when sync fails, for retry when connection is restored
 */
export interface PendingSyncItem {
  id: string;  // UUID for tracking
  date: string;  // Test date (YYYY-MM-DD)
  testCount: number;  // Total words tested
  correctCount: number;  // Correct answers
  points: number;  // Points earned
  expectedVersion: number;  // Version for conflict detection
  timestamp: number;  // When created (ms)
  retryCount?: number;  // Current retry attempt
  lastError?: string;  // Last error message
}

// ================================================================
// Leaderboard Types
// ================================================================

/**
 * Leaderboard entry returned from database
 * Represents a single user's ranking for a specific date
 */
export interface LeaderboardEntry {
  user_id: string;
  rank_position: number;
  total_score: number;
  test_count_score: number;
  new_words_score: number;
  accuracy_score: number;
  difficulty_score: number;
  tests_completed: number;
  new_words_added: number;
  accuracy_rate: number;
  avg_difficulty: number;
  display_name?: string;  // Custom username if set, otherwise masked email
  email_masked?: string;  // Always the masked email (for hover tooltip)
  is_current_user?: boolean;
}

export interface PuzzleLeaderboardEntry {
  user_id: string;
  rank_position: number;
  metric_value: number;
  total_score: number;
  accuracy_rate: number;
  speed_score: number;
  no_hint_score: number;
  hints_used: number;
  words_total: number;
  words_correct: number;
  time_used_seconds: number;
  played_date: string;
  display_name?: string;
  email_masked?: string;
  is_current_user?: boolean;
}

/**
 * User's rank history for trend visualization
 */
export interface RankHistoryEntry {
  rank_date: string;
  rank_position: number;
  total_score: number;
  percentile: number;
}

/**
 * Current user's ranking summary
 */
export interface CurrentUserRanking {
  rank_date: string;
  rank_position: number;
  total_score: number;
  percentile: number;
  tests_completed: number;
  new_words_added: number;
  accuracy_rate: number;
  avg_difficulty: number;
}

/**
 * Leaderboard configuration type
 * Derived from wordLearningConfig.ts
 */
export interface LeaderboardConfig {
  weights: {
    testCount: number;
    newWords: number;
    accuracy: number;
    difficulty: number;
  };
  normalization: {
    testCountCap: number;
    newWordsCap: number;
    difficultyCap: number;
  };
  qualification: {
    minTestsPerDay: number;
    minAccuracy: number;
  };
  display: {
    topRankCount: number;
    includeSelf: boolean;
    showPercentile: boolean;
  };
  cache: {
    ttlSeconds: number;
    staleWhileRevalidate: boolean;
  };
  privacy: {
    maskEmail: boolean;
    showRankPosition: boolean;
    showPercentile: boolean;
  };
}
