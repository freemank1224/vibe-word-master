/**
 * Local word-family detection — no LLM, no network.
 *
 * When a user types an inflected form (e.g. "went", "shoes", "takes", "walked"),
 * we want to surface the rest of the family ("go / went / gone") so they can
 * practise and store all the principal forms together.
 *
 * Strategy (priority order matters — see {@link detectWordFamily}):
 *   1. Irregular verb   — looked up in a vendored table of ~360 irregular verbs
 *                         (base / past / past-participle). Hit directly, or via
 *                         singularizing a 3rd-person "-s" form ("goes" → "go").
 *   2. Regular verb     — only for "-ed" forms ("walked" → "walk" / "walked").
 *   3. Plural noun      — "shoes" → "shoe" / "shoes".
 *
 * We deliberately do NOT fire on base/lemma inputs of *regular* words
 * ("walk", "cat") — that would prompt on nearly every entry and reads as noise.
 * Irregular-verb bases ARE surfaced, because their family can't be derived.
 */

import wl from 'wink-lemmatizer';
import pluralize from 'pluralize';
// Vendored irregular-verb table (Apache-2.0, Ludan Stoecklé — see the data file).
// Shape: { [baseForm: string]: Array<[past, pastParticiple]> }. Some verbs list
// multiple valid pairs; we take the first (most common) one.
import irregularRaw from './data/irregularVerbs.ts';

export type FamilyReason = 'irregular-verb' | 'regular-verb' | 'plural-noun';

export interface FamilyResult {
  isFamilyMember: boolean;
  /** The family headword (usually the lemma / base form). */
  headword?: string;
  /** Ordered, de-duplicated principal forms to practise (e.g. ["go","went","gone"]). */
  forms?: string[];
  reason?: FamilyReason;
}

interface IrregularEntry {
  base: string;
  past: string;
  part: string;
}

/**
 * Reverse index: any form (base / past / past-participle, lowercased) → the
 * verb's principal parts. Built once at module load. First write wins, so the
 * base form is preferred as the headword when forms collide across verbs.
 */
const REVERSE_VERB: Record<string, IrregularEntry> = (() => {
  const index: Record<string, IrregularEntry> = {};
  const table = irregularRaw as Record<string, Array<[string, string]>>;
  for (const base of Object.keys(table)) {
    const pairs = table[base];
    if (!pairs || pairs.length === 0) continue;
    const [past, part] = pairs[0];
    const entry: IrregularEntry = { base, past: past || base, part: part || base };
    for (const form of [base, past, part]) {
      if (!form) continue;
      const key = String(form).toLowerCase();
      if (!index[key]) index[key] = entry;
    }
  }
  return index;
})();

/** De-duplicate by case-insensitive identity, preserving first-seen order + casing. */
function uniqueForms(forms: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of forms) {
    if (!f) continue;
    const key = f.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

/**
 * Detect the word family for a single input token.
 *
 * @returns `null` only when the detector itself is unavailable (libs threw);
 *          `{ isFamilyMember: false }` when the word has no useful family.
 *          Callers treat both the same (skip the prompt, fall back to the
 *          normal single-word flow).
 */
export function detectWordFamily(input: string): FamilyResult | null {
  const word = (input || '').trim().toLowerCase();
  // Empty, multi-word, or whitespace-containing inputs are not single tokens.
  if (!word || /\s/.test(word)) return null;

  try {
    // 1. Irregular verb — direct hit on any principal form, or via singularizing
    //    a 3rd-person "-s" form (pluralize turns "goes"/"takes" → "go"/"take").
    let verb = REVERSE_VERB[word];
    if (!verb) {
      const singularized = pluralize.singular(word);
      if (singularized && singularized.toLowerCase() !== word) {
        verb = REVERSE_VERB[singularized.toLowerCase()];
      }
    }
    if (verb) {
      return {
        isFamilyMember: true,
        headword: verb.base,
        forms: uniqueForms([verb.base, verb.past, verb.part]),
        reason: 'irregular-verb',
      };
    }

    // 2. Regular verb — only on a clear "-ed" past form. We do NOT conjugate:
    //    the input itself is one of the forms, the lemma is the other.
    if (/ed$/.test(word) && word.length > 3) {
      const lemma = wl.verb(word);
      if (lemma && lemma.toLowerCase() !== word) {
        return {
          isFamilyMember: true,
          headword: lemma,
          forms: uniqueForms([lemma, word]),
          reason: 'regular-verb',
        };
      }
    }

    // 3. Plural noun — "shoes" → ["shoe", "shoes"], "children" → ["child", "children"].
    if (pluralize.isPlural(word)) {
      const singular = pluralize.singular(word);
      if (singular && singular.toLowerCase() !== word) {
        return {
          isFamilyMember: true,
          headword: singular,
          forms: uniqueForms([singular, word]),
          reason: 'plural-noun',
        };
      }
    }

    return { isFamilyMember: false };
  } catch (error) {
    // A throw inside the libs should never block the add-word flow.
    console.warn('[wordFamilyService] detect failed:', error);
    return null;
  }
}
