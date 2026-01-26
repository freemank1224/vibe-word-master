
export interface WordEntry {
  id: string;
  text: string;
  timestamp: number; // Date.now() when added
  sessionId: string;
  correct: boolean;
  tested: boolean;
  image_path?: string | null; // Path in Supabase Storage
  image_url?: string | null; // Public URL
  // V2 Fields
  error_count: number;
  best_time_ms: number | null;
  last_tested: number | null;
  phonetic: string | null;
  audio_url: string | null;
  language?: string | null; // e.g. 'en', 'ja', 'ko'
  definition_cn: string | null;
  definition_en: string | null;
  deleted?: boolean;
  tags?: string[];
  score?: number; // Added for point system (3 for direct, 2.4 for hint)
}

export interface InputSession {
  id: string;
  timestamp: number;
  wordCount: number;
  targetCount: number;
  deleted?: boolean;
  libraryTag?: string; // Which library this session belongs to (Custom, CET-4, etc.)
}

export type AppMode = 'DASHBOARD' | 'INPUT' | 'TEST' | 'LIBRARY';

export interface DayStats {
  date: string; // YYYY-MM-DD
  total: number;
  correct: number;
  points?: number; // Added aggregate points
}
