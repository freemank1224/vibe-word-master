
import { AIService, AIProviderType, SpellingResult } from "./types";
import { WordEntry, InputSession } from "../../types";
import { GeminiProvider } from "./geminiProvider";
import { OpenAIProvider } from "./openaiProvider";
import { LocalProvider } from "./localProvider";
import { AISettings, AEServiceProvider, AITask } from "./settings";
import { isSupabaseConfigured, supabase } from "../../lib/supabaseClient";

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
  private missingSpellingApiKeyWarned = false;
  private spellingEdgeUnavailableWarned = false;

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

  private resolveProviderApiKey(providerType: string): string | undefined {
    const lowered = (providerType || 'gemini').toLowerCase();
    if (lowered === 'openai' || lowered === 'custom') {
      return readRuntimeEnv('OPENAI_API_KEY') || readRuntimeEnv('VITE_OPENAI_API_KEY');
    }
    return readRuntimeEnv('GEMINI_API_KEY') || readRuntimeEnv('VITE_GEMINI_API_KEY');
  }

  private async validateSpellingViaEdge(word: string): Promise<SpellingResult | null> {
    if (!isSupabaseConfigured) return null;

    try {
      const edgeCall = supabase.functions.invoke('spelling-check', {
        body: { word }
      });

      const timeoutMs = 2500;
      const result = await Promise.race([
        edgeCall,
        new Promise<{ data: any; error: any }>((resolve) =>
          setTimeout(() => resolve({ data: null, error: new Error('spelling-check invoke timeout') }), timeoutMs)
        )
      ]);

      const { data, error } = result;

      if (error) {
        if (!this.spellingEdgeUnavailableWarned) {
          console.warn('spelling-check edge invoke failed, using permissive fallback:', error.message || error);
          this.spellingEdgeUnavailableWarned = true;
        }
        return { isValid: true, serviceError: true };
      }

      if (typeof data?.isValid === 'boolean') {
        return {
          isValid: data.isValid,
          suggestion: typeof data?.suggestion === 'string' ? data.suggestion : undefined,
          serviceError: data?.serviceError === true,
        };
      }

      return { isValid: true, serviceError: true };
    } catch (error) {
      if (!this.spellingEdgeUnavailableWarned) {
        console.warn('spelling-check edge invocation error, using permissive fallback:', error);
        this.spellingEdgeUnavailableWarned = true;
      }
      return { isValid: true, serviceError: true };
    }
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
      || (task === 'IMAGE_GEN' ? 'openai' : 'gemini');
    const providerFallbackKey = this.resolveProviderApiKey(envProvider);
    const envKey =
      readRuntimeEnv(`${task}_API_KEY`)
      || readRuntimeEnv(`VITE_${task}_API_KEY`)
      || providerFallbackKey;
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
    const effectiveProvider = (providerType || 'openai').toLowerCase();
    const provider = (effectiveProvider === 'openai' || effectiveProvider === 'custom')
      ? this.openai
      : this.getProvider(providerType);
    return provider.generateImageHint(word, promptOverride, apiKey, endpoint);
  }

  getImageGenerationDebugInfo() {
    const resolved = this.resolveConfig('IMAGE_GEN');
    const fromEnv = {
      provider: readRuntimeEnv('IMAGE_GEN_PROVIDER') || readRuntimeEnv('VITE_IMAGE_GEN_PROVIDER') || null,
      endpoint: readRuntimeEnv('IMAGE_GEN_ENDPOINT') || readRuntimeEnv('VITE_IMAGE_GEN_ENDPOINT') || null,
      hasApiKey: !!(readRuntimeEnv('IMAGE_GEN_API_KEY') || readRuntimeEnv('VITE_IMAGE_GEN_API_KEY')),
      primaryBaseUrl: readRuntimeEnv('PRIMARY_IMAGE_GEN_BASE_URL') || readRuntimeEnv('VITE_PRIMARY_IMAGE_GEN_BASE_URL') || null,
      hasPrimaryApiKey: !!(readRuntimeEnv('PRIMARY_IMAGE_GEN_API_KEY') || readRuntimeEnv('VITE_PRIMARY_IMAGE_GEN_API_KEY')),
      primaryModel: readRuntimeEnv('PRIMARY_IMAGE_GEN_MODEL') || readRuntimeEnv('VITE_PRIMARY_IMAGE_GEN_MODEL') || null,
      backupBaseUrl: readRuntimeEnv('BACKUP_IMAGE_GEN_BASE_URL') || readRuntimeEnv('VITE_BACKUP_IMAGE_GEN_BASE_URL') || null,
      hasBackupApiKey: !!(readRuntimeEnv('BACKUP_IMAGE_GEN_API_KEY') || readRuntimeEnv('VITE_BACKUP_IMAGE_GEN_API_KEY')),
      backupModel: readRuntimeEnv('BACKUP_IMAGE_GEN_MODEL') || readRuntimeEnv('VITE_BACKUP_IMAGE_GEN_MODEL') || null,
      imageModel: readRuntimeEnv('IMAGE_GEN_MODEL') || readRuntimeEnv('VITE_IMAGE_GEN_MODEL') || null,
    };

    return {
      resolvedProviderType: resolved.providerType,
      resolvedEndpoint: resolved.endpoint || null,
      resolvedHasApiKey: !!resolved.apiKey,
      env: fromEnv,
      timestamp: new Date().toISOString(),
    };
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

    const edgeResult = await this.validateSpellingViaEdge(word);
    if (edgeResult) {
      if (edgeResult.serviceError) {
        return { isValid: true };
      }
      return edgeResult;
    }

     // 2. Fallback to remote spelling check
    // If explicit args provided (e.g. from testing UI), use them
    if (apiKey) {
       console.log(`Local validation miss for: "${word}", falling back to remote spelling check...`);
       const userProvider = AISettings.getProvider();
       const provider = this.getProvider(userProvider);
       return provider.validateSpelling(word, apiKey, endpoint);
    }

    const { providerType, apiKey: resolvedKey, endpoint: resolvedEndpoint } = this.resolveConfig('TEXT');
    const spellingProviderType =
      readRuntimeEnv('SPELLING_CHECK_PROVIDER')
      || readRuntimeEnv('VITE_SPELLING_CHECK_PROVIDER')
      || providerType;
    const spellingProvider = this.getProvider(spellingProviderType);

    const spellingApiKey =
      readRuntimeEnv('SPELLING_CHECK_API_KEY')
      || readRuntimeEnv('VITE_SPELLING_CHECK_API_KEY')
      || resolvedKey;

    const spellingEndpoint =
      readRuntimeEnv('SPELLING_CHECK_ENDPOINT')
      || readRuntimeEnv('VITE_SPELLING_CHECK_ENDPOINT')
      || resolvedEndpoint;

    if (!spellingApiKey) {
      if (!this.missingSpellingApiKeyWarned) {
        console.warn('No spelling API key configured (SPELLING_CHECK_API_KEY / GEMINI_API_KEY). Remote spelling check is disabled, using permissive fallback.');
        this.missingSpellingApiKeyWarned = true;
      }
      return { isValid: true };
    }

    console.log(`Local validation miss for: "${word}", falling back to remote spelling check...`);

    const timeoutMs = this.getValidationTimeoutMs();
    try {
      return await this.withTimeout(
        spellingProvider.validateSpelling(word, spellingApiKey, spellingEndpoint),
        timeoutMs,
        { isValid: true }
      );
    } catch (error) {
      console.warn(`Remote spelling check failed, fallback to permissive mode for "${word}":`, error);
      return { isValid: true };
    }
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
