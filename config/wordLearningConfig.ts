/**
 * Word Learning Algorithm Configuration
 * 单词学习算法配置文件
 *
 * This file centralizes ALL tunable parameters for the word learning system.
 * 本文件集中管理单词学习系统的所有可调参数。
 * Modify these values to adjust the learning algorithm behavior without touching logic code.
 * 修改这些值即可调整学习算法行为，无需修改业务逻辑代码。
 *
 * CONFIGURATION CATEGORIES / 配置分类:
 * 1. Error Tracking - How errors are counted / 错误追踪 - 如何计算错误
 * 2. Error Decay - How errors are reduced over time / 错误衰减 - 如何随时间减少错误
 * 3. Adaptive Selection - How words are prioritized for testing / 自适应选择 - 如何优先选择测试单词
 * 4. Scoring System - How performance is scored / 评分系统 - 如何评分
 */

export const WORD_LEARNING_CONFIG = {
  // ============================================
  // 1. ERROR TRACKING CONFIGURATION
  // 1. 错误追踪配置
  // ============================================
  errorTracking: {
    /**
     * Error increment when user completely fails (3 attempts + reveal)
     * 用户完全失败时的错误增量（3次尝试 + 查看答案）
     * Default: 1.0 (maximum penalty / 最大惩罚)
     */
    completeFailurePenalty: 1.0,

    /**
     * Error increment when using hints (based on hint attempts)
     * 使用提示时的错误增量（基于提示后的尝试次数）
     * The more attempts needed, the higher the penalty
     * 尝试次数越多，惩罚越高
     */
    hintPenalties: {
      zeroErrors: 0.3,   // Used hint but got it right on first try after hint / 使用提示后第一次尝试就答对
      oneError: 0.5,    // Needed 1 attempt after hint / 使用提示后需要1次尝试才答对
      twoErrors: 0.8,   // Needed 2 attempts after hint / 使用提示后需要2次尝试才答对
      threePlusErrors: 1.0  // Needed 3+ attempts (severe difficulty) / 需要3+次尝试（严重困难）
    },

    /**
     * Error increment for wrong answer in hint mode
     * 提示模式下答错时的错误增量
     * This is added ON TOP of the base hint penalty
     * 这是在基础提示惩罚之外的额外增量
     */
    hintModeWrongAnswerPenalty: 0.2,
  },

  // ============================================
  // 2. ERROR DECAY CONFIGURATION
  // 2. 错误衰减配置
  // ============================================
  errorDecay: {
    /**
     * Number of consecutive correct answers (WITHOUT hints) required to trigger error reduction
     * 触发错误减少所需的连续正确答案次数（不使用提示）
     * Default: 3
     * - Lower value = faster decay (easier to reduce errors) / 更低值 = 更快衰减（更容易减少错误）
     * - Higher value = slower decay (requires more consistency) / 更高值 = 更慢衰减（需要更多连续正确）
     */
    consecutiveCorrectThreshold: 3,

    /**
     * Amount to reduce error_count when threshold is reached
     * 达到阈值时减少的 error_count 数量
     * Default: 1.0
     */
    decrementAmount: 1.0,

    /**
     * Automatically remove "Mistake" tag when error_count reaches 0
     * 当 error_count 降为 0 时自动移除"Mistake"标签
     * Default: true
     */
    autoRemoveMistakeTag: true,
  },

  // ============================================
  // 3. ADAPTIVE WORD SELECTION CONFIGURATION
  // 3. 自适应单词选择配置
  // ============================================
  adaptiveSelection: {
    /**
     * Error urgency multiplier
     * 错误紧急度乘数
     * Higher values = error_count has more influence on selection priority
     * 更高值 = error_count 对选择优先级的影响更大
     * Formula: min(40, error_count × this multiplier)
     * 公式：min(40, error_count × 乘数)
     * Default: 8
     */
    errorUrgencyMultiplier: 8,

    /**
     * Maximum error urgency score (capped at this value)
     * 最大错误紧急度分数（上限值）
     * Default: 40
     */
    maxErrorUrgencyScore: 40,

    /**
     * Forgetting risk score range (0 to this value)
     * 遗忘风险分数范围（0 到此值）
     * Default: 35
     */
    maxForgettingRiskScore: 35,

    /**
     * Freshness bonus for words not tested recently (0 to this value)
     * 长时间未测试单词的新鲜度奖励（0 到此值）
     * Default: 15
     */
    maxFreshnessBonusScore: 15,

    /**
     * Default days since last test if never tested
     * 如果从未测试过的单词，默认距离上次测试的天数
     * Default: 30
     */
    defaultDaysSinceLastTest: 30,

    /**
     * Softmax temperature for probability distribution
     * 概率分布的 Softmax 温度参数
     * Lower = more deterministic (always pick highest urgency)
     * 更低 = 更确定性（总是选择最高紧急度）
     * Higher = more random (pick more varied words)
     * 更高 = 更随机（选择更多样化的单词）
     * Default: 2.0
     */
    softmaxTemperature: 2.0,

    /**
     * Shuffle rate for final queue (adjacent swap probability)
     * 最终队列的乱序率（相邻单词交换概率）
     * Adds randomness to avoid predictable ordering
     * 增加随机性以避免可预测的排序
     * Default: 0.3 (30% chance to swap adjacent words / 30%概率交换相邻单词)
     */
    shuffleRate: 0.3,

    /**
     * Legacy SRS queue weights (deprecated, kept for reference)
     * 旧版 SRS 队列权重（已弃用，保留作为参考）
     * Formula: (error_count × this value) + daysSinceLast
     * 公式：（error_count × 此值）+ 距离上次天数
     */
    legacyErrorWeight: 5,
    legacyRandomBonus: 10,
  },

  // ============================================
  // 4. SCORING SYSTEM CONFIGURATION
  // 4. 评分系统配置
  // ============================================
  scoring: {
    /**
     * Points for correct answer WITHOUT hints
     * 不使用提示时答对的得分
     * Default: 3.0
     */
    fullScore: 3.0,

    /**
     * Points for correct answer WITH hints
     * 使用提示时答对的得分
     * Default: 1.5
     */
    hintModeScore: 1.5,

    /**
     * Points for incorrect answer
     * 答错的得分
     * Default: 0
     */
    zeroScore: 0,
  },

  // ============================================
  // 5. UI/UX CONFIGURATION
  // 5. UI/UX 配置
  // ============================================
  ui: {
    /**
     * Maximum attempts allowed before revealing answer (standard mode)
     * 标准模式下显示答案前的最大尝试次数
     * Default: 3
     */
    maxStandardAttempts: 3,

    /**
     * Delay before auto-advance after correct answer (milliseconds)
     * 答对后自动进入下一题的延迟时间（毫秒）
     * Default: 1200
     */
    autoAdvanceDelay: 1200,

    /**
     * Delay before showing failure result (milliseconds)
     * 显示失败结果的延迟时间（毫秒）
     * Default: 1000
     */
    failureResultDelay: 1000,

    /**
     * Test coverage slider range (%)
     * 测试覆盖率滑块范围（%）
     * Default: 1-100
     */
    coverageSlider: {
      min: 1,
      max: 100,
      default: 100,
    },
  },

  // ============================================
  // 6. LIBRARY CONFIGURATION
  // 6. 词库配置
  // ============================================
  library: {
    /**
     * Minimum completeness threshold (%) for a library to be considered "installed"
     * 词库被视为"已安装"的最低完整度阈值（%）
     * Default: 90
     */
    completenessThreshold: 90,

    /**
     * Enable AI-powered word selection optimization
     * 启用 AI 驱动的单词选择优化
     * Default: false (uses adaptive algorithm by default / 默认使用自适应算法)
     */
    enableAIOptimization: false,
  },

  // ============================================
  // 7. DEVELOPMENT/DEBUGGING CONFIGURATION
  // 7. 开发/调试配置
  // ============================================
  debug: {
    /**
     * Enable detailed console logging for error decay mechanism
     * 启用错误衰减机制的详细控制台日志
     * Default: false
     */
    logErrorDecay: true,

    /**
     * Enable detailed console logging for adaptive selector
     * 启用自适应选择器的详细控制台日志
     * Default: false
     */
    logAdaptiveSelector: true,

    /**
     * Enable debug logging for word test results
     * 启用单词测试结果的调试日志
     * Default: false
     */
    logTestResults: true,
  },
} as const;

/**
 * Type-safe configuration access
 * 类型安全的配置访问
 * Prevents accidental modification of config at runtime
 * 防止运行时意外修改配置
 */
export type WordLearningConfig = typeof WORD_LEARNING_CONFIG;

/**
 * Freeze the config object to prevent runtime modifications
 * 冻结配置对象以防止运行时修改
 * This ensures config remains constant throughout the app lifecycle
 * 这确保配置在应用生命周期内保持不变
 */
Object.freeze(WORD_LEARNING_CONFIG);
Object.freeze(WORD_LEARNING_CONFIG.errorTracking);
Object.freeze(WORD_LEARNING_CONFIG.errorTracking.hintPenalties);
Object.freeze(WORD_LEARNING_CONFIG.errorDecay);
Object.freeze(WORD_LEARNING_CONFIG.adaptiveSelection);
Object.freeze(WORD_LEARNING_CONFIG.scoring);
Object.freeze(WORD_LEARNING_CONFIG.ui);
Object.freeze(WORD_LEARNING_CONFIG.ui.coverageSlider);
Object.freeze(WORD_LEARNING_CONFIG.library);
Object.freeze(WORD_LEARNING_CONFIG.debug);

/**
 * Export config with safe type casting for use in components
 * 导出配置，提供安全的类型转换供组件使用
 */
export const useWordLearningConfig = () => WORD_LEARNING_CONFIG;
