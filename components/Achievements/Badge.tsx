import React from 'react';
import { Achievement, AchievementStatus } from '../../services/achievementService';
import { ACHIEVEMENT_ICONS } from './AchievementIcons';

interface BadgeProps {
  achievement: Achievement;
  status: AchievementStatus;
}

export const Badge: React.FC<BadgeProps> = ({ achievement, status }) => {
  const { unlocked, formattedProgress } = status;
  
  // Calculate percentage for progress bar, capped at 100
  const percentage = Math.min(100, Math.max(0, (status.currentProgress / achievement.maxProgress) * 100));

  const Icon = ACHIEVEMENT_ICONS[achievement.id] || achievement.emoji;

  return (
    <div className="relative group flex flex-col items-center">
      {/* Badge Container */}
      <div 
        className={`
          w-14 h-14 md:w-16 md:h-16 rounded-2xl flex items-center justify-center p-2 text-2xl md:text-3xl border-2 transition-all duration-300 cursor-help select-none overflow-hidden
          ${unlocked 
            ? 'bg-electric-blue/10 border-electric-blue text-white shadow-[0_0_15px_rgba(0,240,255,0.3)] scale-100 hover:scale-110' 
            : 'bg-dark-charcoal border-mid-charcoal text-gray-600 grayscale opacity-40'}
        `}
      >
        {Icon}
      </div>

      {/* Tooltip Popup */}
      <div className="absolute bottom-full mb-3 w-48 bg-dark-charcoal border border-mid-charcoal rounded-xl p-3 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-20 shadow-xl pointer-events-none transform translate-y-2 group-hover:translate-y-0">
        <div className="text-center">
          <div className={`text-sm font-bold mb-1 ${unlocked ? 'text-electric-blue' : 'text-gray-400'}`}>
            {achievement.title}
          </div>
          <div className="text-xs text-text-light mb-3 leading-tight">{achievement.description}</div>
          
          {/* Progress Bar */}
          <div className="w-full bg-black/40 rounded-full h-1.5 mb-1 overflow-hidden">
             <div 
               className={`h-1.5 rounded-full transition-all duration-500 ${unlocked ? 'bg-electric-blue' : 'bg-mid-charcoal'}`}
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
