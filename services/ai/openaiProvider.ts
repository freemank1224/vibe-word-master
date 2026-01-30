
import { AIService, SpellingResult } from "./types";
import { WordEntry, InputSession } from "../../types";

export class OpenAIProvider implements AIService {
  private get defaultApiKey(): string {
    return process.env.OPENAI_API_KEY || "";
  }

  private get defaultEndpoint(): string {
    return process.env.OPENAI_ENDPOINT || "https://api.openai.com/v1";
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

  async optimizeWordSelection(
    words: WordEntry[], 
    sessions: InputSession[], 
    targetCount: number, 
    apiKey?: string, 
    endpoint?: string
  ): Promise<string[] | null> {
    return null; // Not implemented yet
  }


  async generateImageHint(word: string, promptOverride?: string, apiKey?: string, endpoint?: string): Promise<string | null> {
    try {
      const prompt = promptOverride || `A clear, artistic, and descriptive illustration representing the English word: "${word}". Style: high-quality 3D digital art, clean background. No words or characters in the generated image.`;

      const data = await this.fetchOpenAI("images/generations", {
        model: "dall-e-3",
        prompt: prompt,
        n: 1,
        size: "1024x1024",
        response_format: "b64_json"
      }, apiKey, endpoint);
      return `data:image/png;base64,${data.data[0].b64_json}`;
    } catch (error) {
      console.error("OpenAI image generation failed:", error);
      return null;
    }
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
        model: "gpt-4o-mini",
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
}
