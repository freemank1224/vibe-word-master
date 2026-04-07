import React from 'react';
import { ACHIEVEMENTS, AchievementStatus } from '../../services/achievementService';
import { Badge } from '../Achievements/Badge';
import { HoverTranslationText } from '../HoverTranslationText';

interface AchievementsSectionProps {
  unlockedCount: number;
  achievementStatuses: AchievementStatus[];
}

export const AchievementsSection: React.FC<AchievementsSectionProps> = ({ unlockedCount, achievementStatuses }) => {
  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h3 className="font-headline text-lg text-white tracking-[0.2em] uppercase"><HoverTranslationText text="Special Badges" translation="特殊徽章" /></h3>
        <div className="text-[10px] font-mono text-text-dark uppercase bg-light-charcoal px-2 py-1 rounded">
          <span className="text-electric-blue font-bold">{unlockedCount}</span>
          <span> / {ACHIEVEMENTS.length} COLLECTED</span>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-4">
        {ACHIEVEMENTS.map((achievement) => (
          <Badge
            key={achievement.id}
            achievement={achievement}
            status={achievementStatuses.find((status) => status.id === achievement.id)!}
          />
        ))}
      </div>
    </div>
  );
};
