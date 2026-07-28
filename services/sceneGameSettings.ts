// ================================================================
// Scene Fusion Game — non-sensitive client-side settings.
//
// The refreshed pipeline (design doc §10) keeps ALL LLM keys server-side
// (Supabase Edge Secrets: SCENE_DESIGN_* / SCENE_VISION_*, with ② image
// render reusing PRIMARY_IMAGE_GEN_*). The browser never sees or sends keys.
//
// The Admin Console ("~" panel) persists two NON-SENSITIVE preferences
// client-side, both of which ride along in the scene-generate request body:
//   • `visionEnabled`   — ③ vision-refinement ON/OFF toggle.
//   • `directorProvider` — which server-side director config to use
//     ('default' = Minimax-m3, 'aliyun' = Tongyi/Qwen qwen-max). The selector
//     is just a string; NO keys ever leave the server, so this stays consistent
//     with §10's "keys server-side only" rule.
// ================================================================

/** Which server-side director config the scene pipeline should use. */
export type DirectorProvider = 'default' | 'aliyun';

export const DIRECTOR_PROVIDERS: DirectorProvider[] = ['default', 'aliyun'];

const normalizeDirectorProvider = (raw: string): DirectorProvider =>
  raw && raw.toLowerCase() === 'aliyun' ? 'aliyun' : 'default';

export interface SceneGameLLMSettings {
  /** Whether ③ vision region refinement runs. Default OFF (zones are used). */
  visionEnabled: boolean;
  /** Which director model config to use. Default 'default' (Minimax-m3). */
  directorProvider: DirectorProvider;
}

const PREFIX = 'vibe-word-scene-llm-';
const VISION_ENABLED_KEY = `${PREFIX}vision-enabled`;
const DIRECTOR_PROVIDER_KEY = `${PREFIX}director-provider`;

export const DEFAULT_SCENE_LLM_SETTINGS: SceneGameLLMSettings = {
  visionEnabled: false,
  directorProvider: 'default',
};

const safeGet = (key: string): string => {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(key) || '';
  } catch {
    return '';
  }
};

const safeSet = (key: string, value: string) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore quota / privacy-mode errors
  }
};

export const SceneGameSettings = {
  load(): SceneGameLLMSettings {
    return {
      visionEnabled: safeGet(VISION_ENABLED_KEY) === 'true',
      directorProvider: normalizeDirectorProvider(safeGet(DIRECTOR_PROVIDER_KEY)),
    };
  },

  save(settings: SceneGameLLMSettings) {
    safeSet(VISION_ENABLED_KEY, settings.visionEnabled ? 'true' : 'false');
    safeSet(DIRECTOR_PROVIDER_KEY, settings.directorProvider);
  },

  clear() {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(VISION_ENABLED_KEY);
      window.localStorage.removeItem(DIRECTOR_PROVIDER_KEY);
    } catch {
      // ignore
    }
  },

  /** Current ③ vision toggle (sent to the edge function in the request body). */
  isVisionEnabled(): boolean {
    return this.load().visionEnabled;
  },

  /** Current director provider (sent to the edge function in the request body). */
  getDirectorProvider(): DirectorProvider {
    return this.load().directorProvider;
  },

  setDirectorProvider(provider: DirectorProvider) {
    safeSet(DIRECTOR_PROVIDER_KEY, normalizeDirectorProvider(provider));
  },
};
