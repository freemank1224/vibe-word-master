import React from 'react';
import { HoverTranslationText } from '../HoverTranslationText';
import { useLanguage } from '../../contexts/LanguageContext';
import { ToggleSwitch } from '../ToggleSwitch';
import { useT } from '../../hooks/useT';

interface AccountPanelHeaderProps {
  email?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
  onClose: () => void;
  onEditProfile?: () => void;
}

export const AccountPanelHeader: React.FC<AccountPanelHeaderProps> = ({
  email,
  username,
  avatarUrl,
  onClose,
  onEditProfile,
}) => {
  const { isZh, toggleLanguage } = useLanguage();
  const t = useT();

  const displayName = username || email;

  return (
    <div className="p-8 border-b border-mid-charcoal flex justify-between items-center bg-light-charcoal/30">
      <div className="flex items-center gap-4">
        {/* Avatar */}
        <div className="relative group">
          <div className="w-14 h-14 rounded-2xl overflow-hidden border border-electric-blue/40 shadow-[0_0_15px_rgba(0,240,255,0.2)] bg-electric-blue/10 flex items-center justify-center">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt="avatar"
                className="w-full h-full object-cover"
              />
            ) : (
              <span className="material-symbols-outlined text-electric-blue text-3xl">
                account_circle
              </span>
            )}
          </div>
          {/* Edit overlay */}
          {onEditProfile && (
            <button
              onClick={onEditProfile}
              className="absolute inset-0 rounded-2xl bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
              title={t.editProfile}
            >
              <span className="material-symbols-outlined text-white text-lg">edit</span>
            </button>
          )}
        </div>

        <div>
          <h2 className="text-white font-headline text-2xl tracking-widest">
            <HoverTranslationText text="MONSTER INFO" translation="怪兽信息" />
          </h2>
          <div className="flex items-center gap-2">
            <p className="text-text-dark font-mono text-sm truncate max-w-[180px]">
              {displayName}
            </p>
            {onEditProfile && (
              <button
                onClick={onEditProfile}
                className="text-text-dark hover:text-electric-blue transition-colors"
                title={t.editProfile}
              >
                <span className="material-symbols-outlined text-sm">edit</span>
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {/* Language Toggle */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-text-dark uppercase tracking-widest select-none">
            {isZh ? '中文' : 'EN'}
          </span>
          <ToggleSwitch
            checked={isZh}
            onChange={toggleLanguage}
            ariaLabel="Toggle language"
            sizeClassName="w-10 h-6"
            trackOnClassName="bg-electric-purple"
            thumbClassName="w-4 h-4 bg-white"
          />
        </div>
        <button onClick={onClose} className="text-text-dark hover:text-white transition-colors p-2">
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
    </div>
  );
};
