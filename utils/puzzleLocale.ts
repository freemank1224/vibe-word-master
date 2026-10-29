import type { WordEntry } from '../types.ts';
import { chineseWordMeaning } from './wordMeaningLocale.ts';

export type PuzzleText = Readonly<{ en: string; zh: string }>;

// Store both versions so asynchronous feedback changes language with the UI.
export const puzzleText = (en: string, zh: string): PuzzleText => ({ en, zh });

export function getPuzzleDefinition(word: WordEntry, _language: 'en' | 'zh'): string {
  return chineseWordMeaning(word);
}
