# Word Learning System - Configuration Architecture Analysis

## 📊 当前状态：参数分散且硬编码

### 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    Application (App.tsx)                      │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│TestModeV2   │    │dataService  │    │AdaptiveWord  │
│  .tsx       │    │    .ts      │    │Selector.ts   │
└──────────────┘    └──────────────┘    └──────────────┘
       │                     │                     │
       │                     │                     │
       ▼                     ▼                     ▼
   ❌ 硬编码参数:        ⚠️ 混合配置:          ❌ 硬编码参数:
   - 0.3, 0.5,        - ERROR_DECAY_     - error_count * 8
   - 0.8, 1.0          CONFIG (✅)         - Math.min(40, ...)
   - consecutive_      - error_count * 5    - temperature: 2.0
     correct >= 3       - error_count * 2    - shuffleRate: 0.3
                                              - max score: 40
                                              - max score: 15
                                              - max score: 35
```

### 问题清单

| # | 问题 | 影响 | 严重程度 |
|---|------|------|---------|
| 1 | 参数散落在 4+ 个文件中 | 难以全局调整 | 🔴 高 |
| 2 | 大量硬编码的魔术数字 | 无法理解业务逻辑 | 🔴 高 |
| 3 | 部分文件有配置，部分没有 | 不一致性 | 🟡 中 |
| 4 | 修改参数需要查找多个位置 | 开发效率低 | 🟡 中 |
| 5 | 没有类型安全 | 容易出错 | 🟢 低 |
| 6 | 配置分散，难以文档化 | 维护困难 | 🟢 低 |

---

## ✅ 目标状态：统一配置管理

### 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    Application (App.tsx)                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              │
                              ▼
                    ┌────────────────────────┐
                    │  config/                │
                    │  wordLearningConfig.ts │  ← 单一配置源！
                    └────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│TestModeV2   │    │dataService  │    │AdaptiveWord  │
│  .tsx       │    │    .ts      │    │Selector.ts   │
└──────────────┘    └──────────────┘    └──────────────┘
       │                     │                     │
       │                     │                     │
       ▼                     ▼                     ▼
   ✅ 引入配置:         ✅ 引入配置:          ✅ 引入配置:
   import {WORD_LEARNING_  import {WORD_LEARNING_  import {WORD_LEARNING_
     CONFIG}              CONFIG}              CONFIG}

   ✅ 使用配置参数:      ✅ 使用配置参数:      ✅ 使用配置参数:
   - cfg.errorTracking  - cfg.errorDecay      - cfg.adaptiveSelection
   - cfg.scoring        - cfg.scoring         - cfg.temperature
                                              - cfg.errorUrgencyMultiplier
```

### 优势清单

| # | 优势 | 实现方式 | 价值 |
|---|------|---------|------|
| 1 | **单一配置源** | 一个 `config/wordLearningConfig.ts` 文件 | 易于查找和修改 |
| 2 | **类型安全** | TypeScript `typeof` + `as const` | 编译时检查 |
| 3 | **文档化** | 每个参数都有详细注释 | 自文档化 |
| 4 | **运行时保护** | `Object.freeze()` | 防止意外修改 |
| 5 | **易于实验** | 修改配置即可调整行为 | 快速 A/B 测试 |
| 6 | **开发效率** | IDE 自动完成 | 减少错误 |

---

## 🔍 详细对比

### 配置分布对比

#### ❌ 当前：参数分散

```
📂 components/TestModeV2.tsx (Line 530)
  errorCountDelta = 0.3;

📂 components/TestModeV2.tsx (Line 532)
  errorCountDelta = 0.5;

📂 components/TestModeV2.tsx (Line 534)
  errorCountDelta = 0.8;

📂 components/TestModeV2.tsx (Line 536)
  errorCountDelta = 1.0;

📂 components/TestModeV2.tsx (Line 587)
  if (newConsecutiveCorrect >= 3) ...

📂 services/dataService.ts (Line 536)
  threshold: 3

📂 services/dataService.ts (Line 748)
  score = (w.error_count * 5)

📂 services/adaptiveWordSelector.ts (Line 25)
  temperature: 2.0

📂 services/adaptiveWordSelector.ts (Line 87)
  errorUrgency = Math.min(40, w.error_count * 8)

📂 services/adaptiveWordSelector.ts (Line 95)
  freshnessBonus = Math.min(15, ...)
```

#### ✅ 目标：统一配置

```
📂 config/wordLearningConfig.ts
  export const WORD_LEARNING_CONFIG = {
    errorTracking: {
      completeFailurePenalty: 1.0,      ← 统一定义
      hintPenalties: {
        zeroErrors: 0.3,              ← 统一定义
        oneError: 0.5,               ← 统一定义
        twoErrors: 0.8,               ← 统一定义
        threePlusErrors: 1.0,         ← 统一定义
      }
    },
    errorDecay: {
      consecutiveCorrectThreshold: 3,  ← 统一定义
      decrementAmount: 1.0,             ← 统一定义
    },
    adaptiveSelection: {
      errorUrgencyMultiplier: 8,        ← 统一定义
      maxErrorUrgencyScore: 40,         ← 统一定义
      softmaxTemperature: 2.0,           ← 统一定义
      shuffleRate: 0.3,                  ← 统一定义
      maxFreshnessBonusScore: 15,        ← 统一定义
      maxForgettingRiskScore: 35,        ← 统一定义
    },
    scoring: {
      fullScore: 3.0,                    ← 统一定义
      hintModeScore: 1.5,                ← 统一定义
      zeroScore: 0,                       ← 统一定义
    }
  } as const;
```

---

## 💡 使用场景示例

### 场景 1: A/B 测试不同的衰减速度

```typescript
// config/wordLearningConfig.ts
export const EXPERIMENT_CONFIG_V1 = {
  ...WORD_LEARNING_CONFIG,
  errorDecay: {
    consecutiveCorrectThreshold: 2,  // 更激进
    decrementAmount: 1.5,
  }
} as const;

export const EXPERIMENT_CONFIG_V2 = {
  ...WORD_LEARNING_CONFIG,
  errorDecay: {
    consecutiveCorrectThreshold: 5,  // 更保守
    decrementAmount: 0.5,
  }
} as const;

// 在应用中切换
const activeConfig = Math.random() > 0.5
  ? EXPERIMENT_CONFIG_V1
  : EXPERIMENT_CONFIG_V2;
```

### 场景 2: 用户自定义学习难度

```typescript
// 根据用户设置动态调整配置
const getUserConfig = (difficulty: 'easy' | 'medium' | 'hard') => {
  const multipliers = {
    easy: { errorDecay: 0.5, urgency: 0.5 },
    medium: { errorDecay: 1.0, urgency: 1.0 },
    hard: { errorDecay: 1.5, urgency: 1.5 },
  };

  return {
    ...WORD_LEARNING_CONFIG,
    errorDecay: {
      ...WORD_LEARNING_CONFIG.errorDecay,
      consecutiveCorrectThreshold: Math.round(
        WORD_LEARNING_CONFIG.errorDecay.consecutiveCorrectThreshold
        / multipliers[difficulty].errorDecay
      ),
    },
    adaptiveSelection: {
      ...WORD_LEARNING_CONFIG.adaptiveSelection,
      errorUrgencyMultiplier: Math.round(
        WORD_LEARNING_CONFIG.adaptiveSelection.errorUrgencyMultiplier
        * multipliers[difficulty].urgency
      ),
    },
  };
};
```

---

## 📋 迁移路线图

### Phase 1: 创建配置文件 ✅
- [x] 创建 `config/wordLearningConfig.ts`
- [x] 定义所有配置项
- [x] 添加详细注释

### Phase 2: 重构核心文件 (待执行)
- [ ] 重构 `TestModeV2.tsx`
- [ ] 重构 `dataService.ts`
- [ ] 重构 `adaptiveWordSelector.ts`

### Phase 3: 验证和测试 (待执行)
- [ ] 单元测试
- [ ] 集成测试
- [ ] 行为一致性测试

### Phase 4: 清理旧代码 (待执行)
- [ ] 删除旧的 `ERROR_DECAY_CONFIG`
- [ ] 更新文档
- [ ] 代码审查

---

## 🎯 总结

### 当前状态

```
❌ 参数分散在 4+ 个文件
❌ 硬编码魔术数字无处不在
❌ 没有类型安全保障
❌ 修改参数需要查找多个位置
❌ 难以进行实验和优化
```

### 目标状态

```
✅ 单一配置文件
✅ 所有参数集中管理
✅ TypeScript 类型安全
✅ 运行时保护 (Object.freeze)
✅ 易于实验和 A/B 测试
✅ 良好的文档化
✅ 开发效率提升
```

---

## 📚 推荐阅读

- [12-Factor App: Config](https://12factor.net/config)
- [React Config Pattern](https://blog.logrocket.com/building-scalable-react-apps-the-config-component-pattern/)
- [TypeScript Configuration Files](https://www.typescriptlang.org/docs/handbook/declaration-files.html)
