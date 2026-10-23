
import type { AIService, SpellingResult } from "./types.ts";
import nspell from "nspell";

/**
 * A local spelling provider that uses a full Hunspell dictionary (loaded via nspell).
 * This provides high-quality offline spell checking.
 */
export class LocalProvider implements Partial<AIService> {
  private spell: ReturnType<typeof nspell> | null = null;
  private loadingPromise: Promise<void> | null = null;
  private loadTimeoutMs: number;

  constructor(options: { loadTimeoutMs?: number } = {}) {
    const timeout = options.loadTimeoutMs ?? 8000;
    this.loadTimeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 8000;
  }

  private buildCaseCandidates(input: string): string[] {
    const trimmed = input.trim();
    if (!trimmed) return [];

    const lower = trimmed.toLowerCase();
    const title = lower.charAt(0).toUpperCase() + lower.slice(1);
    const upper = trimmed.toUpperCase();

    return Array.from(new Set([trimmed, lower, title, upper]));
  }

  private resolveWordValidation(input: string): { isValid: boolean; normalized?: string } {
    const candidates = this.buildCaseCandidates(input);
    for (const candidate of candidates) {
      if (this.spell.correct(candidate)) {
        return {
          isValid: true,
          normalized: candidate !== input.trim() ? candidate : undefined,
        };
      }
    }

    return { isValid: false };
  }

  private async ensureLoaded() {
    if (this.spell) return;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        console.log("Loading local dictionary...");
        const download = (async () => {
          const [affRes, dicRes] = await Promise.all([
            fetch("/dictionaries/en.aff", { signal: controller.signal }),
            fetch("/dictionaries/en.dic", { signal: controller.signal })
          ]);

          if (!affRes.ok || !dicRes.ok) throw new Error("Failed to load dictionary files");
          return Promise.all([affRes.text(), dicRes.text()]);
        })();

        // The same budget covers headers and both response bodies. Race as
        // well as abort so even a stalled response that ignores cancellation
        // cannot leave the first input waiting forever.
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Local dictionary download timed out'));
          }, this.loadTimeoutMs);
        });
        const [affData, dicData] = await Promise.race([download, deadline]);

        this.spell = nspell(affData, dicData);
        console.log("Local dictionary loaded successfully.");
      } catch (error) {
        controller.abort();
        console.error("LocalProvider: Failed to initialize nspell", error);
        this.spell = null;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        // A first attempt while offline must not disable local spelling for
        // the rest of the session. A later validation can retry the download.
        this.loadingPromise = null;
      }
    })();

    return this.loadingPromise;
  }

  async validateSpelling(word: string): Promise<{ found: boolean; isValid: boolean; suggestion?: string | null }> {
    await this.ensureLoaded();

    if (!this.spell) {
      return { found: false, isValid: false };
    }

    const normalizedWord = word.trim();
    const validation = this.resolveWordValidation(normalizedWord);
    const isValid = validation.isValid;

    if (isValid) {
      return {
        found: true,
        isValid: true,
        suggestion: validation.normalized || undefined,
      };
    } else {
      const suggestions = this.spell.suggest(normalizedWord);

      // If we found a suggestion locally, we treat it as a "hit" to avoid LLM tokens.
      // If no suggestion is found, it might be a very weird word or a technical term,
      // so we fallback to LLM.
      if (suggestions.length > 0) {
        return {
          found: true,
          isValid: false,
          suggestion: suggestions[0]
        };
      }

      return { found: false, isValid: false };
    }
  }

  /**
   * Validates a phrase (2-3 words).
   * Splits phrase and validates each word's spelling.
   * Returns validation result with highlighting and collocation check flag.
   */
  async validatePhrase(phrase: string): Promise<SpellingResult> {
    await this.ensureLoaded();

    if (!this.spell) {
      return { isValid: false, error: 'DICT_NOT_LOADED' };
    }

    const trimmedPhrase = phrase.trim();
    const words = trimmedPhrase.split(/\s+/).filter(w => w.length > 0);

    // Check length: only support 2-3 word phrases
    if (words.length < 2 || words.length > 3) {
      return {
        isValid: false,
        error: words.length < 2 ? 'TOO_FEW_WORDS' : 'TOO_MANY_WORDS',
        suggestion: words.length < 2
          ? 'Please enter at least 2 words for a phrase'
          : 'Please enter 2-3 words only'
      };
    }

    // Validate each word's spelling
    const wordResults = words.map(word => {
      const normalizedWord = word.trim();
      const validation = this.resolveWordValidation(normalizedWord);

      return {
        word: normalizedWord,
        isValid: validation.isValid,
        normalized: validation.normalized,
        suggestion: validation.isValid ? validation.normalized : this.spell.suggest(normalizedWord)?.[0]
      };
    });

    // Check if any word is misspelled
    const misspelledWords = wordResults.filter(r => !r.isValid);

    if (misspelledWords.length > 0) {
      // Create highlighted phrase with errors in brackets
      const highlightedPhrase = wordResults
        .map(r => r.isValid ? r.word : `[${r.word}]`)
        .join(' ');

      // Get suggestions for all misspelled words
      const suggestionPhrase = wordResults
        .map(r => r.isValid ? r.word : (r.suggestion || r.word))
        .join(' ');

      return {
        isValid: false,
        highlightedPhrase,
        suggestion: suggestionPhrase
      };
    }

    // All words are spelled correctly
    const normalizedSuggestion = wordResults
      .map(r => r.normalized || r.word)
      .join(' ');

    // 2-word phrases need collocation check
    if (words.length === 2) {
      return {
        isValid: true,
        suggestion: normalizedSuggestion !== trimmedPhrase ? normalizedSuggestion : undefined,
        needsCollocationCheck: true
      };
    }

    // 3-word phrases: assume they are reasonable combinations
    return {
      isValid: true,
      suggestion: normalizedSuggestion !== trimmedPhrase ? normalizedSuggestion : undefined,
    };
  }
}
