
import { supabase } from '../lib/supabaseClient';
import { WordEntry, InputSession } from '../types';
import { compressToWebP } from '../utils/imageUtils';

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

  // Fetch Words (Filtered: Not deleted)
  const { data: wordsData, error: wordsError } = await supabase
    .from('words')
    .select('*')
    .eq('user_id', userId)
    .or('deleted.eq.false,deleted.is.null'); // Ensure we only get active words

  if (wordsError) {
      console.error("Supabase Error fetching words:", wordsError.message);
      throw new Error(`Failed to load words: ${wordsError.message}`);
  }

  // Map DB structure to App Interface
  // Note: We calculate wordCount and timestamp dynamically based on the actual words fetched
  // to ensure the UI always reflects the latest activity, regardless of stale metadata.
  const sessions: InputSession[] = (sessionsData || []).map((s: any) => {
    const sessionWords = (wordsData || []).filter((w: any) => w.session_id === s.id);
    const lastWordTime = sessionWords.length > 0 
      ? Math.max(...sessionWords.map(w => new Date(w.created_at).getTime()))
      : 0;

    return {
      id: s.id,
      timestamp: Math.max(new Date(s.created_at).getTime(), lastWordTime),
      wordCount: sessionWords.length,
      targetCount: s.target_count,
      deleted: s.deleted || false
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
  wordList: { text: string, imageBase64?: string }[]
) => {
  // 1. Create Session
  const { data: sessionData, error: sessionError } = await supabase
    .from('sessions')
    .insert({
      user_id: userId,
      word_count: wordList.length,
      target_count: targetCount
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
      tags: ['Custom']
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
  removedWordIds: string[]
) => {
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

    // 2. Add New Words
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
                tags: ['Custom']
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
    const { error } = await supabase.rpc('sync_todays_stats'); 
    if (error) console.error("Error syncing daily stats:", error.message);
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
    error_count_increment?: number, 
    best_time_ms?: number,
    phonetic?: string,
    audio_url?: string,
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
    tested: true,
    last_tested: new Date().toISOString(),
    error_count: new_error_count,
    best_time_ms: new_best_time
  };

  if (updates.phonetic) payload.phonetic = updates.phonetic;
  if (updates.audio_url) payload.audio_url = updates.audio_url;
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

  // 1. Soft Delete words
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
  // 1. Get or allow creation of a "Library Session"
  // We attempt to reuse a generic "Library Imports" session to avoid spamming the session list.
  // We identify it by target_count = -999 (Internal Convention)
  let sessionId: string;
  
  const { data: existingSessions } = await supabase
    .from('sessions')
    .select('id')
    .eq('user_id', userId)
    .eq('target_count', -999)
    .limit(1);

  if (existingSessions && existingSessions.length > 0) {
     sessionId = existingSessions[0].id;
  } else {
     const { data: newSession, error } = await supabase
        .from('sessions')
        .insert({
            user_id: userId,
            word_count: 0,
            target_count: -999 
        })
        .select()
        .single();
     
     if (error) throw error;
     sessionId = newSession.id;
  }

  // 2. Fetch all existing words for deduplication and tagging
  const { data: userWords } = await supabase
    .from('words')
    .select('id, text, tags')
    .eq('user_id', userId);
    
  const wordMap = new Map<string, { id: string, tags: string[] }>();
  // Use lowercase for matching
  userWords?.forEach((w: any) => wordMap.set(w.text.toLowerCase().trim(), { id: w.id, tags: w.tags || [] }));
  
  const updates: any[] = [];
  const inserts: any[] = [];
  const processedTexts = new Set<string>();

  for (const w of words) {
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

  // 3. Process Inserts (Efficient Bulk Insert)
  if (inserts.length > 0) {
      const CHUNK_SIZE = 100;
       for (let i = 0; i < inserts.length; i += CHUNK_SIZE) {
          const chunk = inserts.slice(i, i + CHUNK_SIZE);
          const { error } = await supabase.from('words').insert(chunk);
          if (error) console.error("Error inserting chunk:", error);
      }
      
      // Update session count (increment)
      // Note: This is an approximation if we have multiple imports.
      // Accurate way: Count words where session_id = sessionId
      /*
      const { count } = await supabase
        .from('words')
        .select('*', { count: 'exact', head: true })
        .eq('session_id', sessionId);
        
      await supabase.from('sessions').update({ word_count: count }).eq('id', sessionId);
      */
  }
  
  // 4. Process Updates (Less Efficient - Row by Row)
  // Since specific RPC for tagging isn't set up, we iterate.
  // Limiting concurrency to avoid overwhelming connection.
  if (updates.length > 0) {
      const CONCURRENCY = 10;
      for (let i = 0; i < updates.length; i += CONCURRENCY) {
          const chunk = updates.slice(i, i + CONCURRENCY);
          await Promise.all(chunk.map(u => 
              supabase.from('words').update({ tags: u.tags }).eq('id', u.id)
          ));
      }
  }
  
  return { updated: updates.length, inserted: inserts.length };
};
