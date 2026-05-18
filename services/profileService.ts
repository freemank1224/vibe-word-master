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

// ─── localStorage cache keys ──────────────────────────────────────────────────
const profileKey = (uid: string) => `vibe_profile:${uid}`;
const avatarB64Key = (uid: string) => `vibe_avatar_b64:${uid}`;
const avatarUrlKey = (uid: string) => `vibe_avatar_url:${uid}`;  // tracks which URL was cached

/** Synchronously read the last-known profile from localStorage. Returns null if absent. */
export const getCachedProfile = (userId: string): UserProfile | null => {
  try {
    const raw = localStorage.getItem(profileKey(userId));
    return raw ? (JSON.parse(raw) as UserProfile) : null;
  } catch {
    return null;
  }
};

/** Synchronously read the cached avatar as a base64 data URL. Returns null if absent. */
export const getCachedAvatarDataUrl = (userId: string): string | null =>
  localStorage.getItem(avatarB64Key(userId));

/** Persist a profile snapshot to localStorage. */
export const saveProfileCache = (profile: UserProfile): void => {
  try {
    localStorage.setItem(profileKey(profile.user_id), JSON.stringify(profile));
  } catch { /* quota exceeded – ignore */ }
};

/**
 * Fetch the avatar from `avatarUrl`, compress it to 128 × 128 WebP, and store
 * the result as a base64 data URL so future renders are instant.
 * Only re-fetches when the URL has changed since the last cache write.
 */
export const cacheAvatarFromUrl = async (userId: string, avatarUrl: string): Promise<void> => {
  if (!avatarUrl) return;
  if (localStorage.getItem(avatarUrlKey(userId)) === avatarUrl) return; // already cached

  try {
    const res = await fetch(avatarUrl);
    if (!res.ok) return;
    const blob = await res.blob();

    // Compress to 128 × 128 square
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const minDim = Math.min(bmp.width, bmp.height);
    const sx = (bmp.width - minDim) / 2;
    const sy = (bmp.height - minDim) / 2;
    ctx.drawImage(bmp, sx, sy, minDim, minDim, 0, 0, 128, 128);

    await new Promise<void>((resolve) => {
      canvas.toBlob((compressed) => {
        if (!compressed) { resolve(); return; }
        const reader = new FileReader();
        reader.onload = () => {
          try {
            localStorage.setItem(avatarB64Key(userId), reader.result as string);
            localStorage.setItem(avatarUrlKey(userId), avatarUrl);
          } catch { /* quota exceeded */ }
          resolve();
        };
        reader.onerror = () => resolve();
        reader.readAsDataURL(compressed);
      }, 'image/webp', 0.75);
    });
  } catch { /* network or API failure – silently skip */ }
};

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
