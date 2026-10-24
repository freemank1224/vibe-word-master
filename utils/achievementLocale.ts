import type { Achievement } from '../services/achievementService';

const CHINESE_ACHIEVEMENTS: Record<string, { title: string; description: string }> = {
  p_novice: { title: '初次探索', description: '向词库添加第一个单词' },
  p_consistency: { title: '持之以恒', description: '连续学习 7 天' },
  p_dedication: { title: '坚持不懈', description: '连续学习 30 天' },
  p_hoarder: { title: '单词收藏家', description: '收集 100 个单词' },
  p_builder: { title: '词库建造者', description: '收集 1000 个单词' },
  a_bullseye: { title: '百发百中', description: '完成一次全部答对的测验' },
  a_sharp: { title: '思维敏锐', description: '总体正确率达到 80% 以上' },
  a_precision: { title: '精准大师', description: '完成 5 次全部答对的测验' },
  a_veteran: { title: '词汇老将', description: '累计答对 500 次' },
  a_grandmaster: { title: '词汇宗师', description: '总体正确率达到 90% 以上' },
};

export const achievementLocale = (achievement: Achievement, isZh: boolean) =>
  isZh ? CHINESE_ACHIEVEMENTS[achievement.id] ?? achievement : achievement;
