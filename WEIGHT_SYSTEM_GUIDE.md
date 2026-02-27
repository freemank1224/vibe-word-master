# 单词选择权重系统使用指南

## 📖 概述

新的权重系统使用**百分比配置**代替原有的绝对分数值，使单词选择算法的调节更加直观和灵活。

## 🎯 核心优势

- ✅ **直观配置**：直接使用百分比（如 45:40:15）
- ✅ **自动归一化**：输入任意值，系统自动调整为100%
- ✅ **灵活调节**：轻松调整不同因素的权重
- ✅ **调试友好**：启动时输出完整的权重信息到控制台

## ⚙️ 配置方法

### 位置
文件：`config/wordLearningConfig.ts` (第88-123行)

### 默认配置
```typescript
adaptiveSelection: {
  weights: {
    errorUrgency: 45,      // 错误紧急度权重：45%
    forgettingRisk: 40,    // 遗忘风险权重：40%
    freshnessBonus: 15,    // 新鲜度奖励权重：15%
  },
  baseScoreScale: 100,     // 基础分数缩放：总分100分
}
```

## 📊 三种因素详解

### 1️⃣ **错误紧急度** (errorUrgency)
- **基于**：`error_count`（错误计数）
- **说明**：错误越多的单词，优先级越高
- **推荐范围**：30-60%

**示例影响**：
- `error_count = 0.0`（完美）→ 低优先级
- `error_count = 0.5`（中等困难）→ 中优先级
- `error_count = 2.0+`（严重困难）→ 高优先级

### 2️⃣ **遗忘风险** (forgettingRisk)
- **基于**：距离上次测试的天数
- **说明**：越久没复习的单词，优先级越高
- **推荐范围**：20-50%

**示例影响**：
- 1天内测试过 → 低优先级
- 7天内测试过 → 中优先级
- 30天+未测试 → 高优先级

### 3️⃣ **新鲜度奖励** (freshnessBonus)
- **基于**：长时间未测试的单词
- **说明**：避免旧单词被永久忽略
- **推荐范围**：5-20%

**示例影响**：
- 激励系统选择那些"既不困难也不紧急，但很久没见"的单词

## 🔧 常用配置场景

### 场景1：重视近期错误（推荐给初学者）
```typescript
weights: {
  errorUrgency: 50,      // 增加错误权重
  forgettingRisk: 35,
  freshnessBonus: 15,
}
```
**效果**：优先复习最近犯错的单词，快速巩固薄弱点

### 场景2：平衡型（默认配置）
```typescript
weights: {
  errorUrgency: 45,
  forgettingRisk: 40,
  freshnessBonus: 15,
}
```
**效果**：错误、遗忘、新鲜度三者平衡

### 场景3：重视长期记忆（推荐给进阶者）
```typescript
weights: {
  errorUrgency: 35,      // 降低错误权重
  forgettingRisk: 50,    // 增加遗忘权重
  freshnessBonus: 15,
}
```
**效果**：按照遗忘曲线优先级，更科学地安排复习

### 场景4：极端重视错误（应试突击）
```typescript
weights: {
  errorUrgency: 70,
  forgettingRisk: 25,
  freshnessBonus: 5,
}
```
**效果**：几乎只关注错误单词，忽略其他因素

### 场景5：随意输入（自动归一化）
```typescript
weights: {
  errorUrgency: 3,       // 输入任意值
  forgettingRisk: 4,
  freshnessBonus: 2,
}
```
**实际效果**：
- 总和：3+4+2=9
- 归一化后：errorUrgency=33.3%, forgettingRisk=44.4%, freshnessBonus=22.2%

## 🔍 调试输出

启动应用后，控制台会显示权重初始化信息：

```javascript
[AdaptiveWordSelector] Initialized with weights: {
  input: { errorUrgency: 45, forgettingRisk: 40, freshnessBonus: 15 },
  normalized: {
    errorUrgency: 0.45,    // 45%
    forgettingRisk: 0.40,  // 40%
    freshnessBonus: 0.15   // 15%
  },
  maxScores: {
    maxErrorUrgencyScore: 45,      // 最大分数：45分
    maxForgettingRiskScore: 40,    // 最大分数：40分
    maxFreshnessBonusScore: 15     // 最大分数：15分
  }
}
```

## ⚠️ 注意事项

1. **权重为0**：如果某个因子权重为0，该因子将完全不影响单词选择
2. **全部为0**：如果所有权重都为0，系统会自动使用平均分布（33.3% : 33.3% : 33.3%）
3. **单一权重100**：如果某个因子权重为100，其他因子将完全被忽略
4. **分数范围**：最大分数会根据权重动态计算，不再固定为40/35/15

## 🔄 从旧系统迁移

### 旧系统（已弃用）
```typescript
// ❌ 旧方式：不直观
maxErrorUrgencyScore: 40,
maxForgettingRiskScore: 35,
maxFreshnessBonusScore: 15,
```

### 新系统（推荐）
```typescript
// ✅ 新方式：直观易懂
weights: {
  errorUrgency: 45,    // 45%
  forgettingRisk: 40,  // 40%
  freshnessBonus: 15,  // 15%
}
```

## 📈 实际效果示例

假设单词A：`error_count=2.0`, 10天未测试

**配置1：默认（45:40:15）**
- 错误紧急度：min(45, 2.0×8) = 16分
- 遗忘风险：约34.6分
- 新鲜度奖励：5分
- **总分**：55.6分

**配置2：增加错误权重（50:35:15）**
- 错误紧急度：min(50, 2.0×8) = 16分
- 遗忘风险：约30.3分（35/40 × 34.6）
- 新鲜度奖励：5分
- **总分**：51.3分

**差异**：配置2相对降低了遗忘风险的影响，更注重错误本身

## 🛠️ 高级调优技巧

### 技巧1：观察学习曲线
- 如果觉得复习太难 → 增加 `forgettingRisk`
- 如果觉得复习太简单 → 增加 `errorUrgency`

### 技巧2：周期性调整
- **初期学习**：高错误权重（50:35:15）
- **中期巩固**：平衡配置（45:40:15）
- **长期维护**：高遗忘权重（35:50:15）

### 技巧3：个性化配置
```typescript
// 容易忘记的用户
weights: { errorUrgency: 35, forgettingRisk: 50, freshnessBonus: 15 }

// 粗心用户（经常小错）
weights: { errorUrgency: 55, forgettingRisk: 30, freshnessBonus: 15 }

// 稳健用户（很少出错）
weights: { errorUrgency: 30, forgettingRisk: 50, freshnessBonus: 20 }
```

## 📞 获取帮助

如有问题或建议，请：
1. 查看控制台的调试输出
2. 阅读源码：`services/adaptiveWordSelector.ts`
3. 参考配置文件：`config/wordLearningConfig.ts`

---

**版本**：v1.0
**更新日期**：2026-02-26
**作者**：Claude Code Assistant
