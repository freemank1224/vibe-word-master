import type { WordEntry } from '../types';

/** Preserve the chosen sense; never substitute another sense to obtain a translation. */
export const wordMeaningForLanguage = (word: WordEntry, isZh: boolean): string => {
  const selected = word.meaning_options?.find(option => option.key === word.selected_meaning_key);
  if (isZh) return selected?.meaningZh?.trim() || word.definition_cn?.trim() || '请听发音回忆单词';
  const definition = word.selected_meaning_key ? selected?.definitionEn?.trim() : word.definition_en?.trim();
  return definition && !/\p{Script=Han}/u.test(definition) ? definition : 'Listen to the pronunciation to recall the word';
};
