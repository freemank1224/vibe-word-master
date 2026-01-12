
import { supabase } from '../lib/supabaseClient';
import { WordEntry, InputSession } from '../types';

// Helper to upload Base64 image to Supabase Storage
export const uploadImage = async (base64Data: string, userId: string): Promise<string | null> => {
  try {
    // 1. Convert Base64 to Blob
    const base64Content = base64Data.split(',')[1];
    const byteCharacters = atob(base64Content);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: 'image/png' });

    // 2. Generate path
    const fileName = `${userId}/${Date.now()}-${Math.random().toString(36).substring(7)}.png`;
    
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
  // Fetch Sessions
  const { data: sessionsData, error: sessionsError } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
    
  if (sessionsError) {
      console.error("Supabase Error fetching sessions:", sessionsError.message);
  }

  // Fetch Words
  const { data: wordsData, error: wordsError } = await supabase
    .from('words')
    .select('*')
    .eq('user_id', userId);

  if (wordsError) {
      console.error("Supabase Error fetching words:", wordsError.message);
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
      targetCount: s.target_count
    };
  });

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
    definition_en: w.definition_en || null
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
    // 1. Delete Removed Words
    if (removedWordIds.length > 0) {
        const { error: delError } = await supabase
            .from('words')
            .delete()
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
                image_path: imagePath
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
        .eq('user_id', userId);

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
