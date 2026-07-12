import React, { useEffect } from 'react';
import confetti from 'canvas-confetti';
import type { DailyLoginReward } from '../../services/coinService';
import { CoinIcon } from './CoinIcon';
import { playCoinReward } from '../../utils/audioFeedback';

interface DailyLoginRewardModalProps {
  reward: DailyLoginReward;
  onClose: () => void;
}

/**
 * Full-screen celebration modal shown after the first claim of each
 * Beijing-day. Mirrors the AchievementUnlockModal visual language
 * (dark backdrop + centered electric-blue card) but swaps the accent
 * to amber to match the coin theme.
 */
export const DailyLoginRewardModal: React.FC<DailyLoginRewardModalProps> = ({ reward, onClose }) => {
  useEffect(() => {
    // Coin jingle
    playCoinReward();

    // Gold + electric-blue confetti burst
    const colors = ['#fbbf24', '#f59e0b', '#00f0ff', '#ffffff'];
    confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 }, colors });
    const end = Date.now() + 2000;
    const frame = () => {
      confetti({ particleCount: 2, angle: 60, spread: 55, origin: { x: 0 }, colors });
      confetti({ particleCount: 2, angle: 120, spread: 55, origin: { x: 1 }, colors });
      if (Date.now() < end) requestAnimationFrame(frame);
    };
    frame();
  }, []);

  const progress7  = reward.streak_7_bonus_today  ? 7 : reward.streak_7_progress;
  const progress30 = reward.streak_30_bonus_today ? 30 : reward.streak_30_progress;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose}></div>

      {/* Card */}
      <div className="relative bg-dark-charcoal border-2 border-amber-400 rounded-3xl p-8 max-w-sm w-full text-center shadow-[0_0_50px_rgba(251,191,36,0.3)]">
        {/* Glow */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-48 h-48 bg-amber-400/20 rounded-full blur-3xl -z-10"></div>

        {/* Header */}
        <div className="mb-2 text-amber-400 font-headline uppercase tracking-widest text-sm">
          Daily Reward
        </div>

        {/* Big award */}
        <div className="mb-6">
          <div className="text-5xl font-bold text-white font-headline tracking-wide">
            +{reward.total_awarded}
          </div>
          <div className="mt-1 flex justify-center">
            <CoinIcon fontSize="40px" />
          </div>
        </div>

        {/* Breakdown rows */}
        <div className="mb-6 space-y-1.5 text-sm font-mono">
          <div className="flex justify-between text-text-light/80">
            <span>Daily login</span>
            <span className="text-amber-300">+1</span>
          </div>
          {reward.streak_7_bonus_today && (
            <div className="flex justify-between text-electric-green">
              <span>7-day cycle bonus</span>
              <span>+7</span>
            </div>
          )}
          {reward.streak_30_bonus_today && (
            <div className="flex justify-between text-electric-blue">
              <span>30-day cycle bonus</span>
              <span>+30</span>
            </div>
          )}
        </div>

        {/* Streak */}
        <div className="mb-4 font-mono text-electric-green text-sm">
          🔥 Streak: {reward.current_streak} day{reward.current_streak === 1 ? '' : 's'}
        </div>

        {/* Progress bars */}
        <div className="mb-6 space-y-3">
          <div>
            <div className="flex justify-between text-xs font-mono text-text-light/60 mb-1">
              <span>7-day cycle</span>
              <span>{progress7}/7</span>
            </div>
            <div className="h-2 rounded-full bg-black/40 overflow-hidden">
              <div
                className="h-full bg-electric-green rounded-full transition-all duration-500"
                style={{ width: `${(progress7 / 7) * 100}%` }}
              ></div>
            </div>
          </div>
          <div>
            <div className="flex justify-between text-xs font-mono text-text-light/60 mb-1">
              <span>30-day cycle</span>
              <span>{progress30}/30</span>
            </div>
            <div className="h-2 rounded-full bg-black/40 overflow-hidden">
              <div
                className="h-full bg-electric-blue rounded-full transition-all duration-500"
                style={{ width: `${(progress30 / 30) * 100}%` }}
              ></div>
            </div>
          </div>
        </div>

        <button
          onClick={onClose}
          className="w-full bg-amber-400 text-dark-charcoal font-bold py-3 px-8 rounded-xl hover:bg-amber-300 transition-colors uppercase tracking-wider shadow-lg hover:shadow-amber-400/50"
        >
          Collect
        </button>
      </div>
    </div>
  );
};
