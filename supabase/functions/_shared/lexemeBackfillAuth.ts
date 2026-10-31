import { timingSafeEqual } from 'node:crypto';

/** Fail closed for missing or weak configuration; do not disclose the secret. */
export function isLexemeBackfillAuthorized(secret: string, supplied: string): boolean {
  if (secret.length < 32 || !supplied) return false;
  const encoder = new TextEncoder();
  const expected = encoder.encode(secret);
  const actual = encoder.encode(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
