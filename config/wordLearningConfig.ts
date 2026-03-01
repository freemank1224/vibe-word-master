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
     * Weight distribution for urgency score factors (%)
     * 紧急度评分因子的权重分布（百分比）
     * Weights will be automatically normalized to sum to 100%
     * 权重会自动归一化，确保总和为100%
     *
     * Default: 45:40:15 (Error:Forgetting:Freshness)
     * 默认：45:40:15（错误:遗忘:新鲜）
     */
    weights: {
      /**
       * Error urgency weight (based on error_count)
       * 错误紧急度权重（基于 error_count）
       * Range: 0-100, will be normalized
       * 范围：0-100，会归一化
       * Default: 45
       */
      errorUrgency: 45,

      /**
       * Forgetting risk weight (based on days since last test)
       * 遗忘风险权重（基于距离上次测试的天数）
       * Range: 0-100, will be normalized
       * 范围：0-100，会归一化
       * Default: 40
       */
      forgettingRisk: 40,

      /**
       * Freshness bonus weight (for words not tested recently)
       * 新鲜度奖励权重（针对长时间未测试的单词）
       * Range: 0-100, will be normalized
       * 范围：0-100，会归一化
       * Default: 15
       */
      freshnessBonus: 15,
    },

    /**
     * Base score scale (total urgency score will be normalized to this value)
     * 基础分数缩放（总分将归一化到此值）
     * Default: 100 (makes percentages directly interpretable)
     * 默认：100（使百分比可直接解释）
     */
    baseScoreScale: 100,

    /**
     * Error urgency multiplier
     * 错误紧急度乘数
     * Higher values = error_count has more influence on selection priority
     * 更高值 = error_count 对选择优先级的影响更大
     * Formula: min(maxErrorUrgencyScore, error_count × this multiplier)
     * 公式：min(maxErrorUrgencyScore, error_count × 乘数)
     * Default: 8
     */
    errorUrgencyMultiplier: 8,

    /**
     * DEPRECATED: Use weights.errorUrgency instead
     * 已弃用：请使用 weights.errorUrgency
     * Automatically calculated from weights and baseScoreScale
     * 根据权重和 baseScoreScale 自动计算
     * @deprecated
     */
    maxErrorUrgencyScore: 40,

    /**
     * DEPRECATED: Use weights.forgettingRisk instead
     * 已弃用：请使用 weights.forgettingRisk
     * @deprecated
     */
    maxForgettingRiskScore: 35,

    /**
     * DEPRECATED: Use weights.freshnessBonus instead
     * 已弃用：请使用 weights.freshnessBonus
     * @deprecated
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

  // ============================================
  // 8. LEADERBOARD CONFIGURATION
  // 8. 排行榜配置
  // ============================================
  leaderboard: {
    /**
     * Weight coefficients for scoring factors (must sum to 1.0)
     * 评分因子的权重系数（总和必须为 1.0）
     */
    weights: {
      testCount: 0.25,      // Words tested (25%) / 测试单词数权重
      newWords: 0.20,       // New words added (20%) / 新增单词权重
      accuracy: 0.30,       // Accuracy rate (30%) / 正确率权重
      difficulty: 0.25,     // Word difficulty (25%) / 单词难度权重
    },

    /**
     * Normalization caps (values beyond these are capped at 100% score)
     * 归一化上限（超过这些值的分数将被限制为 100%）
     */
    normalization: {
      testCountCap: 100,    // Tests for full score / 满分测试词数
      newWordsCap: 20,      // New words for full score / 满分新增词数
      difficultyCap: 3,     // Avg error_count for full difficulty score / 满分难度平均错误数
    },

    /**
     * Minimum qualification thresholds
     * 参与排行榜的最低门槛
     */
    qualification: {
      minTestsPerDay: 10,   // Minimum tests to qualify / 最低测试次数
      minAccuracy: 0.0,     // Minimum accuracy (0-1, 0 = no minimum) / 最低正确率
    },

    /**
     * Display settings
     * 显示设置
     */
    display: {
      topRankCount: 100,    // Players to display / 显示玩家数量
      includeSelf: true,    // Always show current user even if below top / 始终显示当前用户
      showPercentile: true, // Show percentile calculation / 显示百分位排名
    },

    /**
     * Cache settings (for frontend)
     * 缓存设置（前端）
     */
    cache: {
      ttlSeconds: 300,      // Cache leaderboard data for 5 minutes / 缓存5分钟
      staleWhileRevalidate: true, // Show stale data while refreshing / 显示过期数据同时刷新
    },

    /**
     * Privacy settings
     * 隐私设置
     */
    privacy: {
      maskEmail: true,      // Mask email addresses / 隐藏邮箱地址
      showRankPosition: true, // Show absolute rank / 显示绝对排名
      showPercentile: true, // Show relative percentile / 显示相对百分位
    },
  },

  // ============================================
  // 9. PRONUNCIATION ASSET CONFIGURATION
  // 9. 发音资产配置
  // ============================================
  pronunciation: {
    /**
     * Uniqueness mode for global pronunciation assets
     * 全局发音资产唯一性模式
     *
     * strict（严格唯一）：
     * - 仅按“单词 + 语言”判定唯一
     * - 不考虑 voice / model / codec / bitrate 等参数
     * - 同一个词只保留 1 份音频，最大化节省存储与 API 成本
     *
     * relaxed（宽松唯一）：
     * - 按“单词 + 语言 + voice/model/格式等参数”判定唯一
     * - 允许同一个词存在多份参数版本音频
     */
    uniquenessMode: 'strict' as 'strict' | 'relaxed',

    /**
     * Manual batch replacement control
     * 手动批量语音替换控制
     * - true: 在管理面板允许手动触发“全量语音替换”
     * - false: 隐藏/禁用该入口
     */
    enableManualBatchReplacement: true,

    /**
     * Batch replacement concurrency
     * 批量替换并发数（并发越大越快，但更容易触发限流）
     */
    batchReplacementConcurrency: 3,

    /**
     * Global Minimax request rate limit (requests per minute)
     * 全局 Minimax 请求频率上限（每分钟请求数）
     */
    maxRequestsPerMinute: 20,

    /**
     * Super admin account for global replacement action
     * 全库替换仅允许此管理员邮箱触发
     */
    superAdminEmail: 'dysonfreeman@outlook.com',
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
Object.freeze(WORD_LEARNING_CONFIG.adaptiveSelection.weights);
Object.freeze(WORD_LEARNING_CONFIG.scoring);
Object.freeze(WORD_LEARNING_CONFIG.ui);
Object.freeze(WORD_LEARNING_CONFIG.ui.coverageSlider);
Object.freeze(WORD_LEARNING_CONFIG.library);
Object.freeze(WORD_LEARNING_CONFIG.debug);
Object.freeze(WORD_LEARNING_CONFIG.leaderboard);
Object.freeze(WORD_LEARNING_CONFIG.leaderboard.weights);
Object.freeze(WORD_LEARNING_CONFIG.leaderboard.normalization);
Object.freeze(WORD_LEARNING_CONFIG.leaderboard.qualification);
Object.freeze(WORD_LEARNING_CONFIG.leaderboard.display);
Object.freeze(WORD_LEARNING_CONFIG.leaderboard.cache);
Object.freeze(WORD_LEARNING_CONFIG.leaderboard.privacy);
Object.freeze(WORD_LEARNING_CONFIG.pronunciation);

/**
 * Export config with safe type casting for use in components
 * 导出配置，提供安全的类型转换供组件使用
 */
export const useWordLearningConfig = () => WORD_LEARNING_CONFIG;
