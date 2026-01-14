import React, { useState, useMemo } from 'react';
import { WordEntry, InputSession } from '../../types';
import { calculateAchievements, ACHIEVEMENTS } from '../../services/achievementService';
import { Badge } from './Badge';

interface AchievementsPanelProps {
  words: WordEntry[];
  sessions: InputSession[];
}

export const AchievementsPanel: React.FC<AchievementsPanelProps> = ({ words, sessions }) => {
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
    <div className="bg-light-charcoal p-6 rounded-2xl border border-mid-charcoal hover:border-mid-charcoal/80 transition-colors">
      <div className="flex justify-between items-center mb-6">
        <h3 className="font-headline text-xl text-electric-blue tracking-widest uppercase">Achievements</h3>
        <div className="text-xs font-mono bg-dark-charcoal px-3 py-1 rounded-full border border-mid-charcoal/50">
            <span className="text-electric-blue font-bold">{unlockedCount}</span>
            <span className="text-text-dark"> / {totalCount}</span>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-2 md:gap-4 justify-items-center">
        {visibleBadges.map((badge) => (
            <Badge 
                key={badge.definition.id} 
                achievement={badge.definition} 
                status={badge.status} 
            />
        ))}
      </div>

      <button 
        onClick={() => setExpanded(!expanded)}
        className="w-full mt-6 group flex items-center justify-center gap-2 text-text-dark hover:text-electric-blue transition-colors text-xs uppercase font-bold tracking-wider py-2"
      >
        <span className="group-hover:tracking-widest transition-all duration-300">
            {expanded ? 'Show Less' : 'View All Badges'}
        </span>
        <span className={`material-symbols-outlined text-base transition-transform duration-300 ${expanded ? 'rotate-180' : ''}`}>
            expand_more
        </span>
      </button>
    </div>
  );
};
