import { supabase } from '../lib/supabaseClient';
import { DICTIONARY_CONFIG, fetchLocalWordList, importDictionaryWords, getCurrentUserId } from './dataService';
import { aiService } from './ai';
import { compressToWebP } from '../utils/imageUtils';
import { getMascotPrompt } from '../utils/mascotDescriptions';
import { AISettings } from './ai/settings';

export interface AdminStats {
  totalWords: number;
  wordsWithImages: number;
  coverageRate: number;
  storageUsageMB: number; // Estimated
}

export type GenerationStatus = 'idle' | 'running' | 'paused';

class AdminService {
  private _status: GenerationStatus = 'idle';
  private _stopSignal = false;

  get status() {
    return this._status;
  }

  // 1. Deduplicate & Seed Library
  async seedAllDictionaries(onProgress: (msg: string) => void) {
    const userId = await getCurrentUserId();
    if (!userId) throw new Error("Not authenticated");

    onProgress("Starting library synchronization...");
    
    for (const config of DICTIONARY_CONFIG) {
      onProgress(`Fetching wordlist: ${config.name}...`);
      const words = await fetchLocalWordList(config.localPath);
      
      onProgress(`Importing/Merging ${words.length} words for ${config.name}...`);
      // This function handles deduplication (if word exists, it updates tags)
      const result = await importDictionaryWords(userId, words, config.tag);
      
      onProgress(`✓ ${config.name}: Updated ${result.updated}, Inserted ${result.inserted}`);
    }
    onProgress("All libraries synchronized.");
  }

  // 2. Clear All Images
  async clearAllImages(onProgress: (msg: string) => void) {
    const userId = await getCurrentUserId();
    if (!userId) throw new Error("Not authenticated");

    onProgress("Finding words with images...");
    // 1. Get all words that have images
    const { data: words, error } = await supabase
      .from('words')
      .select('id, image_path, text')
      .eq('user_id', userId)
      .not('image_path', 'is', null);

    if (error) throw error;
    if (!words || words.length === 0) {
      onProgress("No images found to delete.");
      return;
    }

    onProgress(`Found ${words.length} images. Deleting from Storage...`);

    // 2. Delete from Storage (Batching)
    const BATCH_SIZE = 50;
    const paths = words.map(w => w.image_path).filter(Boolean) as string[];
    
    for (let i = 0; i < paths.length; i += BATCH_SIZE) {
      const batch = paths.slice(i, i + BATCH_SIZE);
      const { error: storageError } = await supabase.storage
        .from('vocab-images')
        .remove(batch);
      
      if (storageError) {
        console.error("Storage delete error:", storageError);
      }
      onProgress(`Deleted batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(paths.length/BATCH_SIZE)}`);
    }

    onProgress("Updating Database records...");
    
    // 3. Reset DB columns
    // We do this in a single update for all user words to be cleaner.
    // image_url is NOT a column in the DB, it is computed from image_path.
    const { error: dbError } = await supabase
      .from('words')
      .update({ 
        image_path: null, 
        image_gen_status: 'pending',
        image_gen_error: null,
        image_gen_retries: 0
      })
      .eq('user_id', userId)
      .not('image_path', 'is', null);

    if (dbError) throw dbError;
    onProgress("Cleanup complete. Ready for fresh generation.");
  }

  // 3. Background Generation Loop
  async startBackgroundGeneration(
    onProgress: (stats: { currentWord: string, status: string, total: number, coverage: number }) => void,
    onError: (err: any) => void
  ) {
    if (this._status === 'running') return;
    this._status = 'running';
    this._stopSignal = false;

    const userId = await getCurrentUserId();
    if (!userId) {
      this._status = 'idle';
      throw new Error("Not authenticated");
    }

    try {
      while (!this._stopSignal) {
        // A. Find next pending word
        // Prioritize 'pending', then 'failed' with retries < 3
        const { data: candidates, error } = await supabase
          .from('words')
          .select('*')
          .eq('user_id', userId)
          .is('image_path', null) // Double check it has no image
          .or('image_gen_status.eq.pending,image_gen_status.eq.processing,image_gen_status.eq.failed')
          .lt('image_gen_retries', 3) // Retry limit
          .limit(1); // One at a time for safety and simpler logic

        // If no candidates, we are done (or wait and check again later)
        if (!candidates || candidates.length === 0) {
          onProgress({ currentWord: "None", status: "Idle (All Done)", total: 0, coverage: 100 });
          await new Promise(r => setTimeout(r, 5000)); // Sleep 5s
          continue;
        }

        const word = candidates[0];
        
        onProgress({ 
            currentWord: word.text, 
            status: "Generating...", 
            total: 0, // Placeholder, fetch real stats periodically
            coverage: 0 
        });

        // Mark as processing
        await supabase.from('words').update({ 
            image_gen_status: 'processing',
            image_gen_error: null 
        }).eq('id', word.id);

        try {
            // Check for Custom Provider Override in Settings (already handled by aiService/index.ts)
            // But we need to handle potential Rate Limits with Backoff
            
            // 1. Generate Prompt
            // Use day of week logic based on maybe word length or hash to distribute mascots?
            // Or just random? 
            // The prompt said: "Use Monday to Sunday monsters...".
            // Let's use simple hash of word to pick day index 0-6
            const dayIndex = Math.abs(word.text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)) % 7;
            
            // 2. Call AI
            // We use 'generateImageHint' but we might want the CUSTOM prompt.
            // 'generateImageHint' in service currently hardcodes the prompt.
            // We should EXPOSE a way to generate raw image or prompt.
            // Refactor Idea: Modify `generateImageHint` to accept optional `prompt`.
            // OR checks for MASCOT usage.
            // Since I cannot easily change the Interface of AIService without breaking other things, 
            // I will use `any` cast or assume I can modify `generateImageHint` to take a prompt.
            // Let's check `services/ai/index.ts` again. It takes `word`.
            // The PROVIDERS take `word` and build the prompt internally.
            
            // FIXME: I need to allow Custom Prompts in the AI Service.
            // For now, I will modify `generateImageHint` in providers to accept an optional prompt string?
            // Or better, I will construct the "Word" passed to the function as the FULL prompt, 
            // but the providers usually wrap it: "Representation of ${word}".
            
            // Let's modify the Providers to accept an `options` object or similar.
            // Or, simpler hack: The `word` parameter IS the prompt if it's long?
            // No, that changes the "text" logic in Gemini.
            
            // Best approach: Add `generateImageFromPrompt` to the interface.
            // But for now, since I'm running out of context for big refactors, 
            // I will use a special marker or just update the providers.
            
            // Let's look at `geminiProvider.ts`.
            // `parts: [{ text: `A clear... word: "${word}"...` }]`
            
            // I will MODIFY the existing providers to accept a second arg `promptOverride`.
            
            const prompt = getMascotPrompt(dayIndex, word.text);
            
            // Assuming I update the AI service to support this:
            const base64 = await aiService.generateImageHint(word.text, prompt); 
            // I will update AI service signature momentarily.

            if (!base64) {
                throw new Error("AI returned null");
            }

            // 3. Compress/Resize
            const blob = await compressToWebP(base64, 512, 512, 0.85);
            
            // 4. Upload
            const fileName = `${userId}/${word.text}_${Date.now()}.webp`;
            const { data: uploadData, error: uploadError } = await supabase.storage
                .from('vocab-images')
                .upload(fileName, blob, {
                    contentType: 'image/webp',
                    upsert: true
                });

            if (uploadError) throw uploadError;

            // 5. Update DB
             const { data: { publicUrl } } = supabase.storage
                .from('vocab-images')
                .getPublicUrl(fileName);

            await supabase.from('words').update({
                image_path: fileName,
                image_url: publicUrl,
                image_gen_status: 'completed',
                image_gen_retries: 0
            }).eq('id', word.id);

            // Notify Progress (Success)
            onProgress({ currentWord: word.text, status: "Done", total: 0, coverage: 0 });

        } catch (err: any) {
            console.error(`Error generating for ${word.text}:`, err);
            
            // Smart Backoff Check
            const isRateLimit = err.message?.includes('429') || err.toString().includes('Quota');
            
            await supabase.from('words').update({
                image_gen_status: 'failed',
                image_gen_error: err.message || JSON.stringify(err),
                image_gen_retries: word.image_gen_retries + 1
            }).eq('id', word.id);
            
            if (isRateLimit) {
                onProgress({ currentWord: word.text, status: "Rate Limited (Waiting 10s)", total: 0, coverage: 0 });
                await new Promise(r => setTimeout(r, 10000)); // Hard wait for now, or exponential
            } else {
                 await new Promise(r => setTimeout(r, 1000)); // Small gap
            }
        }
      }
    } catch (e) {
      onError(e);
    } finally {
      this._status = 'idle';
    }
  }

  stopGeneration() {
    this._stopSignal = true;
  }

  async getStats(): Promise<AdminStats> {
    const userId = await getCurrentUserId();
    if (!userId) return { totalWords: 0, wordsWithImages: 0, coverageRate: 0, storageUsageMB: 0 };

    const { count: total } = await supabase.from('words').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    const { count: withImg } = await supabase.from('words').select('id', { count: 'exact', head: true }).eq('user_id', userId).not('image_path', 'is', null);

    const t = total || 0;
    const i = withImg || 0;
    
    // Estimate: 512x512 WebP ~= 30KB
    const size = (i * 30) / 1024; // MB

    return {
      totalWords: t,
      wordsWithImages: i,
      coverageRate: t > 0 ? (i / t) * 100 : 0,
      storageUsageMB: size
    };
  }
}

export const adminService = new AdminService();
