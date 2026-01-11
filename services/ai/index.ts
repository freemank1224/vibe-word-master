
import { AIService, AIProviderType } from "./types";
import { GeminiProvider } from "./geminiProvider";
import { OpenAIProvider } from "./openaiProvider";
import { LocalProvider } from "./localProvider";

class AIServiceManager implements AIService {
  private gemini = new GeminiProvider();
  private openai = new OpenAIProvider();
  private local = new LocalProvider();

  private getProvider(type: string): AIService {
    const providerType = (type || 'gemini').toLowerCase() as AIProviderType;
    switch (providerType) {
      case 'openai':
        return this.openai;
      case 'gemini':
      default:
        return this.gemini;
    }
  }

  async generateImageHint(word: string): Promise<string | null> {
    const providerType = process.env.IMAGE_GEN_PROVIDER || 'gemini';
    const provider = this.getProvider(providerType);
    const endpoint = process.env.IMAGE_GEN_ENDPOINT || (providerType === 'openai' ? process.env.OPENAI_ENDPOINT : process.env.GEMINI_ENDPOINT);
    return provider.generateImageHint(word, process.env.IMAGE_GEN_API_KEY, endpoint);
  }

  async generateSpeech(text: string): Promise<AudioBuffer | string | null> {
    const providerType = process.env.TTS_PROVIDER || 'gemini';
    const provider = this.getProvider(providerType);
    const endpoint = process.env.TTS_ENDPOINT || (providerType === 'openai' ? process.env.OPENAI_ENDPOINT : process.env.GEMINI_ENDPOINT);
    return provider.generateSpeech(text, process.env.TTS_API_KEY, endpoint);
  }

  async extractWordFromImage(base64Image: string): Promise<string | null> {
    const providerType = process.env.OCR_PROVIDER || 'gemini';
    const provider = this.getProvider(providerType);
    const endpoint = process.env.OCR_ENDPOINT || (providerType === 'openai' ? process.env.OPENAI_ENDPOINT : process.env.GEMINI_ENDPOINT);
    return provider.extractWordFromImage(base64Image, process.env.OCR_API_KEY, endpoint);
  }

  async validateSpelling(word: string): Promise<SpellingResult> {
    // 1. Try local validation first (browser-based/dictionary scheme)
    const localResult = await this.local.validateSpelling(word);
    if (localResult.found) {
      console.log(`Local validation hit for: "${word}"`);
      return { 
        isValid: localResult.isValid, 
        suggestion: localResult.suggestion || undefined 
      };
    }

    // 2. Fallback to LLM if local check is inconclusive
    console.log(`Local validation miss for: "${word}", falling back to LLM...`);
    const providerType = process.env.SPELLING_CHECK_PROVIDER || 'gemini';
    const provider = this.getProvider(providerType);
    const endpoint = process.env.SPELLING_CHECK_ENDPOINT || (providerType === 'openai' ? process.env.OPENAI_ENDPOINT : process.env.GEMINI_ENDPOINT);
    return provider.validateSpelling(word, process.env.SPELLING_CHECK_API_KEY, endpoint);
  }
}

export const aiService = new AIServiceManager();
export * from "./types";
