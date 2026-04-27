
import { AIService, SpellingResult } from "./types";
import { WordEntry, InputSession } from "../../types";

const readRuntimeEnv = (key: string): string => {
  const viteEnv = (import.meta as any)?.env;
  const viteVal = viteEnv?.[key];
  if (typeof viteVal === 'string' && viteVal.length > 0) return viteVal;

  const processEnv = typeof globalThis !== 'undefined' ? (globalThis as any)?.process?.env : undefined;
  const processVal = processEnv?.[key];
  if (typeof processVal === 'string' && processVal.length > 0) return processVal;

  return "";
};

export class OpenAIProvider implements AIService {
  private get defaultApiKey(): string {
    return readRuntimeEnv('OPENAI_API_KEY') || readRuntimeEnv('VITE_OPENAI_API_KEY') || "";
  }

  private get defaultEndpoint(): string {
    return readRuntimeEnv('OPENAI_ENDPOINT') || readRuntimeEnv('VITE_OPENAI_ENDPOINT') || "https://api.openai.com/v1";
  }

  private get primaryImageEndpoint(): string {
    return readRuntimeEnv('PRIMARY_IMAGE_GEN_BASE_URL')
      || readRuntimeEnv('VITE_PRIMARY_IMAGE_GEN_BASE_URL')
      || readRuntimeEnv('IMAGE_GEN_ENDPOINT')
      || readRuntimeEnv('VITE_IMAGE_GEN_ENDPOINT')
      || 'https://newapi.omgteam.me';
  }

  private get primaryImageApiKey(): string {
    return readRuntimeEnv('PRIMARY_IMAGE_GEN_API_KEY')
      || readRuntimeEnv('VITE_PRIMARY_IMAGE_GEN_API_KEY')
      || readRuntimeEnv('IMAGE_GEN_API_KEY')
      || readRuntimeEnv('VITE_IMAGE_GEN_API_KEY')
      || this.defaultApiKey;
  }

  private get backupImageEndpoint(): string {
    return readRuntimeEnv('BACKUP_IMAGE_GEN_BASE_URL')
      || readRuntimeEnv('VITE_BACKUP_IMAGE_GEN_BASE_URL')
      || 'https://tokendance.space/gateway/v1/images/generations';
  }

  private get backupImageApiKey(): string {
    return readRuntimeEnv('BACKUP_IMAGE_GEN_API_KEY')
      || readRuntimeEnv('VITE_BACKUP_IMAGE_GEN_API_KEY')
      || '';
  }

  private get imageGenModel(): string {
    return readRuntimeEnv('PRIMARY_IMAGE_GEN_MODEL')
      || readRuntimeEnv('VITE_PRIMARY_IMAGE_GEN_MODEL')
      || readRuntimeEnv('IMAGE_GEN_MODEL')
      || readRuntimeEnv('VITE_IMAGE_GEN_MODEL')
      || 'gpt-image-2';
  }

  private get backupImageModel(): string {
    return readRuntimeEnv('BACKUP_IMAGE_GEN_MODEL')
      || readRuntimeEnv('VITE_BACKUP_IMAGE_GEN_MODEL')
      || 'ernie-image';
  }

  private get primaryImageModel(): string {
    return readRuntimeEnv('IMAGE_GEN_MODEL')
      || readRuntimeEnv('VITE_IMAGE_GEN_MODEL')
      || this.imageGenModel;
  }

  private get spellingModel(): string {
    return readRuntimeEnv('SPELLING_CHECK_MODEL')
      || readRuntimeEnv('VITE_SPELLING_CHECK_MODEL')
      || readRuntimeEnv('OPENAI_MODEL')
      || readRuntimeEnv('VITE_OPENAI_MODEL')
      || 'gpt-4o-mini';
  }

  // Helper for OpenAI API calls
  private async fetchOpenAI(path: string, body: any, apiKey?: string, endpoint?: string) {
    const baseUrl = (endpoint || this.defaultEndpoint).replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey || this.defaultApiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
        const err = await response.json();
        throw new Error(`OpenAI API Error: ${err.error?.message || response.statusText}`);
    }
    return response.json();
  }

  private getImageGenerationUrls(endpoint: string): string[] {
    const sanitized = (endpoint || '').trim().replace(/\/$/, '');
    if (!sanitized) return [];
    if (sanitized.endsWith('/images/generations')) return [sanitized];
    return [
      `${sanitized}/v1/images/generations`,
      `${sanitized}/images/generations`,
    ];
  }

  private async convertImageUrlToDataUrl(imageUrl: string): Promise<string | null> {
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) return null;
      const blob = await response.blob();
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Failed to read generated image blob'));
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  }

  private buildImagePrompt(word: string): string {
    const normalized = word.trim();
    return [
      `Target word or phrase: "${normalized}".`,
      'Create a cartoon-style illustration that is highly intuitive and semantically accurate for this exact target.',
      'Critical requirement: key semantic details must be realistic enough to clearly express the meaning.',
      'If the target is a noun, make that noun the central subject.',
      'If the target is a verb or phrase, design a clear action scene that conveys the meaning.',
      'Do not add artificial overlay subtitles, UI labels, watermark-like text, or unrelated floating captions.',
      'Natural text that belongs to objects in the scene is allowed and should be preserved when semantically necessary, such as blackboard writing, book covers/pages, street signs, or packaging text.',
      'Single scene, clean composition, vivid colors, high clarity, educational illustration quality.'
    ].join(' ');
  }

  private async tryGenerateImageByEndpoint(options: {
    endpoint: string;
    apiKey: string;
    prompt: string;
    model: string;
  }): Promise<string | null> {
    const urls = this.getImageGenerationUrls(options.endpoint);
    if (urls.length === 0 || !options.apiKey) return null;

    for (const url of urls) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: options.model,
            prompt: options.prompt,
            n: 1,
            size: '1024x1024',
            response_format: 'b64_json',
          }),
        });

        if (!response.ok) {
          continue;
        }

        const data = await response.json();
        const b64 = data?.data?.[0]?.b64_json;
        if (typeof b64 === 'string' && b64.length > 0) {
          return `data:image/png;base64,${b64}`;
        }

        const imageUrl = data?.data?.[0]?.url;
        if (typeof imageUrl === 'string' && imageUrl.length > 0) {
          const dataUrl = await this.convertImageUrlToDataUrl(imageUrl);
          if (dataUrl) return dataUrl;
        }
      } catch {
      }
    }

    return null;
  }

  async optimizeWordSelection(
    words: WordEntry[],
    sessions: InputSession[],
    targetCount: number,
    apiKey?: string,
    endpoint?: string
  ): Promise<string[] | null> {
    try {
      const baseUrl = (endpoint || this.defaultEndpoint).replace(/\/$/, "");

      // Prepare a minimal dataset to save tokens, but keeping essential stats
      const wordStats = words.map(w => ({
        id: w.id,
        text: w.text,
        error_count: w.error_count,
        last_tested: w.last_tested ? new Date(w.last_tested).toISOString() : 'Never',
        best_time: w.best_time_ms,
        tags: w.tags,
        score: w.score
      }));

      const sessionSummary = sessions.slice(0, 5).map(s => ({ // Last 5 sessions
        date: new Date(s.timestamp).toISOString(),
        score: s.targetCount > 0 ? (s.wordCount / s.targetCount) : 0
      }));

      const prompt = `
        You are an adaptive learning algorithm specializing in vocabulary optimization.

        === OBJECTIVE ===
        Select exactly ${targetCount} words for the next test session based on error patterns and forgetting curves.

        === ERROR COUNT INTERPRETATION ===
        The error_count field uses fine-grained tracking to indicate difficulty:
        - 0.0: Perfect (no errors ever) - LOW PRIORITY
        - 0.3: Used hint, 0 mistakes (slight difficulty) - MEDIUM-LOW PRIORITY
        - 0.5: Used hint, 1 mistake (moderate difficulty) - MEDIUM PRIORITY
        - 0.8: Used hint, 2 mistakes (significant difficulty) - MEDIUM-HIGH PRIORITY
        - 1.0+: Multiple errors or completely failed (critical difficulty) - HIGH PRIORITY

        === SELECTION STRATEGY ===
        1. Priority Scale (error_count × urgency_weight):
           - error_count ≥ 3.0: CRITICAL (40% weight)
           - error_count 1.0-2.9: HIGH (30% weight)
           - error_count 0.3-0.9: MEDIUM (20% weight)
           - error_count 0.0-0.2: LOW (10% weight)

        2. Apply Forgetting Curve:
           - Words not tested in ≥7 days: +20% priority
           - Words not tested in 3-6 days: +10% priority
           - Recently tested words (≤2 days): Base priority only

        3. Ensure Diversity:
           - At least 30% from high-priority words (error_count ≥ 1.0)
           - At most 20% from low-priority words (error_count < 0.3)
           - Avoid testing the same word twice in one session

        === WORD CANDIDATES ===
        ${JSON.stringify(wordStats)}

        === RECENT SESSIONS ===
        ${JSON.stringify(sessionSummary)}

        === OUTPUT FORMAT ===
        Return STRICTLY a JSON array of word IDs (no other text):
        ["id1", "id2", "id3", ...]
      `;

      // Create a timeout promise (15s to handle slow connections)
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out")), 15000)
      );

      // Determine model to use (support custom models from settings)
      // Use a reasonable default for chat/completion models
      const model = "gpt-4o-mini"; // Fast and cost-effective for selection tasks

      // Race against API call
      const result: any = await Promise.race([
        fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey || this.defaultApiKey}`,
          },
          body: JSON.stringify({
            model: model,
            messages: [
              {
                role: "system",
                content: "You are an adaptive learning algorithm. Always respond with valid JSON arrays."
              },
              {
                role: "user",
                content: prompt
              }
            ],
            response_format: { type: "json_object" },
            temperature: 0.7, // Balance between consistency and randomness
            max_tokens: 200
          }),
        }),
        timeoutPromise
      ]);

      if (!result.ok) {
        const err = await result.json();
        throw new Error(`OpenAI API Error: ${err.error?.message || result.statusText}`);
      }

      const data = await result.json();

      // Parse the response
      // OpenAI returns: { choices: [{ message: { content: "..." } }] }
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        console.error("OpenAI optimization: No content in response");
        return null;
      }

      // Parse JSON response
      // Should be an object with selected IDs
      const parsed = JSON.parse(content);

      // Support both formats: { ids: [...] } and direct array [...]
      const selectedIds = parsed.ids || parsed;

      if (Array.isArray(selectedIds)) {
        return selectedIds;
      }

      console.warn("OpenAI optimization: Unexpected response format", parsed);
      return null;
    } catch (error) {
      console.error("OpenAI optimization failed:", error);
      return null;
    }
  }


  async generateImageHint(word: string, promptOverride?: string, apiKey?: string, endpoint?: string): Promise<string | null> {
    const prompt = promptOverride || this.buildImagePrompt(word);

    const primaryEndpoint = endpoint || this.primaryImageEndpoint;
    const primaryKey = apiKey || this.primaryImageApiKey;
    const model = this.primaryImageModel;

    const primaryResult = await this.tryGenerateImageByEndpoint({
      endpoint: primaryEndpoint,
      apiKey: primaryKey,
      prompt,
      model,
    });
    if (primaryResult) return primaryResult;

    const backupResult = await this.tryGenerateImageByEndpoint({
      endpoint: this.backupImageEndpoint,
      apiKey: this.backupImageApiKey,
      prompt,
      model: this.backupImageModel,
    });
    if (backupResult) return backupResult;

    console.error('OpenAI-compatible image generation failed on both primary and backup providers.');
    return null;
  }

  async generateSpeech(text: string, apiKey?: string, endpoint?: string): Promise<AudioBuffer | string | null> {
    try {
      const baseUrl = (endpoint || this.defaultEndpoint).replace(/\/$/, "");
      const response = await fetch(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey || this.defaultApiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "tts-1",
            input: text,
            voice: "alloy"
        })
      });

      if (!response.ok) throw new Error("OpenAI TTS Failed");

      const arrayBuffer = await response.arrayBuffer();
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      return await audioCtx.decodeAudioData(arrayBuffer);
    } catch (error) {
      console.warn("OpenAI TTS failed, falling back to native:", error);
      return text;
    }
  }

  async extractWordFromImage(base64Image: string, apiKey?: string, endpoint?: string): Promise<string | null> {
    try {
      const data = await this.fetchOpenAI("chat/completions", {
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Extract the single main word written in this image. Output ONLY the word, nothing else. If there are multiple words, choose the most prominent noun." },
              { type: "image_url", image_url: { url: base64Image } }
            ]
          }
        ],
        max_tokens: 10
      }, apiKey, endpoint);
      return data.choices[0].message.content.trim();
    } catch (error) {
      console.error("OpenAI vision OCR failed:", error);
      return null;
    }
  }

  async validateSpelling(word: string, apiKey?: string, endpoint?: string): Promise<SpellingResult> {
    try {
      const data = await this.fetchOpenAI("chat/completions", {
        model: this.spellingModel,
        messages: [
          {
            role: "system",
            content: "You are a spelling checker. Respond with JSON: { \"isValid\": boolean, \"suggestion\": string | null }"
          },
          {
            role: "user",
            content: `Check spelling of: "${word}"`
          }
        ],
        response_format: { type: "json_object" }
      }, apiKey, endpoint);

      const result = JSON.parse(data.choices[0].message.content);
      return {
        isValid: result.isValid,
        suggestion: result.suggestion || undefined
      };
    } catch (error) {
      console.error("OpenAI spelling check failed:", error);
      return { isValid: false, serviceError: true };
    }
  }

  async validateCollocation(phrase: string, apiKey?: string, endpoint?: string): Promise<{ isCommon: boolean }> {
    try {
      const data = await this.fetchOpenAI("chat/completions", {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are an English language expert. Check if word collocations are common and natural. Respond with JSON: { \"isCommon\": boolean }"
          },
          {
            role: "user",
            content: `Is "${phrase}" a common and natural English word collocation/phrase?

Consider:
- Is this a frequently used phrase in English?
- Do these words naturally go together?
- Examples of common collocations: "go cycling", "take part in", "look forward to"
- Examples of uncommon combinations: "come cycling", "eat cycling", "do cycling"

Return true if this is a common, natural phrase. Return false if the words are spelled correctly but don't form a common phrase.`
          }
        ],
        response_format: { type: "json_object" }
      }, apiKey, endpoint);

      const result = JSON.parse(data.choices[0].message.content);
      return { isCommon: result.isCommon ?? true };
    } catch (error) {
      console.error("OpenAI collocation check failed:", error);
      // On error, conservatively assume phrase is valid
      return { isCommon: true };
    }
  }
}
