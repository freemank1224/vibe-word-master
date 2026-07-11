import React from 'react';
import { SCENE_GAME_COST } from '../../services/coinService';

interface InsufficientCoinsModalProps {
  onClose: () => void;
}

/**
 * Modal shown when a user tries to play a scene game but has fewer
 * than SCENE_GAME_COST coins. Explains the three earn paths so the
 * user knows what to do next.
 */
export const InsufficientCoinsModal: React.FC<InsufficientCoinsModalProps> = ({ onClose }) => {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose}></div>

      <div className="relative bg-dark-charcoal border-2 border-amber-400/50 rounded-3xl p-8 max-w-sm w-full text-center shadow-[0_0_40px_rgba(251,191,36,0.2)]">
        <div className="text-5xl mb-4">🪙</div>

        <h2 className="text-xl font-headline tracking-wide text-amber-300 mb-3 uppercase">
          Not Enough Coins
        </h2>

        <p className="text-text-light text-sm leading-relaxed mb-6">
          Scene mode costs <span className="font-mono text-amber-300">{SCENE_GAME_COST} coins</span>.
          Earn more through daily login, completing quizzes, or unlocking achievements.
        </p>

        <div className="mb-6 space-y-2 text-left font-mono text-xs text-text-light/70">
          <div className="flex items-center gap-2">
            <span className="text-amber-300">🪙</span>
            <span>Daily login: +1 (bonus +7 / +30 on streaks)</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-amber-300">📝</span>
            <span>Quiz & puzzle scores: score ÷ 100 coins</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-amber-300">🏆</span>
            <span>Each achievement: +10 (all 10: +100)</span>
          </div>
        </div>

        <button
          onClick={onClose}
          className="w-full bg-amber-400 text-dark-charcoal font-bold py-3 px-8 rounded-xl hover:bg-amber-300 transition-colors uppercase tracking-wider"
        >
          Got it
        </button>
      </div>
    </div>
  );
};
