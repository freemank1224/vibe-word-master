import { normalizeChineseMeaning } from './chineseMeaning.ts';

/** Never update an existing meaning: it may have been entered by a learner
 * while the provider request was in flight. Personal word rows are untouched. */
export async function addMachineMeanings(
  client: { from: (table: string) => any }, lexemeId: string, meanings: string[], provider: string,
): Promise<{ error: { message?: string } | null; status: number }> {
  const valid = meanings.map(normalizeChineseMeaning).filter((value): value is string => !!value);
  if (!valid.length) return { error: null, status: 200 };
  const payload = valid.map((meaning, index) => ({
    lexeme_id: lexemeId, meaning_zh: meaning, source_type: 'machine',
    source_provider: provider, confidence: index === 0 ? 0.78 : 0.68, is_verified: false,
  }));
  return await client.from('lexeme_meanings').upsert(payload, {
    onConflict: 'lexeme_id,meaning_zh', ignoreDuplicates: true,
  });
}
