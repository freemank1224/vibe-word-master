import { ImageGenerationProviderId, requestImageGenerationViaEdge } from './imageGenerationEdge';

type QueueTask = {
  id: string;
  word: string;
  language: string;
  promptOverride?: string;
  resolve: (value: { dataUrl: string; providerId: ImageGenerationProviderId }) => void;
  reject: (reason?: any) => void;
};

class ImageGenerationQueue {
  private queue: QueueTask[] = [];
  private busy = false;

  private pump() {
    if (this.busy || this.queue.length === 0) return;

    const task = this.queue.shift();
    if (!task) return;

    this.busy = true;

    void requestImageGenerationViaEdge({
      word: task.word,
      language: task.language,
      promptOverride: task.promptOverride,
    })
      .then(({ dataUrl, providerId }) => {
        task.resolve({ dataUrl, providerId });
      })
      .catch((error) => {
        task.reject(error);
      })
      .finally(() => {
        this.busy = false;
        this.pump();
      });
  }

  enqueue(word: string, options?: { language?: string; promptOverride?: string }): Promise<{ dataUrl: string; providerId: ImageGenerationProviderId }> {
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
        resolve,
        reject,
      });

      this.pump();
    });
  }

  getSnapshot() {
    return {
      pendingCount: this.queue.length,
      busyProviders: this.busy ? ['edge'] : [],
      mode: 'edge-function',
      primaryUnavailableUntil: null,
      providers: [{ id: 'edge', baseUrl: 'supabase/functions/v1/image-generate', model: 'server-managed', hasApiKey: true }],
    };
  }
}

const imageGenerationQueue = new ImageGenerationQueue();

export const requestQueuedWordImage = (word: string, options?: { language?: string; promptOverride?: string }) => {
  return imageGenerationQueue.enqueue(word, options);
};

export const getImageGenerationQueueSnapshot = () => imageGenerationQueue.getSnapshot();
