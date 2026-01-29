
import { supabase } from '../lib/supabaseClient';
import { WordEntry, InputSession } from '../types';
import { compressToWebP } from '../utils/imageUtils';
import { aiService } from './ai';

// Helper to get current user ID
export const getCurrentUserId = async (): Promise<string | null> => {
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id || null;
};

// Helper to upload Base64 image to Supabase Storage
export const uploadImage = async (base64Data: string, userId: string): Promise<string | null> => {
  try {
    // 1. Compress and convert to WebP
    // We target 1024x1024 max as it's a good balance of clarity and size
    const blob = await compressToWebP(base64Data, 1024, 1024, 0.8);

    // 2. Generate path (using .webp extension)
    const fileName = `${userId}/${Date.now()}-${Math.random().toString(36).substring(7)}.webp`;
    
    // 3. Upload
    const { data, error } = await supabase.storage
      .from('vocab-images')
      .upload(fileName, blob, {
        cacheControl: '3600',
        upsert: false
      });

    if (error) {
        console.error("Supabase Storage Upload Error:", error.message);
        throw error;
    }
    
    // 4. Return path
    return data.path;
  } catch (error: any) {
    console.error("Upload failed:", error.message || error);
    return null;
  }
};

export const getImageUrl = (path: string | null | undefined): string | null => {
  if (!path) return null;
  const { data } = supabase.storage.from('vocab-images').getPublicUrl(path);
  return data.publicUrl;
};

export const fetchUserData = async (userId: string) => {
  // Fetch Sessions (Filtered: Not deleted)
  const { data: sessionsData, error: sessionsError } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .or('deleted.eq.false,deleted.is.null') // Ensure we only get active sessions
    .order('created_at', { ascending: false });
    
  if (sessionsError) {
      console.error("Supabase Error fetching sessions:", sessionsError.message);
      throw new Error(`Failed to load sessions: ${sessionsError.message}`);
  }

  // Fetch Words (Filtered: Not deleted) - with pagination to handle > 1000 words
  const wordsData: any[] = [];
  let page = 0;
  const PAGE_SIZE = 1000;
  let hasMore = true;
  
  while (hasMore) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    
    const { data: pageData, error: wordsError } = await supabase
      .from('words')
      .select('*')
      .eq('user_id', userId)
      .or('deleted.eq.false,deleted.is.null')
      .range(from, to);

    if (wordsError) {
      console.error("Supabase Error fetching words:", wordsError.message);
      throw new Error(`Failed to load words: ${wordsError.message}`);
    }
    
    if (!pageData || pageData.length === 0) {
      hasMore = false;
    } else {
      wordsData.push(...pageData);
      hasMore = pageData.length === PAGE_SIZE;
      page++;
    }
  }
  
  console.log(`[fetchUserData] Loaded ${wordsData.length} words for user`);

  // Map DB structure to App Interface
  // Note: We calculate wordCount and timestamp dynamically based on the actual words fetched
  // to ensure the UI always reflects the latest activity, regardless of stale metadata.
  const sessions: InputSession[] = (sessionsData || []).map((s: any) => {
    const libraryTag = s.library_tag || 'Custom';
    
    // For library sessions (non-Custom), count words by tags to match LibraryMode filtering
    // For Custom sessions, count words by session_id
    let sessionWords: any[];
    if (libraryTag !== 'Custom') {
      // Count all words that have this library tag
      sessionWords = (wordsData || []).filter((w: any) => {
        const tags = w.tags && w.tags.length > 0 ? w.tags : ['Custom'];
        return tags.includes(libraryTag);
      });
    } else {
      // Custom session: count by session_id
      sessionWords = (wordsData || []).filter((w: any) => w.session_id === s.id);
    }
    
    const lastWordTime = sessionWords.length > 0 
      ? Math.max(...sessionWords.map(w => new Date(w.created_at).getTime()))
      : 0;

    return {
      id: s.id,
      timestamp: Math.max(new Date(s.created_at).getTime(), lastWordTime),
      wordCount: sessionWords.length,
      targetCount: s.target_count,
      deleted: s.deleted || false,
      libraryTag
    };
  }).filter(s => s.wordCount > 0); // Remove sessions that have no active words (Zombies)

  const words: WordEntry[] = (wordsData || []).map((w: any) => ({
    id: w.id,
    text: w.text,
    timestamp: new Date(w.created_at).getTime(),
    sessionId: w.session_id,
    correct: w.correct,
    tested: w.tested,
    image_path: w.image_path,
    image_url: getImageUrl(w.image_path),
    error_count: w.error_count || 0,
    best_time_ms: w.best_time_ms || null,
    last_tested: w.last_tested ? new Date(w.last_tested).getTime() : null,
    phonetic: w.phonetic || null,
    audio_url: w.audio_url || null,
    definition_cn: w.definition_cn || null,
    definition_en: w.definition_en || null,
    deleted: w.deleted || false,
    tags: w.tags || ['Custom']
  }));

  return { sessions, words };
};

export const saveSessionData = async (
  userId: string, 
  targetCount: number, 
  wordList: { text: string, imageBase64?: string }[],
  libraryTag: string = 'Custom'
) => {
  // 1. Create Session
  const { data: sessionData, error: sessionError } = await supabase
    .from('sessions')
    .insert({
      user_id: userId,
      word_count: wordList.length,
      target_count: targetCount,
      library_tag: libraryTag
    })
    .select()
    .single();

  if (sessionError) {
      console.error("Error creating session:", sessionError.message);
      throw sessionError;
  }

  // 2. Process Words & Images
  const wordsPayload = [];
  
  for (const w of wordList) {
    let imagePath = null;
    if (w.imageBase64) {
      imagePath = await uploadImage(w.imageBase64, userId);
    }
    
    wordsPayload.push({
      user_id: userId,
      session_id: sessionData.id,
      text: w.text,
      image_path: imagePath,
      language: w.language || 'en',
      tags: [libraryTag]
    });
  }

  // 3. Bulk Insert Words
  const { data: wordsData, error: wordsError } = await supabase
    .from('words')
    .insert(wordsPayload)
    .select();

  if (wordsError) {
      console.error("Error inserting words:", wordsError.message);
      throw wordsError;
  }

  // 4. Final Sync: Ensure word_count matches actual inserted words
  const { count: finalCount } = await supabase
    .from('words')
    .select('*', { count: 'exact', head: true })
    .eq('session_id', sessionData.id)
    .eq('user_id', userId);

  if (finalCount !== null && finalCount !== wordList.length) {
    await supabase
      .from('sessions')
      .update({ word_count: finalCount })
      .eq('id', sessionData.id)
      .eq('user_id', userId);
  }

  return { sessionData, wordsData: wordsData || [] };
};

export const modifySession = async (
  userId: string,
  sessionId: string,
  addedWords: { text: string, imageBase64?: string }[],
  removedWordIds: string[],
  updatedWords: { id: string, text: string, imageBase64?: string }[] = []
) => {
    // Get session's library_tag - words added to this session belong to its library
    const { data: sessionInfo } = await supabase
        .from('sessions')
        .select('library_tag')
        .eq('id', sessionId)
        .single();
    
    const libraryTag = sessionInfo?.library_tag || 'Custom';
    
    // 1. Delete Removed Words (Soft Delete)
    if (removedWordIds.length > 0) {
        const { error: delError } = await supabase
            .from('words')
            .update({ deleted: true })
            .in('id', removedWordIds);
        
        if (delError) {
            console.error("Error deleting words:", delError.message);
            throw delError;
        }
    }

    // 2. Add New Words - they belong to the session's library
    const newWordsData: any[] = [];
    if (addedWords.length > 0) {
        const wordsPayload = [];
        for (const w of addedWords) {
            let imagePath = null;
            if (w.imageBase64) {
                imagePath = await uploadImage(w.imageBase64, userId);
            }
            wordsPayload.push({
                user_id: userId,
                session_id: sessionId,
                text: w.text,
                image_path: imagePath,
                tags: [libraryTag]
            });
        }
        
        const { data, error: insError } = await supabase
            .from('words')
            .insert(wordsPayload)
            .select();
            
        if (insError) {
            console.error("Error adding words to session:", insError.message);
            throw insError;
        }
        if (data) newWordsData.push(...data);
    }

    // 2.5 Update Existing Words
    // 2.5 Update Existing Words
    if (updatedWords && updatedWords.length > 0) {
        console.log(`Updating ${updatedWords.length} existing words...`);
        for (const w of updatedWords) {
            const updates: any = { text: w.text };
            
            // Only update image if a new one is provided (base64)
            if (w.imageBase64) {
                const imagePath = await uploadImage(w.imageBase64, userId);
                if (imagePath) {
                    updates.image_path = imagePath;
                }
            }

            const { error: upError } = await supabase
                .from('words')
                .update(updates)
                .eq('id', w.id)
                .eq('user_id', userId);

            if (upError) {
                console.error(`Error updating word ${w.id}:`, upError.message);
                throw upError;
            }
        }
    }

    // 3. Update Session Count & Modification Time - Recalculate accurately
    // We count the words currently associated with this session to ensure consistency.
    const { count, error: countError } = await supabase
        .from('words')
        .select('*', { count: 'exact', head: true })
        .eq('session_id', sessionId)
        .eq('user_id', userId)
        .or('deleted.eq.false,deleted.is.null'); // Ensure we ignore deleted words

    if (countError) {
        console.error("Error counting words:", countError.message);
    }

    // Always update word_count and created_at (as editing time)
    const finalCount = count !== null ? count : 0;
    const { error: updateError } = await supabase
        .from('sessions')
        .update({ 
            word_count: finalCount,
            target_count: finalCount, // Align target count with actual count
            created_at: new Date().toISOString() // Bump timestamp to now for "Editing Time"
        })
        .eq('id', sessionId)
        .eq('user_id', userId);

    if (updateError) {
        console.error("Error updating session metadata:", updateError.message);
    }

    return { newWordsData };
};

// V2 Stats with Frozen History & Daily Buffer
export const fetchUserStats = async (userId: string) => {
    const { data, error } = await supabase
        .from('daily_stats')
        .select('*')
        .eq('user_id', userId);
        
    if (error) {
        console.error("Error fetching daily stats:", error.message);
        throw new Error(`Failed to load stats: ${error.message}`);
    }
    return data || [];
};

export const syncDailyStats = async () => {
    // Calculate client's timezone offset in hours (e.g., -480 minutes / 60 = -8, so we negate it to get +8)
    // Date.getTimezoneOffset() returns positive for West, negative for East.
    // China (+8) returns -480. New York (-5) returns 300.
    // We want the adder value: China = +8. So we negate the result.
    const offsetHours = Math.round(-(new Date().getTimezoneOffset() / 60));

    // Try the new dynamic function first
    const { error } = await supabase.rpc('sync_todays_stats_with_timezone', { 
      p_timezone_offset_hours: offsetHours 
    }); 
    
    // Fallback to old function if new one doesn't exist yet (during migration)
    if (error) {
       console.warn("Dynamic sync failed, falling back to static:", error.message);
       await supabase.rpc('sync_todays_stats'); 
    }
};

export const updateWordStatus = async (wordId: string, correct: boolean) => {
  const { error } = await supabase
    .from('words')
    .update({ 
      correct: correct, 
      tested: true,
      last_tested: new Date().toISOString()
    })
    .eq('id', wordId);
    
  if (error) console.error("Error updating word status:", error.message);
  
  // Sync stats (Fire & Forget)
  syncDailyStats();
};

export const updateWordStatusV2 = async (
  wordId: string, 
  updates: { 
    correct: boolean, 
    score?: number,
    error_count_increment?: number, 
    best_time_ms?: number,
    phonetic?: string,
    audio_url?: string,
    language?: string,
    definition_cn?: string,
    definition_en?: string
  }
) => {
  const { data: currentWord } = await supabase
    .from('words')
    .select('error_count, best_time_ms')
    .eq('id', wordId)
    .single();

  const new_error_count = (currentWord?.error_count || 0) + (updates.error_count_increment || 0);
  
  let new_best_time = currentWord?.best_time_ms;
  if (updates.correct && updates.best_time_ms) {
    new_best_time = new_best_time ? Math.min(new_best_time, updates.best_time_ms) : updates.best_time_ms;
  }

  const payload: any = {
    correct: updates.correct,
    score: updates.score,
    tested: true,
    last_tested: new Date().toISOString(),
    error_count: new_error_count,
    best_time_ms: new_best_time
  };

  if (updates.phonetic) payload.phonetic = updates.phonetic;
  if (updates.audio_url) payload.audio_url = updates.audio_url;
  if (updates.language) payload.language = updates.language;
  if (updates.definition_cn) payload.definition_cn = updates.definition_cn;
  if (updates.definition_en) payload.definition_en = updates.definition_en;

  const { error } = await supabase
    .from('words')
    .update(payload)
    .eq('id', wordId);
    
  if (error) console.error("Error updating word status V2:", error.message);
  
  // Sync stats (Fire & Forget)
  syncDailyStats();
};

export const updateWordImage = async (wordId: string, imagePath: string) => {
  const { error } = await supabase
    .from('words')
    .update({ 
      image_path: imagePath
    })
    .eq('id', wordId);
    
  if (error) console.error("Error updating word image:", error.message);
};

/**
 * Update word metadata like audio URL and phonetic transcription
 */
export const updateWordMetadata = async (wordId: string, updates: { 
  audio_url?: string, 
  phonetic?: string,
  definition_en?: string,
  language?: string
}) => {
  const { error } = await supabase
    .from('words')
    .update(updates)
    .eq('id', wordId);
    
  if (error) console.error("Error updating word metadata:", error.message);
};

export const generateSRSQueue = (
    allWords: WordEntry[],
    selectedWordIds: string[],
    targetSize: number = 20
): WordEntry[] => {
    // 1. Core Selection (70%)
    const selectedWords = allWords.filter(w => selectedWordIds.includes(w.id));
    const coreCount = Math.floor(targetSize * 0.7);
    const shuffledSelected = [...selectedWords].sort(() => Math.random() - 0.5).slice(0, coreCount);

    // 2. Error Recall (30%) - Words not in initial selection
    const pool = allWords.filter(w => !selectedWordIds.includes(w.id));
    
    // Calculate weights for all words in pool
    // Weight = error_count * 10 + (time since last tested in days)
    const scoredPool = pool.map(w => {
        const daysSinceLast = w.last_tested 
            ? (Date.now() - w.last_tested) / (1000 * 60 * 60 * 24)
            : 30; // Assume 30 days if never tested
        
        const score = (w.error_count * 5) + daysSinceLast;
        return { word: w, score };
    });

    // Sort by score descending and take the top
    const errorRecallCount = targetSize - shuffledSelected.length;
    const errorRecallPool = scoredPool
        .sort((a, b) => b.score - a.score)
        .slice(0, errorRecallCount * 2); // Get a slightly larger pool to sample from
    
    const shuffledErrorRecall = errorRecallPool
        .sort(() => Math.random() - 0.5)
        .slice(0, errorRecallCount)
        .map(item => item.word);

    // 3. Combine and Final Shuffle with priority
    // Priority: Higher error_count words should generally appear earlier
    const finalQueue = [...shuffledSelected, ...shuffledErrorRecall].sort((a, b) => {
        // We want a mix but weighted towards higher error count
        // Random element to keep it fresh
        const valA = (a.error_count * 2) + Math.random() * 10;
        const bValB = (b.error_count * 2) + Math.random() * 10;
        return bValB - valA;
    });

    return finalQueue;
};

export const deleteSessions = async (userId: string, sessionIds: string[]) => {
  if (!sessionIds || sessionIds.length === 0) return;

  // First, get the library tags of sessions being deleted
  const { data: sessionsToDelete } = await supabase
    .from('sessions')
    .select('id, library_tag')
    .in('id', sessionIds)
    .eq('user_id', userId);

  const libraryTagsToClean = new Set<string>();
  sessionsToDelete?.forEach(s => {
    if (s.library_tag && s.library_tag !== 'Custom') {
      libraryTagsToClean.add(s.library_tag);
    }
  });

  // 1. Soft Delete words that belong to these sessions
  const { error: wordsError } = await supabase
      .from('words')
      .update({ deleted: true })
      .in('session_id', sessionIds)
      .eq('user_id', userId);

  if (wordsError) {
      console.error("Error deleting session words:", wordsError.message);
      throw wordsError;
  }

  // 2. Soft Delete sessions
  const { error: sessionError } = await supabase
      .from('sessions')
      .update({ deleted: true })
      .in('id', sessionIds)
      .eq('user_id', userId);

  if (sessionError) {
      console.error("Error deleting sessions:", sessionError.message);
      throw sessionError;
  }

  // 3. Clean up library tags from words in OTHER sessions
  // When deleting a library session (e.g., CET-6), we need to remove the CET-6 tag
  // from all words that have it, not just the words in the deleted session
  if (libraryTagsToClean.size > 0) {
    console.log('[deleteSessions] Cleaning library tags:', Array.from(libraryTagsToClean));
    
    for (const tag of libraryTagsToClean) {
      // Find all words with this tag (not deleted)
      const { data: wordsWithTag } = await supabase
        .from('words')
        .select('id, tags')
        .eq('user_id', userId)
        .or('deleted.eq.false,deleted.is.null')
        .contains('tags', [tag]);

      if (wordsWithTag && wordsWithTag.length > 0) {
        // Update each word to remove the tag
        const updates = wordsWithTag.map(w => ({
          id: w.id,
          tags: (w.tags || []).filter((t: string) => t !== tag)
        }));

        // Batch update
        for (const update of updates) {
          // Ensure at least 'Custom' tag remains
          const newTags = update.tags.length > 0 ? update.tags : ['Custom'];
          await supabase
            .from('words')
            .update({ tags: newTags })
            .eq('id', update.id);
        }

        console.log(`[deleteSessions] Removed tag '${tag}' from ${updates.length} words`);
      }
    }
  }
};

export const fetchUserAchievements = async (userId: string): Promise<string[]> => {
  const { data, error } = await supabase
    .from('user_achievements')
    .select('achievement_id')
    .eq('user_id', userId);

  if (error) {
    console.error('Error fetching achievements:', error);
    throw new Error(`Failed to load achievements: ${error.message}`);
  }

  return data.map(row => row.achievement_id);
};

export const saveUserAchievement = async (userId: string, achievementId: string): Promise<void> => {
  const { error } = await supabase
    .from('user_achievements')
    .upsert(
      { user_id: userId, achievement_id: achievementId },
      { onConflict: 'user_id, achievement_id', ignoreDuplicates: true }
    );

  if (error) {
    console.error('Error saving achievement:', error);
  }
};

export const getWordsMissingImage = async (userId: string) => {
  const { data, error } = await supabase
      .from('words')
      .select('*')
      .eq('user_id', userId)
      .or('deleted.eq.false,deleted.is.null')
      .is('image_path', null);

  if (error) {
      console.error("Error fetching words missing images:", error.message);
      return [];
  }
  return data || [];
};


export const importDictionaryWords = async (userId: string, words: string[], tag: string) => {
  // 1. Get or create a library-specific session
  // Each library (CET-4, CET-6, TOEFL, etc.) gets its own session
  // This allows proper organization and library-specific deduplication
  let sessionId: string;
  
  const { data: existingSessions } = await supabase
    .from('sessions')
    .select('id')
    .eq('user_id', userId)
    .eq('library_tag', tag)
    .or('deleted.eq.false,deleted.is.null') // Only active sessions
    .limit(1);

  if (existingSessions && existingSessions.length > 0) {
     sessionId = existingSessions[0].id;
  } else {
     const { data: newSession, error } = await supabase
        .from('sessions')
        .insert({
            user_id: userId,
            word_count: 0,
            target_count: -999,
            library_tag: tag
        })
        .select()
        .single();
     
     if (error) throw error;
     sessionId = newSession.id;
  }

  // 1.5 Validate Words (Filter single letters and check spelling)
  console.log(`[importDictionaryWords] Validating ${words.length} words...`);
  const validatedWords: string[] = [];
  for (const w of words) {
    const cleanText = w.trim();
    if (!cleanText) continue;

    // Rule 1: Single letter words (except 'a', 'i')
    if (cleanText.length < 2 && cleanText.toLowerCase() !== 'a' && cleanText.toLowerCase() !== 'i') continue;

    // Rule 2: Spell check
    // We use the local provider first via aiService
    // Skip LLM for bulk imports to ensure speed and prevent API throttling
    const result = await aiService.validateSpelling(cleanText, undefined, undefined, { skipLLM: true });
    if (result.isValid) {
        validatedWords.push(cleanText);
    } else if (result.suggestion) {
        // If it's a clear typo, use the suggestion
        validatedWords.push(result.suggestion);
    }
  }
  
  // Use validated words instead of original words
  const wordsToProcess = validatedWords;

  // 2. Fetch all existing ACTIVE words for deduplication and tagging
  // IMPORTANT: Supabase has a default limit of 1000 rows, so we need to paginate
  const wordMap = new Map<string, { id: string, tags: string[] }>();
  
  let page = 0;
  const PAGE_SIZE = 1000;
  let hasMore = true;
  
  while (hasMore) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    
    const { data: userWords, error: fetchError } = await supabase
      .from('words')
      .select('id, text, tags')
      .eq('user_id', userId)
      .or('deleted.eq.false,deleted.is.null')
      .range(from, to);
    
    if (fetchError) {
      console.error('[importDictionaryWords] Error fetching words page:', fetchError);
      break;
    }
    
    if (!userWords || userWords.length === 0) {
      hasMore = false;
    } else {
      userWords.forEach((w: any) => wordMap.set(w.text.toLowerCase().trim(), { id: w.id, tags: w.tags || [] }));
      hasMore = userWords.length === PAGE_SIZE;
      page++;
    }
  }
  
  console.log(`[importDictionaryWords] Loaded ${wordMap.size} existing words for deduplication`);
  
  const updates: any[] = [];
  const inserts: any[] = [];
  const processedTexts = new Set<string>();

  for (const w of wordsToProcess) {
    const cleanText = w.trim();
    if (!cleanText) continue;
    
    // Skip if we've already seen this word in this batch
    const lowerText = cleanText.toLowerCase();
    if (processedTexts.has(lowerText)) continue;
    processedTexts.add(lowerText);
    
    if (wordMap.has(lowerText)) {
      const existing = wordMap.get(lowerText)!;
      // Only update if tag doesn't exist
      if (!existing.tags.includes(tag)) {
        updates.push({
          id: existing.id,
          tags: [...existing.tags, tag]
        });
      }
    } else {
      inserts.push({
        user_id: userId,
        session_id: sessionId,
        text: cleanText, // Preserve case from list? Or lower?
        // Most lists are lowercase, but some might be Capitalized. 
        // We'll keep input case but use lower for comparison.
        tags: [tag],
        correct: false,
        tested: false,
        error_count: 0
      });
    }
  }

  console.log(`[importDictionaryWords] ${tag}: ${words.length} input words, ${inserts.length} to insert, ${updates.length} to update tags, ${words.length - inserts.length - updates.length} already complete`);

  // 3. Process Inserts (Batch Insert with smaller chunks to avoid limits)
  let insertedCount = 0;
  if (inserts.length > 0) {
      const CHUNK_SIZE = 500; // Smaller batch size to avoid Supabase limits
      for (let i = 0; i < inserts.length; i += CHUNK_SIZE) {
          const chunk = inserts.slice(i, i + CHUNK_SIZE);
          const { error } = await supabase.from('words').insert(chunk);
          
          if (error) {
            console.error(`[importDictionaryWords] Error inserting chunk ${Math.floor(i / CHUNK_SIZE) + 1}:`, error);
            // Don't throw, continue with next batch
          } else {
            insertedCount += chunk.length;
            console.log(`[importDictionaryWords] ✓ Inserted batch ${Math.floor(i / CHUNK_SIZE) + 1}: ${chunk.length} words (total: ${insertedCount}/${inserts.length})`);
          }
      }
      console.log(`[importDictionaryWords] ✅ Completed: Inserted ${insertedCount}/${inserts.length} new words for ${tag}`);
  }
  
  // 4. Process Updates (Batch update tags)
  let updatedCount = 0;
  if (updates.length > 0) {
      const UPDATE_BATCH_SIZE = 100;
      for (let i = 0; i < updates.length; i += UPDATE_BATCH_SIZE) {
          const chunk = updates.slice(i, i + UPDATE_BATCH_SIZE);
          
          // Update in parallel within batch
          const results = await Promise.allSettled(
            chunk.map(u => 
              supabase.from('words').update({ tags: u.tags }).eq('id', u.id)
            )
          );
          
          const successful = results.filter(r => r.status === 'fulfilled').length;
          updatedCount += successful;
          console.log(`[importDictionaryWords] ✓ Updated batch ${Math.floor(i / UPDATE_BATCH_SIZE) + 1}: ${successful}/${chunk.length} words (total: ${updatedCount}/${updates.length})`);
      }
      console.log(`[importDictionaryWords] ✅ Completed: Updated tags for ${updatedCount}/${updates.length} existing words for ${tag}`);
  }
  
  return { updated: updatedCount, inserted: insertedCount };
};

/**
 * Dictionary configuration - uses local pre-cleaned wordlist files
 * These files are stored in /public/dictionaries/wordlists/ as "gold standard"
 * Format: one word per line, lowercase, sorted, deduplicated
 */
export const DICTIONARY_CONFIG = [
  { name: 'Primary School (小学)', localPath: '/dictionaries/wordlists/primary.txt', tag: 'Primary', wordCount: 439 },
  { name: 'Junior High (初中)', localPath: '/dictionaries/wordlists/junior.txt', tag: 'Junior', wordCount: 1887 },
  { name: 'Senior High (高中)', localPath: '/dictionaries/wordlists/senior.txt', tag: 'Senior', wordCount: 3429 },
  { name: 'CET-4 (四级)', localPath: '/dictionaries/wordlists/cet4.txt', tag: 'CET-4', wordCount: 4551 },
  { name: 'CET-6 (六级)', localPath: '/dictionaries/wordlists/cet6.txt', tag: 'CET-6', wordCount: 2219 },
];

/**
 * Parse pre-cleaned word list (one word per line, already lowercase)
 */
const parseCleanWordList = (text: string): string[] => {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
};

/**
 * Fetch word list from local file
 */
export const fetchLocalWordList = async (localPath: string): Promise<string[]> => {
  try {
    const response = await fetch(localPath);
    if (!response.ok) {
      throw new Error(`Failed to fetch local wordlist: ${response.status}`);
    }
    const text = await response.text();
    return parseCleanWordList(text);
  } catch (error) {
    console.error(`[fetchLocalWordList] Error fetching ${localPath}:`, error);
    return [];
  }
};

/**
 * Library verification result
 */
export interface LibraryVerificationResult {
  tag: string;
  name: string;
  isComplete: boolean;
  userWordCount: number;       // How many words user has with this tag
  sourceWordCount: number;     // How many words in source
  completionRate: number;      // Percentage (0-100)
  missingWords: string[];      // Sample of missing words (max 10)
  status: 'complete' | 'incomplete' | 'empty' | 'error';
}

/**
 * Verify library completeness by comparing with local gold standard
 * This performs a full comparison with the pre-cleaned word list
 */
export const verifyLibraryCompleteness = async (
  userId: string, 
  tag: string
): Promise<LibraryVerificationResult> => {
  const config = DICTIONARY_CONFIG.find(d => d.tag === tag);
  
  if (!config) {
    return {
      tag,
      name: tag,
      isComplete: false,
      userWordCount: 0,
      sourceWordCount: 0,
      completionRate: 0,
      missingWords: [],
      status: 'error'
    };
  }

  try {
    // 1. Fetch source word list from local gold standard file
    const sourceWords = await fetchLocalWordList(config.localPath);
    if (sourceWords.length === 0) {
      throw new Error(`Failed to load local wordlist: ${config.localPath}`);
    }
    const sourceWordSet = new Set(sourceWords);
    
    // 2. Fetch user's words with this tag (with pagination to handle > 1000 words)
    const userWords: any[] = [];
    let page = 0;
    const PAGE_SIZE = 1000;
    let hasMore = true;
    
    while (hasMore) {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      
      const { data: pageData, error } = await supabase
        .from('words')
        .select('text, tags')
        .eq('user_id', userId)
        .or('deleted.eq.false,deleted.is.null')
        .contains('tags', [tag])
        .range(from, to);

      if (error) {
        throw error;
      }
      
      if (!pageData || pageData.length === 0) {
        hasMore = false;
      } else {
        userWords.push(...pageData);
        hasMore = pageData.length === PAGE_SIZE;
        page++;
      }
    }
    const userWordSet = new Set(userWords.map((w: any) => w.text.toLowerCase().trim()));
    
    // 3. Calculate missing words
    const missingWords: string[] = [];
    for (const sourceWord of sourceWords) {
      if (!userWordSet.has(sourceWord)) {
        missingWords.push(sourceWord);
        if (missingWords.length >= 10) break; // Only sample first 10
      }
    }

    // 4. Calculate completion rate
    const matchedCount = sourceWords.filter(w => userWordSet.has(w)).length;
    const completionRate = sourceWords.length > 0 
      ? Math.round((matchedCount / sourceWords.length) * 100) 
      : 0;

    // Library is considered "complete" if 95%+ of source words exist
    const COMPLETENESS_THRESHOLD = 95;
    const isComplete = completionRate >= COMPLETENESS_THRESHOLD;

    console.log(`[verifyLibraryCompleteness] ${tag}: ${matchedCount}/${sourceWords.length} = ${completionRate}%`);

    return {
      tag,
      name: config.name,
      isComplete,
      userWordCount: userWords.length,
      sourceWordCount: sourceWords.length,
      completionRate,
      missingWords,
      status: userWords.length === 0 ? 'empty' : (isComplete ? 'complete' : 'incomplete')
    };

  } catch (error: any) {
    console.error(`[verifyLibraryCompleteness] Error for ${tag}:`, error);
    return {
      tag,
      name: config.name,
      isComplete: false,
      userWordCount: 0,
      sourceWordCount: 0,
      completionRate: 0,
      missingWords: [],
      status: 'error'
    };
  }
};

/**
 * Verify all libraries at once
 */
export const verifyAllLibraries = async (userId: string): Promise<Record<string, LibraryVerificationResult>> => {
  const results: Record<string, LibraryVerificationResult> = {};
  
  // Verify all dictionaries in parallel
  const verifications = await Promise.all(
    DICTIONARY_CONFIG.map(config => verifyLibraryCompleteness(userId, config.tag))
  );
  
  verifications.forEach(result => {
    results[result.tag] = result;
  });
  
  return results;
};

/**
 * Simple verification - just counts words (fast, no network)
 * Returns a map of library tags to their word counts
 */
export const verifyLibraryStatus = async (userId: string, libraryTags: string[]): Promise<Record<string, number>> => {
  const result: Record<string, number> = {};
  
  // Query all words for this user with the specified tags
  const { data: words, error } = await supabase
    .from('words')
    .select('tags')
    .eq('user_id', userId)
    .or('deleted.eq.false,deleted.is.null');
  
  if (error) {
    console.error("Error verifying library status:", error.message);
    return result;
  }
  
  // Initialize all tags to 0
  libraryTags.forEach(tag => result[tag] = 0);
  
  // Count words per tag
  words?.forEach((w: any) => {
    const tags = w.tags || ['Custom'];
    tags.forEach((tag: string) => {
      if (libraryTags.includes(tag)) {
        result[tag] = (result[tag] || 0) + 1;
      }
    });
  });
  
  return result;
};
