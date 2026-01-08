
export interface WordEntry {
  id: string;
  text: string;
  timestamp: number; // Date.now() when added
  sessionId: string;
  correct: boolean;
  tested: boolean;
  image_path?: string | null; // Path in Supabase Storage
  image_url?: string | null; // Public URL
}

export interface InputSession {
  id: string;
  timestamp: number;
  wordCount: number;
  targetCount: number;
}

export type AppMode = 'DASHBOARD' | 'INPUT' | 'TEST';

export interface DayStats {
  date: string; // YYYY-MM-DD
  total: number;
  correct: number;
}
