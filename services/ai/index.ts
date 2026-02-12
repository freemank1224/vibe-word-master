
import { AIService, AIProviderType, SpellingResult } from "./types";
import { WordEntry, InputSession } from "../../types";
import { GeminiProvider } from "./geminiProvider";
import { OpenAIProvider } from "./openaiProvider";
import { LocalProvider } from "./localProvider";
import { AISettings, AEServiceProvider, AITask } from "./settings";

class AIServiceManager implements AIService {
  private gemini = new GeminiProvider();
  private openai = new OpenAIProvider();
  private local = new LocalProvider();

  // Track AI availability for graceful degradation
  private enabled: boolean = false;
  private available: boolean = false;

  constructor() {
    this.checkAvailability();
  }

  private async checkAvailability() {
    // Check if AI service has valid configuration
    const config = this.resolveConfig('TEXT');
    this.enabled = !!config.apiKey;
    this.available = this.enabled;
  }

  private getProvider(type: string): AIService {
    const providerType = (type || 'gemini').toLowerCase();
    
    if (providerType === 'openai' || providerType === 'custom') {
      return this.openai; // Custom usually implies OpenAI-compatible API
    }
    
    return this.gemini;
  }

  private resolveConfig(task: AITask) {
    // 1. Try Task-Specific User Settings (BYOK)
    const userProvider = AISettings.getTaskProvider(task);
    const userConfig = AISettings.getConfig(userProvider, task);

    if (userConfig.apiKey) {
      return {
        providerType: userProvider,
        apiKey: userConfig.apiKey,
        endpoint: userConfig.endpoint,
        modelName: userConfig.modelName
      };
    }

    // 2. Fallback to Global User Settings (Legacy/Default)
    const globalProvider = AISettings.getProvider();
    const globalConfig = AISettings.getConfig(globalProvider);
    if (globalConfig.apiKey) {
      return {
        providerType: globalProvider,
        apiKey: globalConfig.apiKey,
        endpoint: globalConfig.endpoint,
        modelName: globalConfig.modelName
      };
    }

    // 3. Fallback to Environment Variables
    const envProvider = process.env[`${task}_PROVIDER`] || 'gemini';
    const envKey = process.env[`${task}_API_KEY`];
    const envEndpoint = process.env[`${task}_ENDPOINT`] || 
                       (envProvider === 'openai' ? process.env.OPENAI_ENDPOINT : process.env.GEMINI_ENDPOINT);

    return {
      providerType: envProvider,
      apiKey: envKey,
      endpoint: envEndpoint,
      modelName: undefined
    };
  }

  async generateImageHint(word: string, promptOverride?: string): Promise<string | null> {
    const { providerType, apiKey, endpoint } = this.resolveConfig('IMAGE_GEN');
    const provider = this.getProvider(providerType);
    return provider.generateImageHint(word, promptOverride, apiKey, endpoint);
  }

  async generateSpeech(text: string): Promise<AudioBuffer | string | null> {
    const { providerType, apiKey, endpoint } = this.resolveConfig('TEXT');
    const provider = this.getProvider(providerType);
    return provider.generateSpeech(text, apiKey, endpoint);
  }

  async extractWordFromImage(base64Image: string): Promise<string | null> {
    const { providerType, apiKey, endpoint } = this.resolveConfig('VISION');
    const provider = this.getProvider(providerType);
    return provider.extractWordFromImage(base64Image, apiKey, endpoint);
  }

  async validateSpelling(word: string, apiKey?: string, endpoint?: string, options?: { skipLLM?: boolean }): Promise<SpellingResult> {
    // 1. Try local validation first
    const localResult = await this.local.validateSpelling(word);
    if (localResult.found) {
      console.log(`Local validation hit for: "${word}"`);
      return { 
        isValid: localResult.isValid, 
        suggestion: localResult.suggestion || undefined 
      };
    }

    if (options?.skipLLM) {
        return { isValid: false, found: false };
    }

    // 2. Fallback to LLM
    console.log(`Local validation miss for: "${word}", falling back to LLM...`);
    
    // If explicit args provided (e.g. from testing UI), use them
    if (apiKey) {
       const userProvider = AISettings.getProvider();
       const provider = this.getProvider(userProvider);
       return provider.validateSpelling(word, apiKey, endpoint);
    }

    const { providerType, apiKey: resolvedKey, endpoint: resolvedEndpoint } = this.resolveConfig('TEXT');
    const provider = this.getProvider(providerType);

    return provider.validateSpelling(word, resolvedKey, resolvedEndpoint);
  }

  async optimizeWordSelection(
      words: WordEntry[],
      sessions: InputSession[],
      targetCount: number
  ): Promise<string[] | null> {
    const { providerType, apiKey, endpoint } = this.resolveConfig('TEXT');
    const provider = this.getProvider(providerType);

    if (!provider.optimizeWordSelection) return null;

    return provider.optimizeWordSelection(words, sessions, targetCount, apiKey, endpoint);
  }

  /**
   * Validates a phrase (2-3 words).
   * Returns validation result with highlighting and collocation check flag.
   */
  async validatePhrase(phrase: string): Promise<SpellingResult> {
    // Use LocalProvider for phrase validation
    if (this.local.validatePhrase) {
      return await this.local.validatePhrase(phrase);
    }
    // Fallback: just validate as a single word
    return await this.validateSpelling(phrase);
  }

  /**
   * Validates if a 2-word phrase is a common collocation.
   * Returns { isCommon: boolean } with 5-second timeout and graceful degradation.
   */
  async validateCollocation(phrase: string): Promise<{ isCommon: boolean }> {
    // Re-check availability in case it changed
    await this.checkAvailability();

    if (!this.enabled || !this.available) {
      console.log('AI unavailable, assuming phrase is valid');
      return { isCommon: true }; // Degradation: assume valid
    }

    try {
      // 5-second timeout protection
      const result = await Promise.race([
        this.performCollocationCheck(phrase),
        new Promise<{ isCommon: boolean }>((resolve) =>
          setTimeout(() => resolve({ isCommon: true }), 5000)
        )
      ]);
      return result;
    } catch (error) {
      console.error('Collocation check failed:', error);
      return { isCommon: true }; // Conservative degradation
    }
  }

  private async performCollocationCheck(phrase: string): Promise<{ isCommon: boolean }> {
    const { providerType, apiKey, endpoint } = this.resolveConfig('TEXT');
    const provider = this.getProvider(providerType);

    if (provider.validateCollocation) {
      return await provider.validateCollocation(phrase, apiKey, endpoint);
    }
    // Fallback: assume common
    return { isCommon: true };
  }
}


export const aiService = new AIServiceManager();
export * from "./types";
