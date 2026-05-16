import { supabase } from '../lib/supabaseClient';
import { compressToSquare } from '../utils/imageUtils';

export interface UserProfile {
  id: string;
  user_id: string;
  username: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

/** Fetch the profile for a given user. Returns null if not found. */
export const getProfile = async (userId: string): Promise<UserProfile | null> => {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error) return null;
  return data as UserProfile;
};

/** Create or update the profile (upsert on user_id). */
export const upsertProfile = async (
  userId: string,
  updates: { username?: string | null; avatar_url?: string | null }
): Promise<UserProfile | null> => {
  const { data, error } = await supabase
    .from('user_profiles')
    .upsert(
      { user_id: userId, ...updates, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
    .select()
    .single();

  if (error) {
    console.error('[profileService] upsertProfile error:', error.message);
    return null;
  }
  return data as UserProfile;
};

/**
 * Compress the given image source (data URL or regular URL) to a 512×512 WebP,
 * upload it to the `avatars` bucket under `{userId}/avatar.webp`, and return
 * the public URL. Returns null on failure.
 */
export const uploadAvatar = async (
  userId: string,
  src: string
): Promise<string | null> => {
  try {
    const blob = await compressToSquare(src, 512, 0.85);
    const path = `${userId}/avatar.webp`;

    const { error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(path, blob, {
        contentType: 'image/webp',
        upsert: true,
        cacheControl: '3600',
      });

    if (uploadError) {
      console.error('[profileService] uploadAvatar error:', uploadError.message);
      return null;
    }

    const { data } = supabase.storage.from('avatars').getPublicUrl(path);
    // Bust cache by appending a timestamp query-param so the browser fetches
    // the newly uploaded version instead of a stale cached one.
    return `${data.publicUrl}?t=${Date.now()}`;
  } catch (err) {
    console.error('[profileService] uploadAvatar exception:', err);
    return null;
  }
};
