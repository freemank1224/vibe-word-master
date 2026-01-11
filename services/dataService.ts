
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
  const sessions: InputSession[] = (sessionsData || []).map((s: any) => ({
    id: s.id,
    timestamp: new Date(s.created_at).getTime(),
    wordCount: s.word_count,
    targetCount: s.target_count
  }));

  const words: WordEntry[] = (wordsData || []).map((w: any) => ({
    id: w.id,
    text: w.text,
    timestamp: new Date(w.created_at).getTime(),
    sessionId: w.session_id,
    correct: w.correct,
    tested: w.tested,
    image_path: w.image_path,
    image_url: getImageUrl(w.image_path)
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

    // 3. Update Session Count - Recalculate accurately
    // We count the words currently associated with this session
    const { count, error: countError } = await supabase
        .from('words')
        .select('*', { count: 'exact', head: true })
        .eq('session_id', sessionId);

    if (countError) {
        console.error("Error counting words:", countError.message);
    }

    if (count !== null) {
        // Update word count AND timestamp to reflect modification
        const { error: updateError } = await supabase
            .from('sessions')
            .update({ 
                word_count: count,
                created_at: new Date().toISOString() // Bump timestamp to now
            })
            .eq('id', sessionId);

        if (updateError) {
            console.error("Error updating session metadata:", updateError.message);
        }
    }

    return { newWordsData };
};

export const updateWordStatus = async (wordId: string, correct: boolean) => {
  const { error } = await supabase
    .from('words')
    .update({ 
      correct: correct, 
      tested: true,
    })
    .eq('id', wordId);
    
  if (error) console.error("Error updating word status:", error.message);
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
