# Smart Selection 智能选词功能说明

## 📋 功能概述

**Smart Selection Assistant**（智能选词助手）提供两种单词选择模式：
- 🎲 **随机模式**：从用户勾选的词中随机选择
- 🧠 **智能模式**：从用户勾选的词中智能选择（优先选难词）

---

## 🎯 核心原则

### ✅ 绝对遵守的原则

**所有测试单词必须来自用户勾选的范围！**

- ✅ 只从 `availablePool`（用户勾选的词）中选择
- ❌ 绝不从未勾选的词中选择
- ❌ 不突破用户勾选的范围

---

## 💡 工作流程

### 用户操作流程

1. **用户勾选单词** → 在词库中勾选想要测试的单词
2. **设置覆盖率** → 拖动 TEST COVERAGE 滑杆（1-100%）
3. **系统计算目标** → `目标数量 = 勾选数 × 覆盖率`
4. **执行采样** → 根据开关状态选择采样算法

### 实际案例

#### 案例1：充足勾选
```
用户勾选：100个词
覆盖率：50%
目标数量：100 × 50% = 50个

🎲 随机模式：从100个勾选词中随机选50个
🧠 智能模式：从100个勾选词中智能选50个（优先选错误多、遗忘风险高的）
```

#### 案例2：少量勾选
```
用户勾选：30个词
覆盖率：50%
目标数量：30 × 50% = 15个

🎲 随机模式：从30个勾选词中随机选15个
🧠 智能模式：从30个勾选词中智能选15个
```

#### 案例3：全覆盖
```
用户勾选：50个词
覆盖率：100%
目标数量：50 × 100% = 50个

🎲 随机模式：从50个勾选词中随机选50个（全部）
🧠 智能模式：从50个勾选词中智能选50个（全部，按优先级排序）
```

---

## 🔧 采样算法对比

### 🎲 随机模式（开关关闭）

```typescript
// 完全随机打乱，取前N个
const shuffled = [...availablePool].sort(() => Math.random() - 0.5);
const randomQueue = shuffled.slice(0, targetCount);
```

**特点**：
- ✅ 完全随机，无偏好
- ✅ 简单直接
- ❌ 不考虑单词难度
- ❌ 不考虑遗忘情况

### 🧠 智能模式（开关打开）

```typescript
// 使用自适应算法，综合考虑三个维度
const smartQueue = adaptiveWordSelector.calculateQueue(
    allWords,
    availablePool,
    targetCount,
    sessions
);
```

**特点**：
- ✅ 优先选择错误多的词（error_count 高）
- ✅ 优先选择遗忘风险高的词（很久没复习）
- ✅ 平衡新鲜度（避免旧词被永久忽略）
- ✅ 使用概率选择，避免完全可预测

**智能算法评分**（总分100分）：
- **错误紧急度**（45分）：基于 error_count
- **遗忘风险**（40分）：基于距离上次测试的天数
- **新鲜度奖励**（15分）：长时间未测试的词获得加分

---

## 📊 权重配置

用户可以在 **[config/wordLearningConfig.ts](config/wordLearningConfig.ts:95-122)** 中调整权重：

```typescript
adaptiveSelection: {
  weights: {
    errorUrgency: 45,      // 错误紧急度权重（%）
    forgettingRisk: 40,    // 遗忘风险权重（%）
    freshnessBonus: 15,    // 新鲜度奖励权重（%）
  },
}
```

**调整示例**：
- 重视错误 → `50:35:15`
- 重视遗忘 → `35:50:15`
- 完全平衡 → `33:33:34`

详见：[WEIGHT_SYSTEM_GUIDE.md](WEIGHT_SYSTEM_GUIDE.md)

---

## 📝 控制台日志

### 随机模式
```javascript
🎲 [TestMode] Using Random Selection...
✓ Selected 50 words from 100 checked words (50% coverage)
```

### 智能模式
```javascript
🧠 [TestMode] Using Smart Selection (adaptive algorithm)...
✓ Selected 50 words from 100 checked words (50% coverage)
```

---

## 🆚 模式对比

| 特性 | 随机模式 | 智能模式 |
|------|-------------------|-------------------|
| **选择范围** | 仅限勾选词 | 仅限勾选词 |
| **选择策略** | 完全随机 | 智能算法（错误+遗忘+新鲜度） |
| **优先级** | 无 | 高错误/高遗忘优先 |
| **可预测性** | 完全随机 | 概率加权，有一定随机性 |
| **适用场景** | 想要完全随机 | 想要科学复习 |

---

## ✅ 验证清单

- ✅ 只从用户勾选的词中选择
- ✅ 目标数量 = 勾选数 × 覆盖率
- ✅ 不突破勾选范围
- ✅ 智能算法考虑错误、遗忘、新鲜度
- ✅ 权重可自由配置

---

## 📞 相关文档

- **权重系统指南**：[WEIGHT_SYSTEM_GUIDE.md](WEIGHT_SYSTEM_GUIDE.md)
- **配置文件**：[config/wordLearningConfig.ts](config/wordLearningConfig.ts)
- **算法实现**：[services/adaptiveWordSelector.ts](services/adaptiveWordSelector.ts)
- **改造记录**：[SMART_SELECTION_MIGRATION.md](SMART_SELECTION_MIGRATION.md)

---

**版本**：v2.0
**更新日期**：2026-02-27
