const PLACEHOLDERS = new Set(['暂无中文释义', '无中文释义', '暂无释义', 'n/a', 'na', '-']);

/** Only accept actual Chinese content as a Chinese meaning. */
export function normalizeChineseMeaning(value?: string | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || PLACEHOLDERS.has(normalized.toLowerCase()) || !/\p{Script=Han}/u.test(normalized)) return undefined;
  return normalized;
}
