import React, { useState, useRef, useCallback } from 'react';
import { useT } from '../hooks/useT';
import { uploadAvatar, upsertProfile } from '../services/profileService';
import type { UserProfile } from '../services/profileService';

const MONSTER_PATHS = [
  '/monsterImages/M0.webp',
  '/monsterImages/M1.webp',
  '/monsterImages/M2.webp',
  '/monsterImages/M3.webp',
  '/monsterImages/M4.webp',
  '/monsterImages/M5.webp',
  '/monsterImages/M6.webp',
];

const MAX_USERNAME_LENGTH = 30;

interface ProfileEditModalProps {
  userId: string;
  profile: UserProfile | null;
  onClose: () => void;
  onSaved: (updated: UserProfile) => void;
}

export const ProfileEditModal: React.FC<ProfileEditModalProps> = ({
  userId,
  profile,
  onClose,
  onSaved,
}) => {
  const t = useT();

  const [username, setUsername] = useState(profile?.username ?? '');
  // pendingAvatarSrc: the src to be uploaded (data URL for file upload, or path for monster)
  const [pendingAvatarSrc, setPendingAvatarSrc] = useState<string | null>(null);
  // previewUrl: what to show in the preview circle right now
  const [previewUrl, setPreviewUrl] = useState<string | null>(
    profile?.avatar_url ?? null
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── File upload handler ─────────────────────────────────────────────
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        setPendingAvatarSrc(dataUrl);
        setPreviewUrl(dataUrl);
      };
      reader.readAsDataURL(file);
      // Reset input so the same file can be re-selected if needed
      e.target.value = '';
    },
    []
  );

  // ── Monster selection ──────────────────────────────────────────────
  const handleMonsterSelect = useCallback((path: string) => {
    setPendingAvatarSrc(path);
    setPreviewUrl(path);
  }, []);

  // ── Save ────────────────────────────────────────────────────────────
  const handleSave = async () => {
    setError(null);
    setSuccessMsg(null);

    if (username.length > MAX_USERNAME_LENGTH) {
      setError(t.usernameMaxLength);
      return;
    }

    setSaving(true);

    try {
      let avatarUrl: string | null = profile?.avatar_url ?? null;

      if (pendingAvatarSrc) {
        const uploaded = await uploadAvatar(userId, pendingAvatarSrc);
        if (!uploaded) {
          setError(t.avatarUploadError);
          setSaving(false);
          return;
        }
        avatarUrl = uploaded;
      }

      const trimmedName = username.trim() || null;
      const updated = await upsertProfile(userId, {
        username: trimmedName,
        avatar_url: avatarUrl,
      });

      if (!updated) {
        setError(t.profileSaveError);
        setSaving(false);
        return;
      }

      setSuccessMsg(t.profileSaved);
      onSaved(updated);
      setTimeout(onClose, 900);
    } finally {
      setSaving(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal card */}
      <div className="relative w-full max-w-sm mx-4 bg-dark-charcoal border border-mid-charcoal rounded-3xl shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-mid-charcoal bg-light-charcoal/20">
          <h3 className="text-white font-headline text-lg tracking-widest uppercase">
            {t.editProfile}
          </h3>
          <button
            onClick={onClose}
            className="text-text-dark hover:text-white transition-colors p-1"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="px-6 py-6 space-y-6 overflow-y-auto custom-scrollbar">
          {/* ── Avatar preview ── */}
          <div className="flex flex-col items-center gap-3">
            <div className="relative w-24 h-24 rounded-full overflow-hidden border-2 border-electric-blue/50 shadow-[0_0_18px_rgba(0,240,255,0.25)] bg-mid-charcoal flex items-center justify-center">
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt="avatar preview"
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="material-symbols-outlined text-electric-blue text-5xl">
                  account_circle
                </span>
              )}
            </div>

            {/* Upload button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-electric-blue/30 bg-electric-blue/10 hover:bg-electric-blue/20 text-electric-blue text-sm font-mono uppercase tracking-widest transition-all"
            >
              <span className="material-symbols-outlined text-base">upload</span>
              {t.uploadPhoto}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          {/* ── Default monster grid ── */}
          <div>
            <p className="text-text-dark font-mono text-xs uppercase tracking-widest mb-3">
              {t.defaultAvatars}
            </p>
            <div className="grid grid-cols-7 gap-2">
              {MONSTER_PATHS.map((path) => {
                const selected = pendingAvatarSrc === path;
                return (
                  <button
                    key={path}
                    type="button"
                    onClick={() => handleMonsterSelect(path)}
                    className={`rounded-xl overflow-hidden border-2 transition-all aspect-square focus:outline-none ${
                      selected
                        ? 'border-electric-blue shadow-[0_0_10px_rgba(0,240,255,0.5)]'
                        : 'border-mid-charcoal hover:border-electric-blue/50'
                    }`}
                  >
                    <img
                      src={path}
                      alt={`monster ${path}`}
                      className="w-full h-full object-cover"
                    />
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Username field ── */}
          <div>
            <label className="block text-text-dark font-mono text-xs uppercase tracking-widest mb-2">
              {t.displayName}
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t.displayNamePlaceholder}
              maxLength={MAX_USERNAME_LENGTH}
              className="w-full h-12 px-4 bg-light-charcoal/30 border border-mid-charcoal rounded-xl text-white font-mono text-sm focus:outline-none focus:border-electric-blue/60 placeholder:text-text-dark/50 transition-colors"
            />
            <div className="text-right text-text-dark font-mono text-xs mt-1">
              {username.length}/{MAX_USERNAME_LENGTH}
            </div>
          </div>

          {/* ── Messages ── */}
          {error && (
            <p className="text-red-400 font-mono text-xs text-center">{error}</p>
          )}
          {successMsg && (
            <p className="text-green-400 font-mono text-xs text-center">
              {successMsg}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-5 border-t border-mid-charcoal bg-light-charcoal/10">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="w-full h-12 flex items-center justify-center gap-2 bg-electric-blue/15 hover:bg-electric-blue/25 disabled:opacity-50 disabled:cursor-not-allowed text-electric-blue border border-electric-blue/30 rounded-2xl transition-all font-bold uppercase tracking-widest text-sm"
          >
            {saving ? (
              <>
                <span className="material-symbols-outlined animate-spin text-base">
                  progress_activity
                </span>
                {t.savingProfile}
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-base">save</span>
                {t.saveProfile}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
