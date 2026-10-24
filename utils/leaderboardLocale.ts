import type { ChampionCategory } from '../services/globalLeaderboard';

const LABELS: Record<ChampionCategory, { en: string; zh: string }> = {
  daily_total: { en: 'Daily score', zh: '日常总分' },
  achievements: { en: 'Achievements', zh: '成就解锁' },
  game_total: { en: 'Game score', zh: '游戏总分' },
  word_mastery: { en: 'Word mastery', zh: '单词掌握' },
  coins: { en: 'Coins', zh: '财富榜' },
};

export const leaderboardCategoryLabel = (category: ChampionCategory, isZh: boolean): string =>
  LABELS[category]?.[isZh ? 'zh' : 'en'] ?? (isZh ? '排行榜' : 'Leaderboard');

/** Database labels are Chinese; format their numeric values in the active UI language. */
export const leaderboardScoreLabel = (category: ChampionCategory, score: number, isZh: boolean): string => {
  const value = Number.isFinite(score) ? Math.round(score) : 0;
  const count = value.toLocaleString(isZh ? 'zh-CN' : 'en-US');
  if (category === 'coins') return `${count} ${isZh ? '金币' : value === 1 ? 'coin' : 'coins'}`;
  if (category === 'word_mastery') return `${count} ${isZh ? '个词' : value === 1 ? 'word' : 'words'}`;
  if (category === 'achievements') return `${count} ${isZh ? '项' : value === 1 ? 'badge' : 'badges'}`;
  return `${count} ${isZh ? '分' : value === 1 ? 'point' : 'points'}`;
};
