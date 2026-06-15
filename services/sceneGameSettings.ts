// ================================================================
// Scene Fusion Game — LLM settings (stored client-side, surfaced in the
// Admin Console / "~" panel). These power the refreshed pipeline's two
// LLMs: ① the scene director (text) and ③ the optional vision refiner.
//
// The app stores the user's own keys in localStorage (same model as
// services/ai/settings.ts AISettings). When invoking the scene-generate
// edge function we forward them in the request body; the edge function
// uses caller config first and falls back to its own secrets / defaults.
// ================================================================

export interface SceneLLMEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface SceneGameLLMSettings {
  /** ① Scene director — strong text LLM (default gpt-4o). */
  design: SceneLLMEndpoint;
  /** ③ Vision region refinement — multimodal LLM (default gpt-4o). Optional. */
  vision: SceneLLMEndpoint;
  /** Whether ③ runs at all. Default OFF (zones are used by default). */
  visionEnabled: boolean;
}

const PREFIX = 'vibe-word-scene-llm-';
const DESIGN_KEY = `${PREFIX}design`;
const VISION_KEY = `${PREFIX}vision`;
const VISION_ENABLED_KEY = `${PREFIX}vision-enabled`;

export const DEFAULT_SCENE_LLM_SETTINGS: SceneGameLLMSettings = {
  design: { baseUrl: '', apiKey: '', model: '' },
  vision: { baseUrl: '', apiKey: '', model: '' },
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

const parseEndpoint = (raw: string): SceneLLMEndpoint => {
  try {
    const parsed = JSON.parse(raw);
    return {
      baseUrl: typeof parsed?.baseUrl === 'string' ? parsed.baseUrl : '',
      apiKey: typeof parsed?.apiKey === 'string' ? parsed.apiKey : '',
      model: typeof parsed?.model === 'string' ? parsed.model : '',
    };
  } catch {
    return { baseUrl: '', apiKey: '', model: '' };
  }
};

export const SceneGameSettings = {
  load(): SceneGameLLMSettings {
    return {
      design: parseEndpoint(safeGet(DESIGN_KEY)),
      vision: parseEndpoint(safeGet(VISION_KEY)),
      visionEnabled: safeGet(VISION_ENABLED_KEY) === 'true',
    };
  },

  save(settings: SceneGameLLMSettings) {
    safeSet(DESIGN_KEY, JSON.stringify(settings.design));
    safeSet(VISION_KEY, JSON.stringify(settings.vision));
    safeSet(VISION_ENABLED_KEY, settings.visionEnabled ? 'true' : 'false');
  },

  clear() {
    [DESIGN_KEY, VISION_KEY, VISION_ENABLED_KEY].forEach((k) => {
      if (typeof window === 'undefined') return;
      try {
        window.localStorage.removeItem(k);
      } catch {
        // ignore
      }
    });
  },

  /**
   * Build the `llmConfig` payload sent to the scene-generate edge function.
   * Empty strings are kept (the edge function treats empty as "fall back to
   * secret/default"), but fully-empty endpoint objects are omitted to keep
   * the payload small.
   */
  toRequestPayload(): {
    design?: SceneLLMEndpoint;
    vision?: SceneLLMEndpoint;
    visionEnabled: boolean;
  } {
    const s = SceneGameSettings.load();
    const payload: { design?: SceneLLMEndpoint; vision?: SceneLLMEndpoint; visionEnabled: boolean } = {
      visionEnabled: s.visionEnabled,
    };
    if (s.design.baseUrl || s.design.apiKey || s.design.model) payload.design = s.design;
    if (s.vision.baseUrl || s.vision.apiKey || s.vision.model) payload.vision = s.vision;
    return payload;
  },
};
