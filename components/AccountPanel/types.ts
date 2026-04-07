import { AchievementStatus } from '../../services/achievementService';

export type AccountChartTab = 'progress' | 'mastery';

export interface AccountPanelStats {
  totalWords: number;
  testedWords: number;
  correctWords: number;
  coverage: number;
  accuracy: number;
  daysSinceStart: number;
  currentStreak: number;
  achievementStatuses: AchievementStatus[];
}
