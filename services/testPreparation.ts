import type { WordEntry } from '../types.ts';
import { normalizeChineseMeaning } from '../utils/chineseMeaning.ts';

const placeholderDefinitions = new Set(['暂无中文释义', '无中文释义', '暂无释义', 'n/a', 'na', '-']);
const hasDefinition = (value?: string | null) => !!normalizeChineseMeaning(value);

type MeaningSelection = Pick<WordEntry, 'definition_cn' | 'selected_meaning_key' | 'meaning_options'>;

/** Use the parent's newest saved meaning while keeping the active test queue stable. */
export function latestTestWordMeaning(word: WordEntry, latestWords: readonly WordEntry[]): WordEntry {
  return latestWords.find(candidate => candidate.id === word.id) || word;
}

// Older versions saved a failed lookup as a selected placeholder. Preserve unknown
// selections (for example when legacy rows do not have meaning_options), and only
// replace a selection when its stored option proves it is a placeholder.
const hasChosenMeaning = (word: MeaningSelection): boolean => {
  if (!word.selected_meaning_key) return false;
  const selected = word.meaning_options?.find(option => option.key === word.selected_meaning_key);
  if (!selected || hasDefinition(selected.meaningZh) || selected.sourceProvider === 'user') return true;
  // Only replace an identifiable failed automated fallback; other selections
  // may reflect an intentional sense and must remain untouched.
  const text = selected.meaningZh?.trim().toLowerCase() || '';
  return !placeholderDefinitions.has(text) && !['input-fallback', 'translation-fallback'].includes(selected.sourceProvider || '');
};

export function needsDictionaryEnrichment(word: MeaningSelection): boolean {
  // Optional phonetics/English explanations never delay a word whose chosen meaning is already usable.
  return !hasChosenMeaning(word) && !hasDefinition(word.definition_cn);
}

export function missingDictionaryFields(
  word: Pick<WordEntry, 'definition_cn' | 'definition_en' | 'phonetic' | 'selected_meaning_key' | 'meaning_options'>,
  data: { definition_cn?: string; definition_en?: string; phonetic?: string } | null,
): Partial<Pick<WordEntry, 'definition_cn' | 'definition_en' | 'phonetic' | 'selected_meaning_key'>> {
  if (!data || hasChosenMeaning(word)) return {};
  const patch: Partial<Pick<WordEntry, 'definition_cn' | 'definition_en' | 'phonetic' | 'selected_meaning_key'>> = {};
  if (!hasDefinition(word.definition_cn) && hasDefinition(data.definition_cn)) {
    patch.definition_cn = data.definition_cn;
    // Stop the old placeholder option from shadowing the recovered definition.
    if (word.selected_meaning_key) patch.selected_meaning_key = null;
  }
  if (!word.definition_en?.trim() && data.definition_en?.trim()) patch.definition_en = data.definition_en;
  if (!word.phonetic?.trim() && data.phonetic?.trim()) patch.phonetic = data.phonetic;
  return patch;
}

/** Audio and images use separate worker queues, so slow images cannot hold the next pronunciation. */
export async function forEachWithConcurrency<T>(
  values: readonly T[], concurrency: number, signal: AbortSignal,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (!signal.aborted && next < values.length) {
      const value = values[next++];
      await visit(value);
    }
  }));
}

export function preloadHintImage(url: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const image = new Image();
    let settled = false;
    const finish = (loaded: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      image.onload = null;
      image.onerror = null;
      if (!loaded) image.src = '';
      resolve(loaded);
    };
    const cancel = () => finish(false);
    const timer = setTimeout(cancel, 5000);
    signal.addEventListener('abort', cancel, { once: true });
    image.onload = () => finish(true);
    image.onerror = cancel;
    image.src = url;
  });
}

/** Fixed-column conditions for a metadata-only compare-and-set; user values use .eq(), never raw filters. */
export function dictionaryBackfillFilters(
  word: Pick<WordEntry, 'definition_cn' | 'definition_en' | 'phonetic' | 'selected_meaning_key' | 'meaning_options'>,
  patch: Partial<Pick<WordEntry, 'definition_cn' | 'definition_en' | 'phonetic' | 'selected_meaning_key'>>,
  language: string = 'en',
): { or: string[]; equals: Array<[string, string]> } {
  const or = ['deleted.eq.false,deleted.is.null'];
  const equals: Array<[string, string]> = [];
  if (!language || language === 'en') or.push('language.eq.en,language.is.null,language.eq.""');
  else equals.push(['language', language]);
  // A concurrent edit can preserve the same key while changing its option.
  // Guard the exact JSON whenever the patch clears a failed selection.
  if (Object.hasOwn(patch, 'selected_meaning_key') && Array.isArray(word.meaning_options)) {
    equals.push(['meaning_options', JSON.stringify(word.meaning_options)]);
  }
  const columns: Array<'selected_meaning_key' | 'definition_cn' | 'definition_en' | 'phonetic'> = ['selected_meaning_key'];
  for (const field of ['definition_cn', 'definition_en', 'phonetic'] as const) {
    if (Object.hasOwn(patch, field)) columns.push(field);
  }
  for (const field of columns) {
    const oldValue = word[field];
    if (oldValue == null || oldValue === '') or.push(`${field}.is.null,${field}.eq.""`);
    else equals.push([field, oldValue]);
  }
  return { or, equals };
}
