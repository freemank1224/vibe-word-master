import type { WordEntry } from '../types';

const placeholders = new Set(['暂无中文释义', '无中文释义', '暂无释义', 'n/a', 'na', '-']);
const usable = (value?: string | null): string => {
  const trimmed = value?.trim() || '';
  return placeholders.has(trimmed.toLowerCase()) ? '' : trimmed;
};

/** Chinese meanings are learning content and do not follow the UI language. */
export const chineseWordMeaning = (word: WordEntry): string => {
  const selected = word.meaning_options?.find(option => option.key === word.selected_meaning_key);
  return usable(selected?.meaningZh) || usable(word.definition_cn);
};

/** Only the fallback instruction follows the UI language. */
export const wordMeaningForLanguage = (word: WordEntry, isZh: boolean): string => {
  return chineseWordMeaning(word) || (isZh ? '请听发音回忆单词' : 'Listen to the pronunciation to recall the word');
};
