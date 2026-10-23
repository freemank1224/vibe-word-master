import type { WordEntry } from '../types';

export type WordPartOfSpeech = 'noun' | 'adjective' | 'verb' | 'adverb' | 'other';

/** Map a dictionary part-of-speech token to an image-prompt category. */
export const categorizePos = (raw: string | null | undefined): WordPartOfSpeech => {
  if (!raw) return 'noun';
  const p = raw.trim().toLowerCase().replace(/\./g, '');
  if (p === 'noun' || p === 'n') return 'noun';
  if (p === 'adjective' || p === 'adj') return 'adjective';
  if (p === 'verb' || p === 'v') return 'verb';
  if (p === 'adverb' || p === 'adv') return 'adverb';
  return 'other';
};

/** Use the selected meaning, falling back to the first available meaning. */
export const posOf = (word: WordEntry): WordPartOfSpeech => {
  const selected = word.meaning_options?.find((m) => m.key === word.selected_meaning_key) || word.meaning_options?.[0];
  return categorizePos(selected?.partOfSpeech);
};
