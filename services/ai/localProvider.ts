
import { AIService, SpellingResult } from "./types";
import nspell from "nspell";

/**
 * A local spelling provider that uses a full Hunspell dictionary (loaded via nspell).
 * This provides high-quality offline spell checking.
 */
export class LocalProvider implements Partial<AIService> {
  private spell: any = null;
  private loadingPromise: Promise<void> | null = null;

  constructor() {
    this.ensureLoaded();
  }

  private async ensureLoaded() {
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      try {
        console.log("Loading local dictionary...");
        const [affRes, dicRes] = await Promise.all([
          fetch("/dictionaries/en.aff"),
          fetch("/dictionaries/en.dic")
        ]);

        if (!affRes.ok || !dicRes.ok) throw new Error("Failed to load dictionary files");

        const affData = await affRes.text();
        const dicData = await dicRes.text();

        this.spell = nspell(affData, dicData);
        console.log("Local dictionary loaded successfully.");
      } catch (error) {
        console.error("LocalProvider: Failed to initialize nspell", error);
        this.spell = null;
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
    // Huntspell is case-sensitive, but for simple vocab check we usually want to be permissive
    // or check both original and lowercase.
    let isValid = this.spell.correct(normalizedWord);
    
    // Try lowercase if original failed
    if (!isValid && normalizedWord !== normalizedWord.toLowerCase()) {
      isValid = this.spell.correct(normalizedWord.toLowerCase());
    }

    if (isValid) {
      return { found: true, isValid: true };
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
}
