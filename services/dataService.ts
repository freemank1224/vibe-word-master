
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

    if (error) throw error;
    
    // 4. Return path
    return data.path;
  } catch (error) {
    console.error("Upload failed:", error);
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
    
  if (sessionsError) console.error("Error fetching sessions:", sessionsError);

  // Fetch Words
  const { data: wordsData, error: wordsError } = await supabase
    .from('words')
    .select('*')
    .eq('user_id', userId);

  if (wordsError) console.error("Error fetching words:", wordsError);

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
    timestamp: new Date(w.created_at).getTime(), // Use created_at for simple "added" timestamp
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

  if (sessionError) throw sessionError;

  // 2. Process Words & Images
  // If imageBase64 is present (manual upload), we upload it now.
  // If not (typed), we skip and allow background process to handle it later.
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
      // For compatibility, we can set created_at here implicitly by DB default
    });
  }

  // 3. Bulk Insert Words
  const { data: wordsData, error: wordsError } = await supabase
    .from('words')
    .insert(wordsPayload)
    .select();

  if (wordsError) throw wordsError;

  return { sessionData, wordsData };
};

export const updateWordStatus = async (wordId: string, correct: boolean) => {
  const { error } = await supabase
    .from('words')
    .update({ 
      correct: correct, 
      tested: true,
    })
    .eq('id', wordId);
    
  if (error) console.error("Error updating word:", error);
};

export const updateWordImage = async (wordId: string, imagePath: string) => {
  const { error } = await supabase
    .from('words')
    .update({ 
      image_path: imagePath
    })
    .eq('id', wordId);
    
  if (error) console.error("Error updating word image:", error);
};
