type ProviderConfig = {
  id: 'newapi' | 'tokendance';
  baseUrl: string;
  apiKey: string;
  model: string;
};

type QueueTask = {
  id: string;
  word: string;
  language: string;
  promptOverride?: string;
  attemptedProviders: Set<ProviderConfig['id']>;
  resolve: (value: { dataUrl: string; providerId: ProviderConfig['id'] }) => void;
  reject: (reason?: any) => void;
};

const readRuntimeEnv = (key: string): string => {
  const viteEnv = (import.meta as any)?.env;
  const viteVal = viteEnv?.[key];
  if (typeof viteVal === 'string' && viteVal.length > 0) return viteVal;

  const processEnv = typeof globalThis !== 'undefined' ? (globalThis as any)?.process?.env : undefined;
  const processVal = processEnv?.[key];
  if (typeof processVal === 'string' && processVal.length > 0) return processVal;

  return '';
};

const normalizeUrl = (url: string): string => url.trim().replace(/\/$/, '');

const getImageGenerationUrls = (baseUrl: string): string[] => {
  const sanitized = normalizeUrl(baseUrl);
  if (!sanitized) return [];
  if (sanitized.endsWith('/images/generations')) return [sanitized];
  return [`${sanitized}/v1/images/generations`, `${sanitized}/images/generations`];
};

const blobToDataUrl = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to convert image blob to data URL'));
    reader.readAsDataURL(blob);
  });
};

const convertImageUrlToDataUrl = async (imageUrl: string): Promise<string | null> => {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await blobToDataUrl(blob);
  } catch {
    return null;
  }
};

const buildPrompt = (word: string): string => {
  const normalized = word.trim();
  return [
    `Target word or phrase: "${normalized}".`,
    'Create a cartoon-style illustration that is intuitive and semantically accurate for this exact target.',
    'If the target is a noun, make the noun the visual subject.',
    'If the target is a verb or phrase, depict a clear action scene expressing the meaning.',
    'Do not add extra overlay subtitles, watermarks, UI labels, or unrelated floating captions.',
    'Natural text that belongs to scene objects is allowed and should be preserved when meaningful, such as blackboard writing, book pages/covers, road signs, or package text.',
    'Keep composition clear and educational, with key details easy to understand.'
  ].join(' ');
};

const getProviderConfigs = (): ProviderConfig[] => {
  const primaryBase = readRuntimeEnv('PRIMARY_IMAGE_GEN_BASE_URL') || readRuntimeEnv('IMAGE_GEN_ENDPOINT');
  const primaryKey = readRuntimeEnv('PRIMARY_IMAGE_GEN_API_KEY') || readRuntimeEnv('IMAGE_GEN_API_KEY');
  const primaryModel = readRuntimeEnv('PRIMARY_IMAGE_GEN_MODEL') || readRuntimeEnv('IMAGE_GEN_MODEL') || 'gpt-image-2';

  const backupBase = readRuntimeEnv('BACKUP_IMAGE_GEN_BASE_URL') || 'https://tokendance.space/gateway/v1/images/generations';
  const backupKey = readRuntimeEnv('BACKUP_IMAGE_GEN_API_KEY');
  const backupModel = readRuntimeEnv('BACKUP_IMAGE_GEN_MODEL') || 'ernie-image';

  const providers: ProviderConfig[] = [];

  if (primaryBase && primaryKey) {
    providers.push({
      id: 'newapi',
      baseUrl: primaryBase,
      apiKey: primaryKey,
      model: primaryModel,
    });
  }

  if (backupBase && backupKey) {
    providers.push({
      id: 'tokendance',
      baseUrl: backupBase,
      apiKey: backupKey,
      model: backupModel,
    });
  }

  return providers;
};

class ImageGenerationQueue {
  private queue: QueueTask[] = [];
  private busyProviders = new Set<ProviderConfig['id']>();

  private async generateByProvider(provider: ProviderConfig, prompt: string): Promise<string> {
    const urls = getImageGenerationUrls(provider.baseUrl);
    if (urls.length === 0) {
      throw new Error(`[${provider.id}] Invalid base URL`);
    }

    let lastError: string | null = null;

    for (const url of urls) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${provider.apiKey}`,
          },
          body: JSON.stringify({
            model: provider.model,
            prompt,
            n: 1,
            size: '1024x1024',
            response_format: 'b64_json',
          }),
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          const errorMessage = data?.error?.message || `${response.status} ${response.statusText}`;
          lastError = `[${provider.id}] ${errorMessage}`;
          continue;
        }

        const b64 = data?.data?.[0]?.b64_json;
        if (typeof b64 === 'string' && b64.length > 0) {
          return `data:image/png;base64,${b64}`;
        }

        const imageUrl = data?.data?.[0]?.url;
        if (typeof imageUrl === 'string' && imageUrl.length > 0) {
          const dataUrl = await convertImageUrlToDataUrl(imageUrl);
          if (dataUrl) return dataUrl;
        }

        lastError = `[${provider.id}] response has no b64_json/url`;
      } catch (error: any) {
        lastError = `[${provider.id}] ${error?.message || String(error)}`;
      }
    }

    throw new Error(lastError || `[${provider.id}] generation failed`);
  }

  private pickTaskForProvider(provider: ProviderConfig): QueueTask | null {
    const idx = this.queue.findIndex(task => !task.attemptedProviders.has(provider.id));
    if (idx < 0) return null;
    const [task] = this.queue.splice(idx, 1);
    return task || null;
  }

  private runProvider(provider: ProviderConfig) {
    if (this.busyProviders.has(provider.id)) return;

    const task = this.pickTaskForProvider(provider);
    if (!task) return;

    this.busyProviders.add(provider.id);

    const prompt = task.promptOverride || buildPrompt(task.word);

    void this.generateByProvider(provider, prompt)
      .then((dataUrl) => {
        task.resolve({ dataUrl, providerId: provider.id });
      })
      .catch((error) => {
        task.attemptedProviders.add(provider.id);

        const providers = getProviderConfigs();
        const hasAnotherProvider = providers.some(p => !task.attemptedProviders.has(p.id));

        if (hasAnotherProvider) {
          this.queue.push(task);
        } else {
          task.reject(error);
        }
      })
      .finally(() => {
        this.busyProviders.delete(provider.id);
        this.pump();
      });
  }

  private pump() {
    const providers = getProviderConfigs();
    for (const provider of providers) {
      this.runProvider(provider);
    }
  }

  enqueue(word: string, options?: { language?: string; promptOverride?: string }): Promise<{ dataUrl: string; providerId: ProviderConfig['id'] }> {
    const providers = getProviderConfigs();
    if (providers.length === 0) {
      return Promise.reject(new Error('No valid image providers configured'));
    }

    const text = (word || '').trim();
    if (!text) {
      return Promise.reject(new Error('Word is empty'));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        word: text,
        language: options?.language || 'en',
        promptOverride: options?.promptOverride,
        attemptedProviders: new Set(),
        resolve,
        reject,
      });

      this.pump();
    });
  }

  getSnapshot() {
    return {
      pendingCount: this.queue.length,
      busyProviders: Array.from(this.busyProviders),
      providers: getProviderConfigs().map(p => ({ id: p.id, baseUrl: p.baseUrl, model: p.model, hasApiKey: !!p.apiKey })),
    };
  }
}

const imageGenerationQueue = new ImageGenerationQueue();

export const requestQueuedWordImage = (word: string, options?: { language?: string; promptOverride?: string }) => {
  return imageGenerationQueue.enqueue(word, options);
};

export const getImageGenerationQueueSnapshot = () => imageGenerationQueue.getSnapshot();
