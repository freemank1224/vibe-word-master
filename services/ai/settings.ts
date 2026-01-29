export type AEServiceProvider = 'openai' | 'gemini' | 'custom';
export type AITask = 'IMAGE_GEN' | 'VISION' | 'TEXT';

export interface AIConfig {
  provider: AEServiceProvider;
  apiKey: string;
  endpoint?: string;
  modelName?: string;
}

const STORAGE_KEY_PREFIX = 'vibe-word-ai-settings-';

export const AISettings = {
  getTaskProvider: (task: AITask): AEServiceProvider => {
    return (localStorage.getItem(`${STORAGE_KEY_PREFIX}${task}-provider`) as AEServiceProvider) || 'gemini';
  },

  setTaskProvider: (task: AITask, provider: AEServiceProvider) => {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${task}-provider`, provider);
  },

  getProvider: (): AEServiceProvider => {
    // Legacy support or default for unspecified tasks
    return (localStorage.getItem(`${STORAGE_KEY_PREFIX}provider`) as AEServiceProvider) || 'gemini';
  },

  setProvider: (provider: AEServiceProvider) => {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}provider`, provider);
  },

  getConfig: (provider: AEServiceProvider, task?: AITask): Partial<AIConfig> => {
    const prefix = task ? `${STORAGE_KEY_PREFIX}${task}-${provider}` : `${STORAGE_KEY_PREFIX}${provider}`;
    return {
      apiKey: localStorage.getItem(`${prefix}-key`) || '',
      endpoint: localStorage.getItem(`${prefix}-endpoint`) || '',
      modelName: localStorage.getItem(`${prefix}-model`) || '',
    };
  },

  setConfig: (provider: AEServiceProvider, config: Partial<AIConfig>, task?: AITask) => {
    const prefix = task ? `${STORAGE_KEY_PREFIX}${task}-${provider}` : `${STORAGE_KEY_PREFIX}${provider}`;
    if (config.apiKey !== undefined) localStorage.setItem(`${prefix}-key`, config.apiKey);
    if (config.endpoint !== undefined) localStorage.setItem(`${prefix}-endpoint`, config.endpoint);
    if (config.modelName !== undefined) localStorage.setItem(`${prefix}-model`, config.modelName);
  },

  clearConfig: () => {
    const keys = Object.keys(localStorage);
    keys.forEach(key => {
      if (key.startsWith(STORAGE_KEY_PREFIX)) {
        localStorage.removeItem(key);
      }
    });
  },

  // Helper to get effective config (User defined > Env defined)
  getEffectiveConfig: (providerType: AEServiceProvider) => {
    const userConfig = AISettings.getConfig(providerType);
    
    // Fallback logic could be complex depending on how env vars are named, 
    // but here we let the Provider classes handle the env fallback if the passed key is empty.
    return userConfig;
  }
};
