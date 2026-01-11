
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { AIService, SpellingResult } from "./types";

export class GeminiProvider implements AIService {
  private get defaultApiKey(): string {
    return process.env.GEMINI_API_KEY || process.env.API_KEY || "";
  }

  private getClient(apiKey?: string, endpoint?: string) {
    const options: any = { apiKey: apiKey || this.defaultApiKey };
    if (endpoint) {
      // Remove trailing slash if present
      options.baseUrl = endpoint.replace(/\/$/, "");
    }
    return new GoogleGenAI(options);
  }

  async generateImageHint(word: string, apiKey?: string, endpoint?: string): Promise<string | null> {
    try {
      const ai = this.getClient(apiKey, endpoint);
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [{ text: `A clear, artistic, and descriptive illustration representing the English word: "${word}". Style: high-quality 3D digital art, clean background. No words or characters in the generated image.` }]
        },
        config: {
          imageConfig: { aspectRatio: "16:9" }
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
      return { isValid: true };
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
}
