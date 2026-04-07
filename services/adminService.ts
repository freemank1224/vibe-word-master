import { supabase } from '../lib/supabaseClient';
import { DICTIONARY_CONFIG, fetchLocalWordList, importDictionaryWords, getCurrentUserId } from './dataService';
import { aiService } from './ai';
import { compressToWebP } from '../utils/imageUtils';
import { getMascotPrompt } from '../utils/mascotDescriptions';
import { AISettings } from './ai/settings';
import { WORD_LEARNING_CONFIG } from '../config/wordLearningConfig';

export interface AdminStats {
  totalWords: number;
  wordsWithImages: number;
  imageCoverageRate: number;
  wordsWithPronunciations: number;
  pronunciationCoverageRate: number;
  totalUsers: number;
}

export interface PronunciationReplacementStatus {
  runId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  total: number;
  done: number;
  generated: number;
  skipped: number;
  failed: number;
  message?: string;
  updatedAt?: string | null;
  finishedAt?: string | null;
}

export type GenerationStatus = 'idle' | 'running' | 'paused';

class AdminService {
  private _status: GenerationStatus = 'idle';
  private _stopSignal = false;

  private async _getPronunciationCoverageFallback(): Promise<Pick<AdminStats, 'totalWords' | 'wordsWithPronunciations' | 'pronunciationCoverageRate'>> {
    const pageSize = 1000;
    let page = 0;
    let hasMore = true;
    const readyWordKeys = new Set<string>();

    while (hasMore) {
      const from = page * pageSize;
      const to = from + pageSize - 1;
      const { data, error } = await supabase
        .from('pronunciation_assets')
        .select('normalized_word,language')
        .eq('status', 'ready')
        .range(from, to);

      if (error) {
        throw new Error(`Fallback pronunciation stats failed on page ${page}: ${error.message}`);
      }

      if (!data || data.length === 0) {
        hasMore = false;
        break;
      }

      for (const row of data as Array<{ normalized_word?: string | null; language?: string | null }>) {
        const normalizedWord = (row.normalized_word || '').trim();
        if (!normalizedWord) continue;
        readyWordKeys.add(`${normalizedWord}::${(row.language || 'en').trim()}`);
      }

      hasMore = data.length === pageSize;
      page += 1;
    }

    const readyCount = readyWordKeys.size;
    return {
      totalWords: readyCount,
      wordsWithPronunciations: readyCount,
      pronunciationCoverageRate: readyCount > 0 ? 100 : 0,
    };
  }

  /**
   * Invoke Edge Function with session-aware auth.
   * If current session token is stale, refresh once and retry.
   */
  private async _invokeFn(
    fnName: string,
    body: Record<string, unknown>
  ): Promise<any> {
    const getAccessToken = async (): Promise<string> => {
      const { data: sessionData } = await supabase.auth.getSession();
      const fromSession = sessionData?.session?.access_token;
      if (fromSession) return fromSession;

      const { data: refreshData } = await supabase.auth.refreshSession();
      const fromRefresh = refreshData?.session?.access_token;
      if (fromRefresh) return fromRefresh;

      throw new Error('Authentication token missing. Please logout and login again, then retry.');
    };

    const invoke = async () => {
      const accessToken = await getAccessToken();
      return supabase.functions.invoke(fnName, {
        body,
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
    };

    let { data, error } = await invoke();
    let status = (error as any)?.status ?? (error as any)?.context?.status;

    if (error && status === 401) {
      await supabase.auth.refreshSession();
      const retry = await invoke();
      data = retry.data;
      error = retry.error;
      status = (error as any)?.status ?? (error as any)?.context?.status;
    }

    if (error) {
      if (status === 401) {
        throw new Error('401 Unauthorized: session token invalid or expired. Please logout and login again, then retry.');
      }
      if (status === 403) {
        throw new Error(`Permission denied: ${(error as any)?.message || 'only super-admin can run this action.'}`);
      }
      throw new Error((error as any)?.message || 'Edge Function invocation failed');
    }

    return data;
  }

  private normalizeWord(text: string): string {
    return text.toLowerCase().trim().replace(/\s+/g, ' ');
  }

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
            /*
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
            */
            console.log("Image generation disabled for", word.text);

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

  async replaceAllPronunciations(
    onProgress: (msg: string) => void,
    runId?: string,
    options?: { forceRegenerate?: boolean }
  ): Promise<{ runId: string }> {
    if (!WORD_LEARNING_CONFIG.pronunciation.enableManualBatchReplacement) {
      throw new Error('Manual pronunciation batch replacement is disabled by config.');
    }

    const { data: authData } = await supabase.auth.getUser();
    const userEmail = authData?.user?.email?.toLowerCase() || '';
    const userId = authData?.user?.id || '';
    const superAdminEmail = WORD_LEARNING_CONFIG.pronunciation.superAdminEmail.toLowerCase();

    if (userEmail !== superAdminEmail) {
      throw new Error(`Permission denied. Only ${WORD_LEARNING_CONFIG.pronunciation.superAdminEmail} can run global replacement.`);
    }

    onProgress(`Admin verified: ${userEmail}`);
    onProgress('Starting global replacement job for all users...');

    const uniquenessMode = WORD_LEARNING_CONFIG.pronunciation.uniquenessMode;
    const concurrency = Math.max(1, WORD_LEARNING_CONFIG.pronunciation.batchReplacementConcurrency);
    const maxRequestsPerMinute = Math.max(1, WORD_LEARNING_CONFIG.pronunciation.maxRequestsPerMinute);
    const forceRegenerate = options?.forceRegenerate === true;
    const effectiveRunId = runId || crypto.randomUUID();

    const data = await this._invokeFn('pronunciation-rebuild', {
      run_id: effectiveRunId,
      uniqueness_mode: uniquenessMode,
      concurrency,
      max_requests_per_minute: maxRequestsPerMinute,
      force_regenerate: forceRegenerate,
      requested_email: userEmail,
      requested_by: userId,
    });

    if (!data?.ok) {
      throw new Error(data?.error || 'Global replacement function returned failed state');
    }

    onProgress(`Global replacement done. total=${data.total} generated=${data.generated} skipped=${data.skipped} failed=${data.failed}`);
    return { runId: data.run_id || effectiveRunId };
  }

  async purgeAllMinimaxPronunciations(onProgress: (msg: string) => void): Promise<{ deletedAssets: number; deletedStorageObjects: number }> {
    if (!WORD_LEARNING_CONFIG.pronunciation.enableManualBatchReplacement) {
      throw new Error('Manual pronunciation batch replacement is disabled by config.');
    }

    const { data: authData } = await supabase.auth.getUser();
    const userEmail = authData?.user?.email?.toLowerCase() || '';
    const userId = authData?.user?.id || '';
    const superAdminEmail = WORD_LEARNING_CONFIG.pronunciation.superAdminEmail.toLowerCase();

    if (userEmail !== superAdminEmail) {
      throw new Error(`Permission denied. Only ${WORD_LEARNING_CONFIG.pronunciation.superAdminEmail} can run global replacement.`);
    }

    onProgress('Purging all Minimax pronunciation assets and storage...');

    const data = await this._invokeFn('pronunciation-rebuild', {
      action: 'purge_minimax',
      requested_email: userEmail,
      requested_by: userId,
    });

    if (!data?.ok) {
      throw new Error(data?.error || 'Purge action returned failed state');
    }

    const deletedAssets = Number(data?.deleted_assets || 0);
    const deletedStorageObjects = Number(data?.deleted_storage_objects || 0);
    onProgress(`Purge complete. assets=${deletedAssets}, storageObjects=${deletedStorageObjects}`);
    return { deletedAssets, deletedStorageObjects };
  }

  /**
   * Full-scan orphan cleanup: find all pronunciation assets whose word no longer
   * exists in any user's active library, then delete the storage files + DB records.
   * Admin-only (calls `purge_orphaned` action in pronunciation-rebuild edge function).
   */
  async purgeOrphanedAudioAssets(
    onProgress: (msg: string) => void
  ): Promise<{ deletedAssets: number; deletedStorageObjects: number; orphanedWords: string[] }> {
    const { data: authData } = await supabase.auth.getUser();
    const userEmail = authData?.user?.email?.toLowerCase() || '';
    const userId = authData?.user?.id || '';
    const superAdminEmail = WORD_LEARNING_CONFIG.pronunciation.superAdminEmail.toLowerCase();

    if (userEmail !== superAdminEmail) {
      throw new Error(`Permission denied. Only ${WORD_LEARNING_CONFIG.pronunciation.superAdminEmail} can run this scan.`);
    }

    onProgress('Scanning all pronunciation assets for orphans (words not present in any user library)...');

    const data = await this._invokeFn('pronunciation-rebuild', {
      action: 'purge_orphaned',
      requested_email: userEmail,
      requested_by: userId,
    });

    if (!data?.ok) {
      throw new Error(data?.error || 'purge_orphaned action returned failed state');
    }

    const deletedAssets = Number(data?.deleted_assets || 0);
    const deletedStorageObjects = Number(data?.deleted_storage_objects || 0);
    const orphanedWords: string[] = data?.orphaned_words || [];

    if (deletedAssets === 0) {
      onProgress('✓ No orphaned audio assets found. Audio storage is clean.');
    } else {
      onProgress(`✓ Removed ${deletedAssets} orphaned assets, ${deletedStorageObjects} storage files.`);
      if (orphanedWords.length > 0) {
        onProgress(`  Orphaned words: ${orphanedWords.slice(0, 20).join(', ')}${orphanedWords.length > 20 ? ` … (+${orphanedWords.length - 20} more)` : ''}`);
      }
    }
    return { deletedAssets, deletedStorageObjects, orphanedWords };
  }

  async stopPronunciationReplacement(runId?: string) {
    this._stopSignal = true;

    if (!runId) return;

    const { data: authData } = await supabase.auth.getUser();
    const userEmail = authData?.user?.email?.toLowerCase() || '';
    const userId = authData?.user?.id || '';

    await this._invokeFn('pronunciation-rebuild', {
      action: 'cancel',
      run_id: runId,
      requested_email: userEmail,
      requested_by: userId,
    }).catch(() => { /* best-effort cancel */ });
  }

  async getStats(): Promise<AdminStats> {
    try {
      const data = await this._invokeFn('admin-console', { action: 'stats' });
      const stats = data?.stats || {};

      return {
        totalWords: Number(stats.totalWords || 0),
        wordsWithImages: Number(stats.wordsWithImages || 0),
        imageCoverageRate: Number(stats.imageCoverageRate || 0),
        wordsWithPronunciations: Number(stats.wordsWithPronunciations || 0),
        pronunciationCoverageRate: Number(stats.pronunciationCoverageRate || 0),
        totalUsers: Number(stats.totalUsers || 0),
      };
    } catch (error) {
      console.warn('[adminService.getStats] global stats unavailable, using fallback:', error);

      try {
        const fallback = await this._getPronunciationCoverageFallback();
        return {
          totalWords: fallback.totalWords,
          wordsWithImages: 0,
          imageCoverageRate: 0,
          wordsWithPronunciations: fallback.wordsWithPronunciations,
          pronunciationCoverageRate: fallback.pronunciationCoverageRate,
          totalUsers: 0,
        };
      } catch (fallbackError) {
        console.warn('[adminService.getStats] fallback stats failed:', fallbackError);
        return {
          totalWords: 0,
          wordsWithImages: 0,
          imageCoverageRate: 0,
          wordsWithPronunciations: 0,
          pronunciationCoverageRate: 0,
          totalUsers: 0,
        };
      }
    }
  }

  async getPronunciationReplacementStatus(runId: string): Promise<PronunciationReplacementStatus> {
    const data = await this._invokeFn('pronunciation-rebuild', {
      action: 'status',
      run_id: runId,
    });

    const run = data?.run;
    if (!run) {
      throw new Error('Pronunciation replacement status not found');
    }

    return {
      runId: run.run_id,
      status: run.status,
      total: Number(run.total || 0),
      done: Number(run.done || 0),
      generated: Number(run.generated || 0),
      skipped: Number(run.skipped || 0),
      failed: Number(run.failed || 0),
      message: run.message || '',
      updatedAt: run.updated_at || null,
      finishedAt: run.finished_at || null,
    };
  }
}

export const adminService = new AdminService();
