import type { WordEntry } from '../types';
import { normalizeChineseMeaning } from './chineseMeaning.ts';

/** Chinese meanings are learning content and do not follow the UI language. */
export const chineseWordMeaning = (word: Pick<WordEntry, 'definition_cn' | 'meaning_options' | 'selected_meaning_key'>): string => {
  const selected = word.meaning_options?.find(option => option.key === word.selected_meaning_key);
  return normalizeChineseMeaning(selected?.meaningZh) || normalizeChineseMeaning(word.definition_cn) || '';
};

/** Only the fallback instruction follows the UI language. */
export const wordMeaningForLanguage = (word: WordEntry, isZh: boolean): string => {
  return chineseWordMeaning(word) || (isZh ? '请听发音回忆单词' : 'Listen to the pronunciation to recall the word');
};
