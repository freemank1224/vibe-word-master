# Configuration Refactoring Guide

## 概述

当前代码中的关键参数散落在各个文件中，不符合"配置与逻辑分离"的最佳实践。本指南展示如何将这些硬编码参数迁移到统一的配置文件 `config/wordLearningConfig.ts`。

---

## 📊 当前状态分析

### ❌ 问题：参数分散且硬编码

```
📂 components/TestModeV2.tsx
  └─ errorCountDelta: 0.3, 0.5, 0.8, 1.0 (硬编码)
  └─ consecutive_correct >= 3 (硬编码)

📂 services/dataService.ts
  └─ ERROR_DECAY_CONFIG ✅ (已有配置)
  └─ error_count * 5 (硬编码)
  └─ error_count * 2 (硬编码)

📂 services/adaptiveWordSelector.ts
  └─ temperature: 2.0 ✅ (已有配置)
  └─ error_count * 8 (硬编码)
  └─ Math.min(40, ...) (硬编码)

📂 components/LibrarySelector.tsx
  └─ COMPLETENESS_THRESHOLD = 90 (常量，非配置)
```

---

## ✅ 目标架构

### 统一配置文件结构

```
📂 config/wordLearningConfig.ts
  ├─ errorTracking (错误追踪参数)
  │   ├─ completeFailurePenalty: 1.0
  │   └─ hintPenalties: { zeroErrors: 0.3, oneError: 0.5, ... }
  │
  ├─ errorDecay (错误衰减参数)
  │   ├─ consecutiveCorrectThreshold: 3
  │   └─ decrementAmount: 1.0
  │
  ├─ adaptiveSelection (自适应选择参数)
  │   ├─ errorUrgencyMultiplier: 8
  │   ├─ softmaxTemperature: 2.0
  │   └─ shuffleRate: 0.3
  │
  └─ scoring (评分系统参数)
      ├─ fullScore: 3.0
      └─ hintModeScore: 1.5
```

---

## 🔧 重构示例

### 示例 1: TestModeV2.tsx

#### ❌ 重构前（硬编码）

```typescript
// components/TestModeV2.tsx

if (score === 0) {
  errorCountDelta = 1.0;  // 硬编码！
} else if (hasUsedHintSnapshot) {
  if (currentHintAttemptsSnapshot === 0) {
    errorCountDelta = 0.3;  // 硬编码！
  } else if (currentHintAttemptsSnapshot === 1) {
    errorCountDelta = 0.5;  // 硬编码！
  } else if (currentHintAttemptsSnapshot === 2) {
    errorCountDelta = 0.8;  // 硬编码！
  } else {
    errorCountDelta = 1.0;  // 硬编码！
  }
}

if (newConsecutiveCorrect >= 3 && updatedErrorCount > 0) {
  // 硬编码的阈值 3！
}
```

#### ✅ 重构后（使用配置）

```typescript
// components/TestModeV2.tsx

import { WORD_LEARNING_CONFIG } from '../config/wordLearningConfig';

// 1. 错误追踪
if (score === 0) {
  errorCountDelta = WORD_LEARNING_CONFIG.errorTracking.completeFailurePenalty;
} else if (hasUsedHintSnapshot) {
  const hintPenalties = WORD_LEARNING_CONFIG.errorTracking.hintPenalties;

  if (currentHintAttemptsSnapshot === 0) {
    errorCountDelta = hintPenalties.zeroErrors;
  } else if (currentHintAttemptsSnapshot === 1) {
    errorCountDelta = hintPenalties.oneError;
  } else if (currentHintAttemptsSnapshot === 2) {
    errorCountDelta = hintPenalties.twoErrors;
  } else {
    errorCountDelta = hintPenalties.threePlusErrors;
  }
}

// 2. 错误衰减
const threshold = WORD_LEARNING_CONFIG.errorDecay.consecutiveCorrectThreshold;

if (newConsecutiveCorrect >= threshold && updatedErrorCount > 0) {
  updatedErrorCount = Math.max(0, updatedErrorCount -
    WORD_LEARNING_CONFIG.errorDecay.decrementAmount);
  newConsecutiveCorrect = 0;
}
```

---

### 示例 2: adaptiveWordSelector.ts

#### ❌ 重构前（硬编码）

```typescript
// services/adaptiveWordSelector.ts

private config = {
  temperature: 2.0,
  shuffleRate: 0.3,
};

private calculateUrgency(word: WordEntry): number {
  // 硬编码的魔术数字！
  const errorUrgency = Math.min(40, word.error_count * 8);

  const forgettingRisk = this.calculateForgettingRisk(daysSinceTested, word.error_count);

  // 硬编码的魔术数字！
  const freshnessBonus = Math.min(15, daysSinceTested * 0.5);

  return errorUrgency + forgettingRisk + freshnessBonus;
}
```

#### ✅ 重构后（使用配置）

```typescript
// services/adaptiveWordSelector.ts

import { WORD_LEARNING_CONFIG } from '../config/wordLearningConfig';

// 使用配置中的值
private config = {
  temperature: WORD_LEARNING_CONFIG.adaptiveSelection.softmaxTemperature,
  shuffleRate: WORD_LEARNING_CONFIG.adaptiveSelection.shuffleRate,
};

private calculateUrgency(word: WordEntry): number {
  const cfg = WORD_LEARNING_CONFIG.adaptiveSelection;

  // 从配置读取
  const errorUrgency = Math.min(
    cfg.maxErrorUrgencyScore,
    word.error_count * cfg.errorUrgencyMultiplier
  );

  const forgettingRisk = this.calculateForgettingRisk(daysSinceTested, word.error_count);

  // 从配置读取
  const freshnessBonus = Math.min(
    cfg.maxFreshnessBonusScore,
    daysSinceTested * 0.5
  );

  return errorUrgency + forgettingRisk + freshnessBonus;
}
```

---

### 示例 3: dataService.ts

#### ❌ 重构前（混合）

```typescript
// services/dataService.ts

// ✅ 有配置对象
const ERROR_DECAY_CONFIG = {
  threshold: 3,
  decrementAmount: 1
};

// ❌ 但其他参数硬编码
const score = (w.error_count * 5) + daysSinceLast;
const valA = (a.error_count * 2) + Math.random() * 10;
```

#### ✅ 重构后（统一使用配置）

```typescript
// services/dataService.ts

import { WORD_LEARNING_CONFIG } from '../config/wordLearningConfig';

// 删除旧的 ERROR_DECAY_CONFIG，统一使用 WORD_LEARNING_CONFIG

// 使用配置中的值
const cfg = WORD_LEARNING_CONFIG.adaptiveSelection;
const score = (w.error_count * cfg.legacyErrorWeight) + daysSinceLast;
const valA = (a.error_count * 2) + Math.random() * cfg.legacyRandomBonus;
```

---

## 📋 重构清单

### 需要重构的文件

| 文件 | 重构优先级 | 影响的参数 | 状态 |
|------|-----------|-----------|------|
| ✅ `config/wordLearningConfig.ts` | - | 已创建 | ✅ 完成 |
| 🔴 `components/TestModeV2.tsx` | 高 | errorCountDelta, threshold | ✅ 完成 |
| 🟡 `services/dataService.ts` | 高 | ERROR_DECAY_CONFIG, error_count × 5/2 | ✅ 完成 |
| 🟡 `services/adaptiveWordSelector.ts` | 中 | error_count × 8, max scores | ✅ 完成 |
| 🟢 `components/LibrarySelector.tsx` | 低 | COMPLETENESS_THRESHOLD | ✅ 完成 |

---

## ✅ 重构完成总结

### 完成日期
2026-02-23

### 重构详情

1. **TestModeV2.tsx**
   - 导入 `WORD_LEARNING_CONFIG`
   - 替换 `errorCountDelta` 硬编码值 (0.3, 0.5, 0.8, 1.0) 为 `errorTracking.hintPenalties`
   - 替换 `completeFailurePenalty` 硬编码值 (1.0)
   - 替换错误衰减阈值硬编码 (3) 为 `errorDecay.consecutiveCorrectThreshold`
   - 替换错误衰减量硬编码 (1) 为 `errorDecay.decrementAmount`

2. **dataService.ts**
   - 导入 `WORD_LEARNING_CONFIG`
   - 删除旧的 `ERROR_DECAY_CONFIG` 常量
   - 替换 `error_count * 5` 为 `adaptiveSelection.legacyErrorWeight`
   - 替换 `error_count * 2` 为保持兼容
   - 替换 `Math.random() * 10` 为 `adaptiveSelection.legacyRandomBonus`
   - 替换默认天数 (30) 为 `adaptiveSelection.defaultDaysSinceLastTest`
   - 添加调试日志条件判断

3. **adaptiveWordSelector.ts**
   - 导入 `WORD_LEARNING_CONFIG`
   - 替换 `temperature: 2.0` 为 `adaptiveSelection.softmaxTemperature`
   - 替换 `shuffleRate: 0.3` 为 `adaptiveSelection.shuffleRate`
   - 替换 `error_count * 8` 为 `adaptiveSelection.errorUrgencyMultiplier`
   - 替换最大错误紧急度 (40) 为 `adaptiveSelection.maxErrorUrgencyScore`
   - 替换最大新鲜度奖励 (15) 为 `adaptiveSelection.maxFreshnessBonusScore`
   - 替换默认天数 (30) 为 `adaptiveSelection.defaultDaysSinceLastTest`
   - 替换最大遗忘风险 (35) 为 `adaptiveSelection.maxForgettingRiskScore`

4. **LibrarySelector.tsx**
   - 导入 `WORD_LEARNING_CONFIG`
   - 替换 `COMPLETENESS_THRESHOLD = 90` 为 `library.completenessThreshold`

### 向后兼容性
✅ 所有默认值保持一致，确保功能行为无变化

### 优势总结
- ✅ 单一配置源
- ✅ 类型安全
- ✅ 运行时保护
- ✅ 易于实验
- ✅ 文档化

### 重构步骤

1. **导入配置**
   ```typescript
   import { WORD_LEARNING_CONFIG } from '../config/wordLearningConfig';
   ```

2. **替换硬编码值**
   - 查找配置中的对应参数
   - 替换硬编码为配置引用

3. **测试验证**
   - 运行现有测试
   - 验证行为一致

4. **删除旧配置**
   - 删除 `ERROR_DECAY_CONFIG`
   - 删除旧的 `config` 对象

---

## 🎯 配置修改示例

### 场景 1: 让错误衰减更快

```typescript
// config/wordLearningConfig.ts
errorDecay: {
  consecutiveCorrectThreshold: 2,  // 从 3 改为 2
  decrementAmount: 1.5,             // 从 1 改为 1.5
}
```

### 场景 2: 让高错误率单词更突出

```typescript
// config/wordLearningConfig.ts
adaptiveSelection: {
  errorUrgencyMultiplier: 12,  // 从 8 改为 12
  maxErrorUrgencyScore: 50,     // 从 40 改为 50
}
```

### 场景 3: 调整提示惩罚梯度

```typescript
// config/wordLearningConfig.ts
errorTracking: {
  hintPenalties: {
    zeroErrors: 0.2,   // 从 0.3 改为 0.2 (更宽容)
    oneError: 0.4,     // 从 0.5 改为 0.4
    twoErrors: 0.7,    // 从 0.8 改为 0.7
    threePlusErrors: 1.0,  // 保持不变
  },
}
```

---

## ✅ 优势

### 1. **单一配置源**
   - 所有参数在一个文件中
   - 易于查找和修改

### 2. **类型安全**
   - TypeScript 类型检查
   - 编译时错误检测

### 3. **运行时保护**
   - `Object.freeze()` 防止意外修改
   - 配置在应用生命周期内保持不变

### 4. **易于实验**
   - 快速调整参数
   - A/B 测试不同配置

### 5. **文档化**
   - 每个参数都有详细注释
   - 说明默认值和影响范围

---

## 🚀 快速开始

### 1. 查看当前配置
```bash
cat config/wordLearningConfig.ts
```

### 2. 修改配置
```typescript
// 编辑配置文件
nano config/wordLearningConfig.ts
```

### 3. 重构代码
按照本文档的示例，逐个文件重构。

### 4. 验证
```bash
npm run test
npm run dev
```

---

## 📝 注意事项

1. **向后兼容**
   - 重构时保持默认值一致
   - 确保行为不发生意外变化

2. **渐进式重构**
   - 优先重构高优先级文件
   - 每次重构后进行测试

3. **版本控制**
   - 提交前记录配置修改
   - 便于回滚和对比

---

## 🔗 相关文件

- [x] `config/wordLearningConfig.ts` - 主配置文件 ✅
- [x] `components/TestModeV2.tsx` - 已重构 ✅
- [x] `services/dataService.ts` - 已重构 ✅
- [x] `services/adaptiveWordSelector.ts` - 已重构 ✅
- [x] `components/LibrarySelector.tsx` - 已重构 ✅

---

## 📚 参考资料

- [Config Pattern Best Practices](https://blog.logrocket.com/building-scalable-react-apps-the-config-component-pattern/)
- [TypeScript Deep Dive](https://www.typescriptlang.org/docs/handbook/declaration-files.html)
- [Software Configuration Management](https://12factor.net/config)
