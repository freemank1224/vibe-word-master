import React from 'react';
import { HoverTranslationText } from '../HoverTranslationText';

interface AccountPanelHeaderProps {
  email?: string | null;
  onClose: () => void;
}

export const AccountPanelHeader: React.FC<AccountPanelHeaderProps> = ({ email, onClose }) => {
  return (
    <div className="p-8 border-b border-mid-charcoal flex justify-between items-center bg-light-charcoal/30">
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-2xl bg-electric-blue/20 flex items-center justify-center border border-electric-blue/40 shadow-[0_0_15px_rgba(0,240,255,0.2)]">
          <span className="material-symbols-outlined text-electric-blue text-3xl">account_circle</span>
        </div>
        <div>
          <h2 className="text-white font-headline text-2xl tracking-widest"><HoverTranslationText text="MONSTER INFO" translation="怪兽信息" /></h2>
          <p className="text-text-dark font-mono text-sm">{email}</p>
        </div>
      </div>
      <button onClick={onClose} className="text-text-dark hover:text-white transition-colors p-2">
        <span className="material-symbols-outlined">close</span>
      </button>
    </div>
  );
};
