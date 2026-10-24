import type { WordEntry } from '../types.ts';

export type PuzzleText = Readonly<{ en: string; zh: string }>;

// Store both versions so asynchronous feedback changes language with the UI.
export const puzzleText = (en: string, zh: string): PuzzleText => ({ en, zh });

export function getPuzzleDefinition(word: WordEntry, language: 'en' | 'zh'): string {
  if (language === 'zh') return word.definition_cn?.trim() || '';
  const selectedMeaning = word.meaning_options?.find((meaning) => meaning.key === word.selected_meaning_key);
  // Older imported words may contain Chinese in the English field. The image
  // and pronunciation remain usable clues when an English definition is absent.
  // A word-level definition can describe a different sense. Keep the chosen
  // sense even when its English translation is unavailable.
  return (selectedMeaning ? [selectedMeaning.definitionEn] : [word.definition_en])
    .map((value) => value?.trim() || '')
    .find((value) => value && !/\p{Script=Han}/u.test(value)) || '';
}
