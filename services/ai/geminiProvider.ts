
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { AIService, SpellingResult } from "./types";
import { WordEntry, InputSession } from "../../types";

export class GeminiProvider implements AIService {
  private get defaultApiKey(): string {
    return process.env.GEMINI_API_KEY || process.env.API_KEY || "";
  }

  private getClient(apiKey?: string, endpoint?: string) {
    const key = apiKey || this.defaultApiKey;
    
    const config: any = {
      apiKey: key
    };

    if (endpoint && !endpoint.includes('generativelanguage.googleapis.com')) {
      config.baseURL = endpoint.replace(/\/$/, "");
    }

    return new GoogleGenAI(config);
  }

  async generateImageHint(word: string, promptOverride?: string, apiKey?: string, endpoint?: string): Promise<string | null> {
    try {
      const ai = this.getClient(apiKey, endpoint);
      const prompt = promptOverride || `A clear, artistic, and descriptive illustration representing the English word: "${word}". Style: high-quality digital art, clean background. No words or characters in the generated image.`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [{ text: prompt }]
        },
        config: {
          imageConfig: { aspectRatio: "1:1" }
        }
      });

      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          return `data:image/png;base64,${part.inlineData.data}`;
        }
      }
    } catch (error) {
      console.error("Gemini image generation failed:", error);
    }
    return null;
  }

  async generateSpeech(text: string, apiKey?: string, endpoint?: string): Promise<AudioBuffer | string | null> {
    try {
      const ai = this.getClient(apiKey, endpoint);
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: `Say clearly: ${text}` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        return await this.decodeAudioData(this.decodeBase64(base64Audio), audioCtx, 24000, 1);
      }
    } catch (error: any) {
      console.warn("Gemini TTS failed, falling back to browser SpeechSynthesis:", error?.message || error);
      return text;
    }
    return null;
  }

  async extractWordFromImage(base64Image: string, apiKey?: string, endpoint?: string): Promise<string | null> {
    try {
      const ai = this.getClient(apiKey, endpoint);
      const mimeType = base64Image.match(/data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+).*,.*/)?.[1] || 'image/jpeg';
      const base64Data = base64Image.split(',')[1];

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: {
          parts: [
            { inlineData: { data: base64Data, mimeType: mimeType } },
            { text: "Extract the single main word written in this image. Output ONLY the word, nothing else. If there are multiple words, choose the most prominent noun." }
          ]
        }
      });
      return response.text?.trim() || null;
    } catch (error) {
      console.error("Gemini OCR failed:", error);
      return null;
    }
  }

  async validateSpelling(word: string, apiKey?: string, endpoint?: string): Promise<SpellingResult> {
    try {
      const ai = this.getClient(apiKey, endpoint);
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Check if "${word}" is a correctly spelled English word.
                   If it is a valid word (including proper nouns commonly used), return isValid: true.
                   If it is misspelled, return isValid: false and provide the correct spelling in 'suggestion'.
                   If the word is not recognized at all but looks like a word, try to guess the closest match.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              isValid: { type: Type.BOOLEAN },
              suggestion: { type: Type.STRING, nullable: true }
            }
          }
        }
      });

      const result = JSON.parse(response.text || "{}");
      return {
        isValid: result.isValid,
        suggestion: result.suggestion || undefined
      };
    } catch (error) {
      console.error("Gemini spelling check failed:", error);
      // Return serviceError so the UI can prompt for manual override
      return { isValid: false, serviceError: true };
    }
  }

  private decodeBase64(base64: string) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  private async decodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> {
    const dataInt16 = new Int16Array(data.buffer);
    const frameCount = dataInt16.length / numChannels;
    const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
    for (let channel = 0; channel < numChannels; channel++) {
      const channelData = buffer.getChannelData(channel);
      for (let i = 0; i < frameCount; i++) {
        channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
      }
    }
    return buffer;
  }

  async optimizeWordSelection(
    words: WordEntry[], 
    sessions: InputSession[], 
    targetCount: number, 
    apiKey?: string, 
    endpoint?: string
  ): Promise<string[] | null> {
    try {
      const ai = this.getClient(apiKey, endpoint);
      
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
        As an expert language tutor, select exactly ${targetCount} words for the next vocabulary test.
        
        Prioritize:
        1. Words with high error counts.
        2. Words never tested or not tested recently (spaced repetition).
        3. Words that are "stale" (tested long ago).
        
        Data:
        Words: ${JSON.stringify(wordStats)}
        Recent Sessions: ${JSON.stringify(sessionSummary)}
        
        Return STRICTLY a JSON array of strings containing ONLY the IDs of the selected words.
        Example: ["id1", "id2", "id3"]
      `;

      // Create a timeout promise (15s to handle slow connections)
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Request timed out")), 15000)
      );

      // Race against the API call
      const result: any = await Promise.race([
        ai.models.generateContent({
          model: 'gemini-2.5-flash', // Use latest flash model for speed and reliability
          contents: { parts: [{ text: prompt }] },
          config: {
            responseMimeType: "application/json"
          }
        }),
        timeoutPromise
      ]);

      const response = result as any;
      const text = response.text();
      if (!text) return null;
      
      const selectedIds = JSON.parse(text);
      if (Array.isArray(selectedIds)) {
        return selectedIds;
      }
    } catch (error) {
      console.error("Gemini optimization failed:", error);
    }
    return null; // Fallback to random/algorithm
  }
}
