import React, { useEffect } from 'react';
import confetti from 'canvas-confetti';
import { Achievement } from '../../services/achievementService';
import { ACHIEVEMENT_ICONS } from './AchievementIcons';

interface AchievementUnlockModalProps {
  achievement: Achievement;
  onClose: () => void;
}

export const AchievementUnlockModal: React.FC<AchievementUnlockModalProps> = ({ achievement, onClose }) => {
  useEffect(() => {
    // Fire confetti on mount
    const duration = 3000;
    const end = Date.now() + duration;

    const frame = () => {
      confetti({
        particleCount: 2,
        angle: 60,
        spread: 55,
        origin: { x: 0 },
        colors: ['#00f0ff', '#ffffff', '#fbbf24'] // Electric blue, white, amber
      });
      confetti({
        particleCount: 2,
        angle: 120,
        spread: 55,
        origin: { x: 1 },
        colors: ['#00f0ff', '#ffffff', '#fbbf24']
      });

      if (Date.now() < end) {
        requestAnimationFrame(frame);
      }
    };

    frame();
  }, []);

  const Icon = ACHIEVEMENT_ICONS[achievement.id] || achievement.emoji;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose}></div>

      {/* Modal Card */}
      <div className="relative bg-dark-charcoal border-2 border-electric-blue rounded-3xl p-8 max-w-sm w-full text-center shadow-[0_0_50px_rgba(0,240,255,0.3)] animate-bounce-in transform scale-100 opacity-100">
        
        {/* Glowing Background Effect */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-48 h-48 bg-electric-blue/20 rounded-full blur-3xl -z-10"></div>

        <div className="mb-2 text-electric-blue font-headline uppercase tracking-widest text-sm">
          Achievement Unlocked!
        </div>

        <h2 className="text-3xl font-bold text-white mb-6 font-headline tracking-wide">
          {achievement.title}
        </h2>
        
        <div className="flex justify-center mb-6">
          <div className="w-32 h-32 rounded-3xl bg-black/30 border-2 border-electric-blue flex items-center justify-center p-4 shadow-[0_0_30px_rgba(0,240,255,0.4)] relative">
             <div className="w-full h-full text-white">
                {Icon}
             </div>
          </div>
        </div>

        <p className="text-text-light text-lg mb-8 leading-relaxed">
          {achievement.description}
        </p>

        <button
          onClick={onClose}
          className="w-full bg-electric-blue text-dark-charcoal font-bold py-3 px-8 rounded-xl hover:bg-white transition-colors uppercase tracking-wider shadow-lg hover:shadow-electric-blue/50"
        >
          Awesome!
        </button>
      </div>
    </div>
  );
};
