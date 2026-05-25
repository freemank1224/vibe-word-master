import React from 'react';
import { Achievement, AchievementStatus } from '../../services/achievementService';
import { ACHIEVEMENT_ICONS } from './AchievementIcons';

interface BadgeProps {
  achievement: Achievement;
  status: AchievementStatus;
}

export const Badge: React.FC<BadgeProps> = ({ achievement, status }) => {
  const { unlocked, formattedProgress } = status;
  const isDedication = achievement.id === 'p_dedication';
  
  // Calculate percentage for progress bar, capped at 100
  const percentage = Math.min(100, Math.max(0, (status.currentProgress / achievement.maxProgress) * 100));

  const Icon = ACHIEVEMENT_ICONS[achievement.id] || achievement.emoji;
  const unlockedBadgeClass = isDedication
    ? 'bg-[#f5c451]/10 border-[#f5c451] text-[#fff3c4] shadow-[0_0_18px_rgba(245,196,81,0.42)] scale-100 hover:scale-110'
    : 'bg-electric-blue/10 border-electric-blue text-white shadow-[0_0_15px_rgba(0,240,255,0.3)] scale-100 hover:scale-110';
  const unlockedAccentClass = isDedication ? 'text-[#f5c451]' : 'text-electric-blue';
  const unlockedProgressClass = isDedication ? 'bg-[#f5c451]' : 'bg-electric-blue';
  const dedicationPulseStyle = unlocked && isDedication
    ? { animation: 'dedication-breath 2s ease-in-out infinite' }
    : undefined;
  const dedicationIconPulseStyle = unlocked && isDedication
    ? { animation: 'dedication-icon-breath 2s ease-in-out infinite', transformOrigin: 'center' as const }
    : undefined;

  return (
    <div className="relative group flex flex-col items-center">
      {isDedication && (
        <style>{`
          @keyframes dedication-breath {
            0%, 100% {
              box-shadow: 0 0 10px rgba(245,196,81,0.24), 0 0 20px rgba(245,196,81,0.18);
              filter: brightness(0.98);
            }
            50% {
              box-shadow: 0 0 18px rgba(245,196,81,0.48), 0 0 34px rgba(245,196,81,0.34), 0 0 48px rgba(255,221,120,0.2);
              filter: brightness(1.08);
            }
          }

          @keyframes dedication-icon-breath {
            0%, 100% {
              transform: scale(1);
            }
            50% {
              transform: scale(1.12);
            }
          }
        `}</style>
      )}

      {/* Badge Container */}
      <div 
        className={`
          w-14 h-14 md:w-16 md:h-16 rounded-2xl flex items-center justify-center p-2 text-2xl md:text-3xl border-2 transition-all duration-300 cursor-help select-none overflow-hidden
          ${unlocked 
            ? unlockedBadgeClass 
            : 'bg-dark-charcoal border-mid-charcoal text-gray-600 grayscale opacity-40'}
        `}
        style={dedicationPulseStyle}
      >
        <div style={dedicationIconPulseStyle}>
          {Icon}
        </div>
      </div>

      {/* Tooltip Popup */}
      <div className="absolute bottom-full mb-3 w-48 bg-dark-charcoal border border-mid-charcoal rounded-xl p-3 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-20 shadow-xl pointer-events-none transform translate-y-2 group-hover:translate-y-0">
        <div className="text-center">
          <div className={`text-sm font-bold mb-1 ${unlocked ? unlockedAccentClass : 'text-gray-400'}`}>
            {achievement.title}
          </div>
          <div className="text-xs text-text-light mb-3 leading-tight">{achievement.description}</div>
          
          {/* Progress Bar */}
          <div className="w-full bg-black/40 rounded-full h-1.5 mb-1 overflow-hidden">
             <div 
               className={`h-1.5 rounded-full transition-all duration-500 ${unlocked ? unlockedProgressClass : 'bg-mid-charcoal'}`}
               style={{ width: `${percentage}%` }}
             ></div>
          </div>
          <div className="text-[10px] text-text-dark font-mono text-right">
             {formattedProgress}
          </div>
        </div>
        
        {/* Triangle Arrow */}
        <div className="absolute left-1/2 -bottom-1 w-2 h-2 bg-dark-charcoal border-r border-b border-mid-charcoal transform -translate-x-1/2 rotate-45"></div>
      </div>
    </div>
  );
};
