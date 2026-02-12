# 词组验证功能 - 完整设计文档

**创建日期**：2026-02-12
**版本**：1.0

---

## 📋 目录

1. [问题背景](#问题背景)
2. [核心需求](#核心需求)
3. [设计决策](#设计决策)
4. [技术方案](#技术方案)
5. [AI优雅降级](#ai优雅降级)
6. [实施步骤](#实施步骤)
7. [测试验证](#测试验证)

---

## 问题背景

### 用户痛点

当前单词验证系统不支持词组输入。当用户输入 **"go cycling"** 时：

```
输入 "go cycling"
    ↓
系统验证失败 ❌
    ↓
原因：
    1. 本地字典（Hunspell）只验证单个单词
    2. 将整个词组当作一个"单词"处理
    3. 只能依赖AI验证回退方案
```

### 问题总结

| 问题 | 影响 |
|------|------|
| 本地验证失败 | 词组无法离线验证 |
| 频繁调用AI | 增加延迟（2-5秒）和成本 |
| 用户体验差 | 输入常见词组仍需等待API |

### 典型场景

用户输入以下内容时，系统无法识别：
- "go cycling" ✅ 应该通过
- "take part in" ✅ 应该通过
- "come cycling" ❌ 拼写正确但不是常见搭配
- "New York" ✅ 专有名词词组

---

## 核心需求

### 功能需求

1. ✅ **支持词组输入**
   - 识别用户输入的2-3个单词组合
   - 对每个单词进行拼写验证
   - 对词组搭配合理性进行判断

2. ✅ **本地优先**
   - 优先使用本地字典验证
   - 减少API调用，提升响应速度
   - 支持离线使用

3. ✅ **智能反馈**
   - 高亮显示错误单词（如 "go [cyclling]"）
   - 提供纠正建议
   - 对不常见搭配给出警告

4. ✅ **AI服务解耦**
   - 不依赖单一AI服务
   - 支持多种Provider
   - AI不可用时优雅降级

### 非需求

- ❌ 不验证语法正确性（如 "go cycling" vs "going cycling"）
- ❌ 不验证习语完整性（如 "kick the bucket" 每个词都正确但不验证习语）
- ❌ 不支持连字符词组（如 state-of-the-art, mother-in-law）

---

## 设计决策

### 决策1：词组长度限制

**选择**：支持 **2-3个单词** 的词组

**理由**：
- ✅ 覆盖大部分常用短语
- ✅ 避免用户输入长句
- ✅ 3词组合更可能是合理搭配

**超出限制**：提示用户 "Please enter 2-3 words only"

---

### 决策2：搭配合理性验证

**问题**："come cycling" → 每个单词拼写正确，但不是合理搭配

**方案**：对**2词词组**添加AI搭配验证

**流程**：
```
输入 "go cycling"
    ↓
【步骤1】验证拼写
    ├─ "go" ✅
    └─ "cycling" ✅
    ↓
【步骤2】AI判断搭配（仅2词）
    ├─ "go cycling" ✅ 常见搭配 → 通过
    ├─ "come cycling" ⚠️ 不常见 → 警告用户
    └─ AI失败 → 降级：允许用户选择
    ↓
【步骤3】3词词组
    └─ 单词都正确 → 直接通过（更可能是合理的）
```

**用户体验**：
- 显示警告："come cycling" 可能不是常用搭配
- 提供建议："Did you mean: go cycling?"
- 提供"强制添加"按钮，让用户决定

---

### 决策3：错误提示方式

**选择**：**高亮显示错误单词**

**示例**：
- 输入 "go cyclling" → 显示 `"go [cyclling]"`
- 输入 "gooo cyclling" → 显示 `"[gooo] [cyclling]"`

**对比方案**：
| 方案 | 优点 | 缺点 |
|------|------|------|
| 显示整个词组错误 | 简单 | 不够精确 |
| **高亮错误单词** ✅ | **精确定位** | 需要额外逻辑 |
| 分别显示每个错误 | 详细 | 占用空间大 |

---

### 决策4：AI服务配置

**需求**：不依赖单一服务，支持多种Provider

**选择**：支持 **Gemini** + **OpenAI兼容**

**配置位置**：用户信息编辑区的 **Neural Interface** 部分

**UI设计**：
```
Neural Interface
┌─────────────────────────────────────┐
│ AI Smart Selection        [开关]   │
├─────────────────────────────────────┤
│ ▼ 展开 AI 配置面板             │
│                                  │
│ AI Provider: [Google Gemini ▼]   │
│ API Key:    [••••••••••••]      │
│ Base URL:    [https://...] (可选)  │
│                                  │
│ ✓ Connected  [Test Connection]       │
└─────────────────────────────────────┘
```

**持久化**：配置保存到 `localStorage`，下次打开自动加载

---

## 技术方案

### 架构设计

```
用户输入 "go cycling"
    ↓
【Layer 1】本地验证（localProvider.ts）
    ├─ 分词：["go", "cycling"]
    ├─ 验证拼写：都正确 ✅
    └─ 2词 → 返回 needsCollocationCheck: true
    ↓
【Layer 2】搭配验证（AI Provider）
    ├─ 检查AI是否可用
    ├─ 可用 → 调用AI验证搭配
    │   ├─ 5秒超时保护
    │   ├─ "go cycling" → isCommon: true ✅
    │   └─ "come cycling" → isCommon: false ⚠️
    └─ 不可用 → 降级：假设合理 ✅
    ↓
【Layer 3】UI反馈（App.tsx）
    ├─ 搭配不常见 → 显示警告
    ├─ 提供建议 → "go cycling"
    └─ "强制添加"按钮 → 让用户决定
```

---

### 核心组件

#### 1. LocalProvider 扩展

**文件**：`/services/ai/localProvider.ts`

**新增方法**：
```typescript
private async validatePhrase(phrase: string): Promise<SpellingResult> {
  const words = phrase.split(/\s+/).filter(w => w.length > 0);

  // 1. 长度检查（2-3个单词）
  if (words.length < 2 || words.length > 3) {
    return { found: false, isValid: false, error: 'TOO_MANY_WORDS' };
  }

  // 2. 验证每个单词拼写
  const results = words.map(w => ({
    word: w,
    isValid: this.spell!.correct(w) || this.spell!.correct(w.toLowerCase())
  }));

  // 3. 有拼写错误 → 返回高亮建议
  if (results.some(r => !r.isValid)) {
    return {
      isValid: false,
      highlightedPhrase: results.map(r => r.isValid ? r.word : `[${r.word}]`).join(' '),
      suggestion: /* 为每个错误词提供建议 */
    };
  }

  // 4. 2词词组 → 需要搭配验证
  if (words.length === 2) {
    return { isValid: true, needsCollocationCheck: true };
  }

  // 5. 3词词组 → 直接通过
  return { isValid: true };
}
```

---

#### 2. AI服务抽象

**文件**：`/services/ai/index.ts`

**核心逻辑**：
```typescript
export class AIService {
  private gemini: GeminiProvider;
  private openai: OpenAIProvider;    // 新增
  private enabled: boolean = false;
  private available: boolean = false;

  // ✅ 优雅降级
  async validateCollocation(phrase: string) {
    if (!this.enabled || !this.available) {
      console.log('AI unavailable, assuming phrase is valid');
      return { isCommon: true }; // 降级策略
    }

    try {
      // ✅ 5秒超时保护
      const result = await Promise.race([
        this.provider.validateCollocation(phrase),
        new Promise((_, reject) => setTimeout(() => reject({ isCommon: true }), 5000)
      ]);
      return result;
    } catch (error) {
      console.error('Collocation check failed:', error);
      return { isCommon: true }; // 保守降级
    }
  }
}
```

---

#### 3. SM-2算法降级

**新建文件**：`/utils/sm2Algorithm.ts`

**用途**：当AI不可用时，使用科学算法计算复习间隔

**核心公式**：
```
I(1) = 0
I(n) = I(n-1) × EF

EF = 2.5（初始易度因子）
质量评分 ≥ 3: EF += (0.1 - (5-质量) × 0.08)
质量评分 < 3: 重置 repetitions = 0, interval = 1
```

**使用场景**：
```
获取复习单词
    ↓
AI可用？→ YES → 使用AI优化间隔
         → NO  → 使用SM-2计算下次复习时间
    ↓
更新单词的 interval, repetitions, easeFactor
```

---

## AI优雅降级

### 降级策略矩阵

| 功能场景 | AI可用 | AI不可用（5秒超时/未配置/网络错误） |
|---------|---------|------------------------------------|
| **词组拼写验证** | 本地验证 | ✅ 本地验证（不受影响） |
| **2词搭配检查** | AI判断搭配合理性 | ✅ 跳过，假设合理 |
| **3词搭配检查** | 直接通过 | ✅ 直接通过（不受影响） |
| **遗忘曲线优化** | AI优化间隔 | ✅ 使用SM-2算法 |
| **超时保护** | 5秒自动降级 | - |

### 用户体验保证

```
AI配置错误/未配置
    ↓
系统仍然可用 ✅
    ↓
差异：
  - 词组：只验证拼写，不检查搭配
  - 复习：使用SM-2算法替代AI
  - 速度：更快，无延迟
```

---

## 实施步骤

### Phase 1：核心验证功能（2-3小时）

**文件修改**：
1. `/services/ai/localProvider.ts`
   - 添加 `validatePhrase()` 方法
   - 实现分词、拼写验证、高亮错误
   - 2词返回 `needsCollocationCheck: true`
   - 3词直接通过

2. `/services/ai/geminiProvider.ts`
   - 添加 `validateCollocation()` 方法
   - AI判断2词搭配合理性

3. `/services/ai/index.ts`
   - 添加超时保护（5秒）
   - 降级逻辑

4. `/App.tsx`
   - 处理 `needsCollocationCheck` 标记
   - 显示不常见搭配警告
   - 添加"强制添加"按钮

---

### Phase 2：AI服务扩展（1-2小时）

**文件修改**：
1. `/services/ai/openaiProvider.ts`（新建）
   - 实现OpenAI兼容接口
   - 支持 `validateSpelling()`, `validateCollocation()`, `optimizeReviewSchedule()`

2. `/services/ai/index.ts`
   - 支持 `provider: 'gemini' | 'openai'`
   - 动态切换Provider
   - 统一接口调用

---

### Phase 3：SM-2降级算法（1小时）

**文件修改**：
1. `/utils/sm2Algorithm.ts`（新建）
   - 实现 `calculateNextReview()`
   - 实现 `createNew()`

2. `/App.tsx` 或 reviewService
   - 集成SM-2算法
   - AI不可用时使用SM-2

---

### Phase 4：AI配置界面（1-2小时）

**文件修改**：`/App.tsx`

**UI实现**：
- Neural Interface区域添加开关
- 可展开配置面板
- Provider选择（Gemini/OpenAI）
- API Key输入
- Base URL输入（OpenAI可选）
- 测试连接按钮
- 连接状态显示

**持久化**：
- 保存到 `localStorage`
- 自动加载上次配置
- 配置后自动初始化AI服务

---

### Phase 5：测试用例（30分钟）

**新建文件**：`/services/ai/__tests__/phraseValidation.test.ts`

**测试覆盖**：
- 2词词组验证
- 3词词组验证
- 错误单词高亮
- 词组长度限制
- 超时降级
- AI不可用降级
- SM-2算法计算

---

## 测试验证

### 功能测试用例

#### 1. 基础词组验证

| 输入 | 预期结果 |
|------|---------|
| "go cycling" | ✅ 通过 |
| "take part in" | ✅ 通过 |
| "look forward to" | ✅ 通过 |
| "New York" | ✅ 通过 |

#### 2. 错误检测和高亮

| 输入 | 预期显示 |
|------|---------|
| "go cyclling" | "go [cyclling]"，建议 "go cycling" |
| "gooo cyclling" | "[gooo] [cyclling]" |
| "take partt in" | "take [partt] in"，建议 "take part in" |

#### 3. 搭配合理性检查

| 输入 | AI判断 | 预期行为 |
|------|---------|---------|
| "go cycling" | 常见 | ✅ 直接通过 |
| "come cycling" | 不常见 | ⚠️ 警告，建议 "go cycling"，提供"强制添加" |
| "xyz abc" | 两个无效词 | ❌ 拒绝 |

#### 4. 词组长度限制

| 输入 | 预期结果 |
|------|---------|
| "one two" | ✅ 通过（2词） |
| "one two three" | ✅ 通过（3词） |
| "one two three four" | ❌ 拒绝，提示 "Please enter 2-3 words only" |

#### 5. AI降级测试

| 场景 | 预期行为 |
|------|---------|
| AI未配置 | 词组只验证拼写，复习使用SM-2 |
| 网络超时（5秒） | 自动降级，不卡住 |
| 测试连接失败 | 显示错误提示，允许保存配置 |
| OpenAI服务 | 正常工作，与Gemini同等体验 |

#### 6. 离线测试

| 场景 | 预期结果 |
|------|---------|
| 断网后输入 "go cycling" | ✅ 本地验证通过（无API调用） |
| 断网后复习单词 | ✅ 使用SM-2算法计算间隔 |

---

## 预估工作量

| Phase | 任务 | 预估时间 |
|-------|------|----------|
| Phase 1 | 核心验证功能 | 2-3小时 |
| Phase 2 | AI服务扩展 | 1-2小时 |
| Phase 3 | SM-2降级算法 | 1小时 |
| Phase 4 | AI配置界面 | 1-2小时 |
| Phase 5 | 测试用例 | 30分钟 |
| **总计** | | **5-8小时** |

---

## 限制和风险

### 功能限制

1. **词组长度**：仅支持2-3个单词
2. **连字符词组**：暂不支持（如 state-of-the-art）
3. **搭配判断**：AI可能误判，需要"强制添加"选项
4. **SM-2精度**：不如AI优化精准，但足够可用

### 技术风险

| 风险 | 缓解措施 |
|------|---------|
| AI服务不稳定 | ✅ 5秒超时 + 优雅降级 |
| AI误判搭配 | ✅ 提供"强制添加"选项 |
| 字典不完整 | ✅ AI回退验证 |
| 用户未配置AI | ✅ 完全可用，只是功能简化 |

---

## 成功指标

### 用户体验提升

| 指标 | 实施前 | 实施后 |
|------|---------|---------|
| 词组输入支持 | ❌ | ✅ |
| 本地验证 | ❌ 需要AI | ✅ 2-3词词组本地验证 |
| 验证速度 | 2-5秒 | <50ms（本地） |
| API调用次数 | 每个2词词组1次 | 0次（AI可用时仅搭配检查） |
| 离线支持 | ❌ | ✅ |
| AI不可用体验 | ❌ 卡住等待 | ✅ 优雅降级，SM-2算法 |

### 预期效果

```
用户输入 "go cycling"
    ↓
<50ms 本地验证通过 ✅
    ↓
用户输入 "come cycling"
    ↓
<50ms 拼写验证通过 ✅
    ↓
5秒AI搭配检查 → 不常见 ⚠️
    ↓
显示警告 + 建议 "go cycling"
    ↓
用户选择"强制添加" → 接受
    ↓
保存到数据库（和单词统一存储）
```

---

## 总结

本设计方案实现了：

1. ✅ **完整的词组验证功能**
   - 分词验证
   - 错误高亮
   - 搭配合理性检查

2. ✅ **AI优雅降级**
   - 5秒超时保护
   - 不影响系统可用性
   - SM-2科学算法替代

3. ✅ **灵活的AI配置**
   - 支持Gemini和OpenAI兼容
   - 用户可自主配置
   - 连接测试功能

4. ✅ **优秀的用户体验**
   - 本地优先，快速响应
   - 智能反馈，精确定位错误
   - 离线可用

**实施优先级**：建议按Phase 1 → 5顺序实施，确保每个阶段都可独立验证。
