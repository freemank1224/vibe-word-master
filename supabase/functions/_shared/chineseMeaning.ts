const placeholders = new Set(['暂无中文释义', '无中文释义', '暂无释义', 'n/a', 'na', '-']);

/** Only admit an actual Chinese meaning, never a provider's echoed input. */
export const normalizeChineseMeaning = (value?: string | null): string | undefined => {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized || placeholders.has(normalized.toLowerCase()) || !/\p{Script=Han}/u.test(normalized)) return undefined;
  return normalized;
};

export const firstChineseMeaning = (values: readonly (string | null | undefined)[]): string | undefined => {
  for (const value of values) {
    const meaning = normalizeChineseMeaning(value);
    if (meaning) return meaning;
  }
  return undefined;
};

export const splitChineseMeanings = (value?: string | null): string[] => {
  if (!value?.trim()) return [];
  const unique = new Set<string>();
  for (const candidate of value.split(/[;/；、，]/g)) {
    const meaning = normalizeChineseMeaning(candidate);
    if (meaning) unique.add(meaning);
    if (unique.size >= 5) break;
  }
  return [...unique];
};
