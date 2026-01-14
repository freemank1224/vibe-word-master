import React, { useState, useMemo } from 'react';
import { WordEntry, InputSession } from '../../types';
import { calculateAchievements, ACHIEVEMENTS } from '../../services/achievementService';
import { Badge } from './Badge';

interface AchievementsPanelProps {
  words: WordEntry[];
  sessions: InputSession[];
  className?: string;
}

export const AchievementsPanel: React.FC<AchievementsPanelProps> = ({ words, sessions, className = "" }) => {
  const [expanded, setExpanded] = useState(false);

  const stats = useMemo(() => calculateAchievements(words, sessions), [words, sessions]);

  // Combine definition with status
  const badges = ACHIEVEMENTS.map(ach => ({
    definition: ach,
    status: stats.find(s => s.id === ach.id)!
  }));

  const visibleBadges = expanded ? badges : badges.slice(0, 5);
  const unlockedCount = stats.filter(s => s.unlocked).length;
  const totalCount = stats.length;

  return (
    <div className={`bg-light-charcoal p-6 rounded-2xl border border-mid-charcoal hover:border-mid-charcoal/80 transition-colors flex flex-col ${className}`}>
      <div className="flex justify-between items-center mb-6">
        <div className="flex flex-col">
            <h3 className="font-headline text-xl text-electric-blue tracking-widest uppercase">Achievements</h3>
            <div className="text-[10px] font-mono text-text-dark uppercase mt-1">
                <span className="text-electric-blue font-bold">{unlockedCount}</span>
                <span> / {totalCount} UNLOCKED</span>
            </div>
        </div>
        <button 
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-text-dark hover:text-electric-blue transition-all text-[10px] uppercase font-bold tracking-wider py-1 px-2 bg-dark-charcoal rounded-md border border-mid-charcoal/50"
        >
            <span>{expanded ? 'Less' : 'All'}</span>
            <span className={`material-symbols-outlined text-sm transition-transform duration-300 ${expanded ? 'rotate-180' : ''}`}>
                expand_more
            </span>
        </button>
      </div>

      <div className="grid grid-cols-5 gap-2 md:gap-4 justify-items-center flex-1 items-center">
        {visibleBadges.map((badge) => (
            <Badge 
                key={badge.definition.id} 
                achievement={badge.definition} 
                status={badge.status} 
            />
        ))}
      </div>
    </div>
  );
};
