/**
 * Adaptive Word Selector
 *
 * 智能单词选择器，基于 error_count 的精细差异动态调整测试顺序
 * 实现概率加权算法，优先复习难词，同时避免过度重复
 */

import { WordEntry, InputSession } from '@/types';
import { WORD_LEARNING_CONFIG } from '../config/wordLearningConfig';

/**
 * Normalized weight configuration (sums to 1.0)
 * 归一化的权重配置（总和为1.0）
 */
interface NormalizedWeights {
  errorUrgency: number;      // 0-1, will be multiplied by baseScoreScale
  forgettingRisk: number;    // 0-1
  freshnessBonus: number;    // 0-1
}

/**
 * Maximum scores calculated from normalized weights
 * 根据归一化权重计算的最大分数
 */
interface MaxScores {
  maxErrorUrgencyScore: number;
  maxForgettingRiskScore: number;
  maxFreshnessBonusScore: number;
}

interface UrgencyScore {
  errorUrgency: number;      // 错误紧急度
  forgettingRisk: number;     // 遗忘风险
  freshnessBonus: number;     // 新鲜度奖励
  total: number;              // 总分
}

interface ScoredWord {
  word: WordEntry;
  urgency: number;
  probability: number;
}

export class AdaptiveWordSelector {
  private config = {
    temperature: WORD_LEARNING_CONFIG.adaptiveSelection.softmaxTemperature,
    shuffleRate: WORD_LEARNING_CONFIG.adaptiveSelection.shuffleRate,
  };

  private normalizedWeights: NormalizedWeights;
  private maxScores: MaxScores;

  constructor() {
    const adaptiveConfig = WORD_LEARNING_CONFIG.adaptiveSelection;

    // Calculate and cache normalized weights
    // 计算并缓存归一化权重
    this.normalizedWeights = this.normalizeWeights(
      adaptiveConfig.weights.errorUrgency,
      adaptiveConfig.weights.forgettingRisk,
      adaptiveConfig.weights.freshnessBonus
    );

    // Calculate maximum scores for each factor
    // 计算每个因子的最大分数
    this.maxScores = this.calculateMaxScores(this.normalizedWeights);

    // Log configuration for debugging
    // 输出配置用于调试
    if (WORD_LEARNING_CONFIG.debug.logAdaptiveSelector) {
      console.log('[AdaptiveWordSelector] Initialized with weights:', {
        input: adaptiveConfig.weights,
        normalized: this.normalizedWeights,
        maxScores: this.maxScores
      });
    }
  }

  /**
   * 计算测试队列（主入口）
   *
   * @param allWords - 所有单词（用于完整性检查）
   * @param availablePool - 当前可用的单词池
   * @param targetCount - 目标单词数量
   * @param sessions - 历史会话（可选，未来扩展用）
   * @returns 选中的单词队列
   */
  calculateQueue(
    allWords: WordEntry[],
    availablePool: WordEntry[],
    targetCount: number,
    sessions?: InputSession[]
  ): WordEntry[] {
    // 1. 过滤候选词（去除已删除）
    const candidates = availablePool.filter(w => !w.deleted);

    if (candidates.length === 0) {
      console.warn('⚠️ [Adaptive Selector] No candidates available');
      return [];
    }

    // 2. 计算每个单词的紧急度分数
    const scoredWords: ScoredWord[] = candidates.map(word => ({
      word,
      urgency: this.calculateUrgency(word),
      probability: 0 // 待计算
    }));

    // 3. 转换为概率分布（Softmax）
    const scoredWithProbabilities = this.applySoftmax(scoredWords);

    // 4. 加权随机采样
    const selected = this.weightedSample(scoredWithProbabilities, targetCount);

    // 5. 轻微乱序（保持一定随机性，避免完全可预测）
    const shuffled = this.lightShuffle(selected);

    // DEBUG: 输出选择统计
    this.logDebugStats(candidates, selected, scoredWithProbabilities);

    return shuffled;
  }

  /**
   * Normalize weights to sum to 1.0 (100%)
   * 将权重归一化，使其总和为1.0（100%）
   * @private
   */
  private normalizeWeights(
    errorUrgency: number,
    forgettingRisk: number,
    freshnessBonus: number
  ): NormalizedWeights {
    const total = errorUrgency + forgettingRisk + freshnessBonus;

    // Avoid division by zero
    // 避免除以零
    if (total === 0) {
      console.warn('[AdaptiveWordSelector] All weights are zero, using equal distribution');
      return {
        errorUrgency: 1/3,
        forgettingRisk: 1/3,
        freshnessBonus: 1/3
      };
    }

    return {
      errorUrgency: errorUrgency / total,
      forgettingRisk: forgettingRisk / total,
      freshnessBonus: freshnessBonus / total
    };
  }

  /**
   * Calculate maximum scores from normalized weights
   * 根据归一化权重计算最大分数
   * @private
   */
  private calculateMaxScores(weights: NormalizedWeights): MaxScores {
    const baseScale = WORD_LEARNING_CONFIG.adaptiveSelection.baseScoreScale;

    return {
      maxErrorUrgencyScore: weights.errorUrgency * baseScale,
      maxForgettingRiskScore: weights.forgettingRisk * baseScale,
      maxFreshnessBonusScore: weights.freshnessBonus * baseScale
    };
  }

  /**
   * 计算单词紧急度分数（0-90分）
   * 分数越高，表示该单词越需要被测试
   */
  private calculateUrgency(word: WordEntry): number {
    const adaptiveConfig = WORD_LEARNING_CONFIG.adaptiveSelection;
    const now = Date.now();
    const daysSinceTested = word.last_tested
      ? (now - word.last_tested) / (1000 * 60 * 60 * 24)
      : adaptiveConfig.defaultDaysSinceLastTest; // Use config for default days

    // 1. 错误紧急度（使用动态计算的最大分数）
    // error_count 越高，紧急度越高
    // 精细差异：0.3/0.5/0.8/1.0 都会被合理计算
    const errorUrgency = Math.min(
      this.maxScores.maxErrorUrgencyScore,
      word.error_count * adaptiveConfig.errorUrgencyMultiplier
    );

    // 2. 遗忘风险（使用动态计算的最大分数）
    // 基于 last_tested 和 error_count 估算遗忘概率
    const forgettingRisk = this.calculateForgettingRisk(daysSinceTested, word.error_count);

    // 3. 新鲜度奖励（使用动态计算的最大分数）
    // 长时间未测试的单词获得加分
    const freshnessBonus = Math.min(
      this.maxScores.maxFreshnessBonusScore,
      daysSinceTested * 0.5
    );

    // 4. 总分（自动等于 baseScoreScale）
    const total = errorUrgency + forgettingRisk + freshnessBonus;

    return total;
  }

  /**
   * 遗忘风险计算（简化版艾宾浩斯）
   *
   * @param daysSince - 距离上次测试的天数
   * @param errorCount - 错误次数
   * @returns 遗忘风险分数（0-maxForgettingRiskScore）
   */
  private calculateForgettingRisk(daysSince: number, errorCount: number): number {
    // 基础遗忘曲线：基于记忆衰减模型
    // error_count 越高，遗忘越快（需要更频繁复习）
    const effectiveInterval = Math.max(1, 7 - errorCount);
    const retentionRate = Math.exp(-daysSince / effectiveInterval);

    // 转换为 0-maxForgettingRiskScore 分的遗忘风险（使用动态计算的最大分数）
    const forgettingRisk = (1 - retentionRate) * this.maxScores.maxForgettingRiskScore;

    return Math.max(0, Math.min(this.maxScores.maxForgettingRiskScore, forgettingRisk));
  }

  /**
   * Softmax 概率转换
   * 将紧急度分数转换为概率分布，确保高分词出现概率更高
   */
  private applySoftmax(scoredWords: ScoredWord[]): ScoredWord[] {
    if (scoredWords.length === 0) return [];

    // 找到最大分数（用于数值稳定性）
    const maxScore = Math.max(...scoredWords.map(w => w.urgency));
    const temperature = this.config.temperature;

    // 计算每个词的 softmax 概率
    let sumExp = 0;
    const expValues: number[] = [];

    scoredWords.forEach((sw, index) => {
      const exp = Math.exp((sw.urgency - maxScore) / temperature);
      expValues[index] = exp;
      sumExp += exp;
    });

    // 归一化得到概率
    scoredWords.forEach((sw, index) => {
      sw.probability = expValues[index] / sumExp;
    });

    return scoredWords;
  }

  /**
   * 加权随机采样
   * 基于概率分布选择单词，避免简单排序导致的可预测性
   */
  private weightedSample(scoredWords: ScoredWord[], count: number): WordEntry[] {
    const selected: WordEntry[] = [];
    const available = [...scoredWords]; // 复制一份，避免修改原数组

    for (let i = 0; i < count && available.length > 0; i++) {
      const r = Math.random();
      let cumulative = 0;

      for (let j = 0; j < available.length; j++) {
        cumulative += available[j].probability;

        if (r <= cumulative) {
          selected.push(available[j].word);
          // 移除已选的词，避免重复
          available.splice(j, 1);
          // 重新归一化剩余单词的概率
          this.renormalizeProbabilities(available);
          break;
        }
      }

      // 如果循环结束还没选中（浮点精度问题），随机选一个
      if (selected.length <= i && available.length > 0) {
        const randomIndex = Math.floor(Math.random() * available.length);
        selected.push(available[randomIndex].word);
        available.splice(randomIndex, 1);
        this.renormalizeProbabilities(available);
      }
    }

    return selected;
  }

  /**
   * 重新归一化概率
   * 在移除已选单词后，重新计算剩余单词的概率分布
   */
  private renormalizeProbabilities(scoredWords: ScoredWord[]): void {
    const total = scoredWords.reduce((sum, sw) => sum + sw.probability, 0);

    if (total > 0) {
      scoredWords.forEach(sw => {
        sw.probability = sw.probability / total;
      });
    }
  }

  /**
   * 轻微乱序
   * 对已选队列进行轻微打乱，避免完全按紧急度排序
   * 相邻位置有 30% 概率交换
   */
  private lightShuffle(words: WordEntry[]): WordEntry[] {
    const result = [...words];

    for (let i = 0; i < result.length - 1; i++) {
      if (Math.random() < this.config.shuffleRate) {
        // 交换相邻元素
        [result[i], result[i + 1]] = [result[i + 1], result[i]];
      }
    }

    return result;
  }

  /**
   * 调试日志输出
   */
  private logDebugStats(
    candidates: WordEntry[],
    selected: WordEntry[],
    scoredWords: ScoredWord[]
  ) {
    // 计算候选词的 error_count 分布
    const errorDistribution = {
      critical: candidates.filter(w => w.error_count >= 3).length,
      high: candidates.filter(w => w.error_count >= 1 && w.error_count < 3).length,
      low: candidates.filter(w => w.error_count >= 0.3 && w.error_count < 1).length,
      perfect: candidates.filter(w => w.error_count < 0.3).length
    };

    // 计算选中词的平均紧急度和概率
    const avgUrgency = selected.length > 0
      ? scoredWords
          .filter(sw => selected.some(w => w.id === sw.word.id))
          .reduce((sum, sw) => sum + sw.urgency, 0) / selected.length
      : 0;

    console.log('🎯 [Adaptive Selector]', {
      totalCandidates: candidates.length,
      selectedCount: selected.length,
      errorDistribution,
      avgUrgency: avgUrgency.toFixed(2),
      topSelectedWords: selected.slice(0, 5).map(w => ({
        text: w.text,
        error_count: w.error_count,
        days_since_tested: w.last_tested
          ? ((Date.now() - w.last_tested) / (1000 * 60 * 60 * 24)).toFixed(1)
          : 'Never'
      }))
    });
  }
}

// 导出单例
export const adaptiveWordSelector = new AdaptiveWordSelector();
