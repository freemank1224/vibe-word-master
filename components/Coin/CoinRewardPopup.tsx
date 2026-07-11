import React, { useEffect, useState } from 'react';
import confetti from 'canvas-confetti';
import { CoinIcon } from './CoinIcon';

interface CoinRewardPopupProps {
  amount: number;
  source: 'quiz' | 'puzzle' | 'achievement_bonus';
  onClose: () => void;
}

/**
 * Compact gold coin reward popup. Shown after any coin-earning action
 * (quiz completion, puzzle completion, all-achievements bonus).
 *
 * Plays a short gold confetti burst, displays "+N" with a large coin icon,
 * then auto-dismisses after 3s. User can also tap to dismiss early.
 */
export const CoinRewardPopup: React.FC<CoinRewardPopupProps> = ({ amount, source, onClose }) => {
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    // Gold confetti burst from center
    const colors = ['#fbbf24', '#f59e0b', '#fde68a', '#ffffff'];
    confetti({
      particleCount: 40,
      spread: 65,
      origin: { y: 0.55 },
      colors,
      scalar: 0.9,
    });

    // Auto-dismiss after 3s with fade-out
    const dismissTimer = window.setTimeout(() => setExiting(true), 2500);
    const closeTimer = window.setTimeout(onClose, 3000);
    return () => {
      window.clearTimeout(dismissTimer);
      window.clearTimeout(closeTimer);
    };
  }, [onClose]);

  const sourceLabel = source === 'quiz'
    ? 'Quiz Reward'
    : source === 'puzzle'
    ? 'Puzzle Reward'
    : 'All Achievements Bonus!';

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* Translucent backdrop (click-through feel, doesn't fully block) */}
      <div className={`absolute inset-0 bg-black/40 transition-opacity duration-500 ${exiting ? 'opacity-0' : 'opacity-100'}`} />

      {/* Card */}
      <div
        className={`relative flex flex-col items-center gap-3 rounded-3xl border-2 border-amber-400/60 bg-dark-charcoal px-12 py-8 shadow-[0_0_50px_rgba(251,191,36,0.35)] transition-all duration-500 ${
          exiting ? 'scale-90 opacity-0' : 'scale-100 opacity-100'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Glow */}
        <div className="absolute inset-0 rounded-3xl bg-amber-400/10 blur-2xl -z-10" />

        {/* Coin icon */}
        <CoinIcon fontSize="56px" />

        {/* +N amount */}
        <div className="text-4xl font-bold font-headline tracking-wide text-amber-300">
          +{amount}
        </div>

        {/* Label */}
        <div className="font-mono text-xs uppercase tracking-[0.2em] text-amber-200/60">
          {sourceLabel}
        </div>
      </div>
    </div>
  );
};
