/**
 * Ambient declarations for untyped vendor modules used by the word-family
 * detector. We declare a DEFAULT export only, because under node's CJS↔ESM
 * interop the whole `module.exports` object surfaces as the default import
 * (named imports from these CJS packages are not statically detectable).
 * Vite/esbuild handle the default import identically, so this works in both
 * the browser bundle and `node --test`.
 */

declare module 'wink-lemmatizer' {
  const winkLemmatizer: {
    /** Map an inflected noun/adjective/verb form back to its base form (lemma). */
    noun(word: string): string | undefined;
    verb(word: string): string | undefined;
    adjective(word: string): string | undefined;
    lemmatizeNoun(word: string): string | undefined;
    lemmatizeVerb(word: string): string | undefined;
    lemmatizeAdjective(word: string): string | undefined;
  };
  export default winkLemmatizer;
}

declare module 'pluralize' {
  const pluralize: {
    /** Pluralize a singular noun (no-op if already plural). */
    plural(word: string): string;
    /** Singularize a plural noun (no-op if already singular). */
    singular(word: string): string;
    isPlural(word: string): boolean;
    isSingular(word: string): boolean;
    addPluralRule(rule: RegExp, replacement: string): void;
    addSingularRule(rule: RegExp, replacement: string): void;
    addIrregularRule(singular: string, plural: string): void;
    addUncountableRule(rule: RegExp | string): void;
  };
  export default pluralize;
}
