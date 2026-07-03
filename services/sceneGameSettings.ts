// ================================================================
// Scene Fusion Game — non-sensitive client-side settings.
//
// The refreshed pipeline (design doc §10) keeps ALL LLM keys server-side
// (Supabase Edge Secrets: SCENE_DESIGN_* / SCENE_VISION_*, with ② image
// render reusing PRIMARY_IMAGE_GEN_*). The browser never sees or sends keys.
//
// The only thing the Admin Console ("~" panel) persists client-side is the
// ③ vision-refinement ON/OFF toggle — a non-sensitive preference. It rides
// along in the scene-generate request body as `visionEnabled`.
// ================================================================

export interface SceneGameLLMSettings {
  /** Whether ③ vision region refinement runs. Default OFF (zones are used). */
  visionEnabled: boolean;
}

const PREFIX = 'vibe-word-scene-llm-';
const VISION_ENABLED_KEY = `${PREFIX}vision-enabled`;

export const DEFAULT_SCENE_LLM_SETTINGS: SceneGameLLMSettings = {
  visionEnabled: false,
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
    };
  },

  save(settings: SceneGameLLMSettings) {
    safeSet(VISION_ENABLED_KEY, settings.visionEnabled ? 'true' : 'false');
  },

  clear() {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(VISION_ENABLED_KEY);
    } catch {
      // ignore
    }
  },

  /** Current ③ vision toggle (sent to the edge function in the request body). */
  isVisionEnabled(): boolean {
    return this.load().visionEnabled;
  },
};
