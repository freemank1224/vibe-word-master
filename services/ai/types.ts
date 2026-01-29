
export interface SpellingResult {
  isValid: boolean;
  suggestion?: string;
  found?: boolean; // Used by local provider
  serviceError?: boolean; // Indicates service was unreachable
}

export interface AIService {
  /**
   * Generates an image hint for a word. 
   * Returns a base64 data URL or null.
   */
  generateImageHint(word: string, promptOverride?: string, apiKey?: string, endpoint?: string): Promise<string | null>;

  /**
   * Generates speech for text.
   * Returns an AudioBuffer for playback or the original text string for native fallback.
   */
  generateSpeech(text: string, apiKey?: string, endpoint?: string): Promise<AudioBuffer | string | null>;

  /**
   * Extracts the main word from an image (OCR).
   */
  extractWordFromImage(base64Image: string, apiKey?: string, endpoint?: string): Promise<string | null>;

  /**
   * Validates spelling and provides a suggestion if needed.
   */
  validateSpelling(word: string, apiKey?: string, endpoint?: string, options?: { skipLLM?: boolean }): Promise<SpellingResult>;

  /**
   * Future STT interface (reserved but not activated as per request).
   */
  transcribeAudio?(audioBlob: Blob, apiKey?: string, endpoint?: string): Promise<string | null>;
}

export type AIProviderType = 'gemini' | 'openai';
