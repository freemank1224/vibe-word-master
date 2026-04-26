
import { AIService, AIProviderType, SpellingResult } from "./types";
import { WordEntry, InputSession } from "../../types";
import { GeminiProvider } from "./geminiProvider";
import { OpenAIProvider } from "./openaiProvider";
import { LocalProvider } from "./localProvider";
import { AISettings, AEServiceProvider, AITask } from "./settings";

const readRuntimeEnv = (key: string): string | undefined => {
  const viteEnv = (import.meta as any)?.env;
  const viteVal = viteEnv?.[key];
  if (typeof viteVal === 'string' && viteVal.length > 0) return viteVal;

  const processEnv = typeof globalThis !== 'undefined' ? (globalThis as any)?.process?.env : undefined;
  const processVal = processEnv?.[key];
  if (typeof processVal === 'string' && processVal.length > 0) return processVal;

  return undefined;
};

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

  private getValidationTimeoutMs(): number {
    const raw = readRuntimeEnv('VITE_SPELLING_TIMEOUT_MS') || readRuntimeEnv('SPELLING_TIMEOUT_MS') || '2000';
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return 2000;
    return Math.max(500, Math.min(5000, parsed));
  }

  private getPreferredTextEndpoint(defaultEndpoint?: string): string | undefined {
    return (
      readRuntimeEnv('VITE_TEXT_ENDPOINT_CN')
      || readRuntimeEnv('TEXT_ENDPOINT_CN')
      || defaultEndpoint
    );
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs))
    ]);
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
    const envProvider =
      readRuntimeEnv(`${task}_PROVIDER`)
      || readRuntimeEnv(`VITE_${task}_PROVIDER`)
      || 'gemini';
    const envKey =
      readRuntimeEnv(`${task}_API_KEY`)
      || readRuntimeEnv(`VITE_${task}_API_KEY`);
    const envEndpoint =
      readRuntimeEnv(`${task}_ENDPOINT`)
      || readRuntimeEnv(`VITE_${task}_ENDPOINT`)
      || (envProvider === 'openai'
        ? (readRuntimeEnv('OPENAI_ENDPOINT') || readRuntimeEnv('VITE_OPENAI_ENDPOINT'))
        : (readRuntimeEnv('GEMINI_ENDPOINT') || readRuntimeEnv('VITE_GEMINI_ENDPOINT')));

    const resolved = {
      providerType: envProvider,
      apiKey: envKey,
      endpoint: envEndpoint,
      modelName: undefined
    };

    if (task === 'TEXT') {
      resolved.endpoint = this.getPreferredTextEndpoint(resolved.endpoint);
    }

    return resolved;
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

    const timeoutMs = this.getValidationTimeoutMs();
    return this.withTimeout(
      provider.validateSpelling(word, resolvedKey, resolvedEndpoint),
      timeoutMs,
      { isValid: false, serviceError: true }
    );
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
      // Timeout protection (default 2s, configurable)
      const timeoutMs = this.getValidationTimeoutMs();
      const result = await Promise.race([
        this.performCollocationCheck(phrase),
        new Promise<{ isCommon: boolean }>((resolve) =>
          setTimeout(() => resolve({ isCommon: true }), timeoutMs)
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
