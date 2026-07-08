# 场景融合游戏 (Scene Fusion Game) — 设计文档 v2

> 本文档自包含，供新 session 直接接手开发。涵盖：功能定义、当前实现状态、**刷新后的生图流水线（核心变更）**、LLM 契约、需改动的代码、待决策项、部署与验证。

---

## 1. 功能定义

第三种游戏化测试模式（与 CLASSIC 拼写、PUZZLE 字谜并列，Quick Test Modal 的 **Option 4**）。

**入口流程**：系统从用户词库挑 N 个词（N=5–10，用户指定；Smart Selection 开则智能选、关则随机）→ 由 AI 把这 N 个词融合进 **一张**等轴透视卡通场景图（图中必含当日主题小怪兽）→ 用户在两种玩法中选一种，共享同一张图：

| 玩法 | 机制 | 计时 |
|---|---|---|
| **看图拼写** (Picture-Spell) | 图中高亮闪烁 3 次该词对应区域 → 用户拼写；给字母数提示；输入框底部蓝/绿/红框指示对错；答对播放铃声 + 区域覆盖 ✅ | N×30s 全局倒计时 |
| **大海捞针** (Needle-in-Haystack) | 高亮该词区域 → 从 5 个候选词中挑选（候选来自用户词库、同词性、去歧义）；答对 ✅ | N×15s 全局倒计时 |

---

## 2. 当前实现状态（已完成、可运行）

代码已落地并通过 `tsc --noEmit` 与 `vite build`：

| 模块 | 文件 | 状态 |
|---|---|---|
| 类型 | [types.ts](../types.ts) `TestModeKind='SCENE'` + 场景类型 | ✅ |
| 数据库 | [database/migrations/20260614_add_scene_game.sql](../database/migrations/20260614_add_scene_game.sql) — `scene_assets` + `scene_game_rounds` + 2 RPC | ✅ 待应用 |
| Edge 函数 | [supabase/functions/scene-generate/index.ts](../supabase/functions/scene-generate/index.ts) | ⚠️ **用旧流水线（见 §3），需重构** |
| 选词/候选/计分/RPC 包装 | [services/sceneGame.ts](../services/sceneGame.ts) | ✅ |
| 区域叠加层 | [components/SceneImageWithRegions.tsx](../components/SceneImageWithRegions.tsx) | ✅ |
| 阶段机主组件 | [components/SceneGameMode.tsx](../components/SceneGameMode.tsx) | ✅ |
| 排行榜 | [components/SceneLeaderboardPanel.tsx](../components/SceneLeaderboardPanel.tsx) | ✅ |
| App 接线 | [App.tsx](../App.tsx) `handleStartSceneGame` + 渲染分支 + Option 4 | ✅ |

**已验证可复用的现成能力**：`LargeWordInput`（字母数提示+蓝/绿/红框）、`audioFeedback`（playDing/playBuzzer/playCheer）、`Confetti`、`adaptiveWordSelector.calculateQueue`（Smart Selection）、`vibe_ai_selection` 开关、当日怪兽静态图 `M0–M6.webp` 与文本描述 `utils/mascotDescriptions.ts`。

---

## 3. 刷新后的生图流水线（核心变更）

> **🎯 最高原则：视觉美观优先于像素精度。** 高亮区域不需要紧紧贴住元素轮廓——一个干净、发光、圆角的"聚光灯"框住一片区域，比一个贴边抖动的技术裁剪框**更美、更优雅**。因此：**① 导演规划的位置区域（zone）就是游戏用的区域，直接用**；像素级精准不是目标。

### 3.1 设计理念

**围绕一个强文本 LLM 做"场景导演"，中间夹一个渲染型生图模型。** 关键点是第①步——把 N 个词合理、有趣地编排进**同一个连贯场景**，并为每个词分配一个**位置区域（zone）**；这个 zone 既是给生图模型的构图指令，也**直接作为游戏中高亮/✅/揭示所用的区域**。

第③步（视觉 bbox 校准）**默认关闭**，仅作为可选候补：先看 ① 的 zone 出图效果，若实际游玩中发现高亮明显偏离元素，再把 ③ 作为可选精修开关打开。

```
① 场景导演 (强文本 LLM, gpt-4o)        ← 核心; 替换旧模板
   输入: N 个词 {text,pos,definitionCn} + 当日怪兽描述
   任务: 构想容纳全部 N 词 + 怪兽的连贯有趣场景;
        为每个词决定 {视觉元素, 呈现方式, 位置区域 zone};
        输出结构化、完整的 text-to-image 提示词
   输出: { sceneConcept, structuredPrompt, elements:[{word, element, presentation, positionZone}] }
            ↓
② 渲染 (生图模型 codex-gpt-image-2)           ← 用 ① 的 structuredPrompt
   等轴卡通场景图 (1024×1024, WebP)
            ↓
   regions = 直接由 elements[].positionZone 经 §5 zone 表派生  ← 默认路径, 不调任何额外模型

──── 以下为可选候补, 默认 OFF (env: SCENE_VISION_ENABLED=true 才走) ────
③ 区域精修 (多模态 LLM gpt-4o, 视觉)     ← 仅当 zone 效果不佳时开启
   事后回扫图片, 返回每词更紧致的 bbox; zone 作为提示喂入
   用途: 把"聚光灯框"收紧到元素实际位置; 失败仍回退 zone
```

### 3.2 为什么这样设计

- **旧方案**（当前代码）`buildFusionPrompt` 是纯代码字符串拼接，没有"构思场景"——生图模型被迫既构图又渲染，画面机械、元素易重叠。
- **新方案**把构图决策交给推理型 LLM：场景连贯（如"怪兽在厨房做早餐，苹果在案板、刀在怪兽手里…"），每个元素有规划好的 zone；生图模型只负责把结构化提示词渲染漂亮。
- **zone 直接当区域用**：一个适度大小的发光圆角框本身就是很美的"聚光灯"视觉，不需要为追求贴边精度而多花一次视觉调用（省钱、省时、更稳）。**先验证 zone 的视觉与可用效果**，再决定是否需要 ③。

### 3.3 容错（默认路径）

- ① 场景导演失败（LLM 报错 / 非 JSON）→ **回退到旧 `buildFusionPrompt` 模板**（已在 scene-generate 中保留），regions 用默认居中 zone，功能不中断。
- 某词缺 `positionZone`（导演漏给）→ 用默认居中 zone（`center`）。
- ③（若开启）对某词失败 → 回退 ① 的 zone；③ 整体失败 → 全部用 zone。
- 极端：连 zone 都没有 → 整图脉冲（现有 `detectionFailed` 机制）。

---

## 4. 场景导演 LLM 契约（第①步，最关键）

### 4.1 输入
```jsonc
{
  "words": [
    { "text": "apple",    "pos": "noun",     "definitionCn": "苹果" },
    { "text": "angry",    "pos": "adjective","definitionCn": "愤怒的" },
    // …共 5–10 个
  ],
  "dayIndex": 2,
  "monsterProse": "<MASCOT_DESCRIPTIONS[dayIndex]>"   // 由 edge 函数注入
}
```

### 4.2 System Prompt（要点）
> 你是一位等轴透视卡通插画的艺术导演。给你 N 个英文单词（含词性与中文释义）和一只当日主题怪兽。你的任务：
> 1. **构想一个连贯、有趣、能自然容纳全部 N 个单词 + 这只怪兽的场景**（给出场景主题与一句话概念）。
> 2. 为**每个**单词决定：用什么具体视觉元素/角色来呈现（名词→物体或角色；形容词→通过某角色的表情/体态/装扮体现，例如 "angry"→一个红脸皱眉的角色；动词→角色正在做该动作；副词→角色以该方式行为）；以及它在场景中的**位置区域 zone**（从固定词表里选，见下）。
> 3. 把以上整合成**一条结构清晰、完整、可直接发给文生图模型**的提示词（`structuredPrompt`），必须包含：等轴透视卡通风格、HD 高清细节丰富、鲜艳色彩、1:1 构图、当日怪兽作为可见角色、**每个元素务必画在它指定的 zone 里**、禁止漂浮字幕/水印（场景内自然文字如招牌/书封允许）。
>
> **`positionZone` 极其重要——它既是生图构图的指令，也是游戏中高亮该词所用的区域。** 只能从这 9 个里选：`top-left, top-center, top-right, mid-left, center, mid-right, bottom-left, bottom-center, bottom-right`。
>
> - **让各元素尽量分散、各占不同 zone**，画面构图均衡美观（这是首要目标，比贴边精准更重要）。
> - N=5–8 时每个词一个独立 zone；N=9–10 时允许个别 zone 放两个小元素，但要在 `presentation` 里说明前后/遮挡，并优先把怪兽放 `center`。
> - 视觉美感 > 像素精度：宁可框得宽松优雅，不要为贴合轮廓而让构图拥挤。
>
> 严格输出 JSON，结构如下。

### 4.3 输出 Schema（JSON 模式）
```jsonc
{
  "sceneTitle": "Cozy Kitchen Morning",
  "sceneConcept": "Tuesday's leaf-green glasses monster is cooking breakfast in a sunny isometric kitchen; ingredients and tools are scattered on the counter around it.",
  "structuredPrompt": "Isometric-perspective cartoon illustration, HD, highly detailed, vibrant saturated colors, 1:1 square composition. Scene: …(连贯场景)…. Always include this mascot as a visible character: <monsterProse>. Place <element A> at top-left; <element B> at center; …. Do not add floating captions or watermarks.",
  "elements": [
    { "word": "apple", "element": "a red apple on a cutting board",  "presentation": "glossy, fresh, with a leaf",            "positionZone": "top-left" },
    { "word": "angry", "element": "a frowning chef character",       "presentation": "red face, furrowed brows, clenched fist","positionZone": "center" }
    // …每个词一项, 共 N 项
  ]
}
```

**字段用途**：

- `structuredPrompt` → 直接喂给第②步生图模型（替换旧 `buildPrompt`/`buildFusionPrompt`）。
- `elements[].positionZone` → **【默认路径】直接经 §5 zone 表派生成 bbox，作为游戏中高亮/✅/揭示的区域**（不再需要任何额外模型）。③ 开启时才作为视觉检测的提示。
- `sceneConcept` / `sceneTitle` → 存进 `scene_assets` 便于调试/展示（可选）。

### 4.4 调用参数
- 模型：`gpt-4o`（走 omgteam OpenAI 兼容网关；可经 `SCENE_DESIGN_MODEL` 覆盖）。**纯文本输入/输出，不需要图片，所以任何强文本 LLM 都可胜任。**
- `response_format: { type: 'json_object' }`，`max_tokens: 1200`，温度 0.7（要一点创意但别太放飞）。
- 失败重试 1 次（去 json_object + 加 "Output ONLY JSON"）。

---

## 5. 位置区域 → bbox 映射表（**默认区域来源**）

导演输出的 `positionZone` 经此表派生成 bbox——这就是游戏默认使用的区域，**不调用任何额外模型**。归一化 0–1，3×3 网格（带小留白，框得宽松优雅）：

| positionZone | x | y | w | h |
|---|---|---|---|---|
| top-left | 0.05 | 0.05 | 0.28 | 0.28 |
| top-center | 0.36 | 0.05 | 0.28 | 0.28 |
| top-right | 0.67 | 0.05 | 0.28 | 0.28 |
| mid-left | 0.05 | 0.36 | 0.28 | 0.28 |
| center | 0.36 | 0.36 | 0.28 | 0.28 |
| mid-right | 0.67 | 0.36 | 0.28 | 0.28 |
| bottom-left | 0.05 | 0.67 | 0.28 | 0.28 |
| bottom-center | 0.36 | 0.67 | 0.28 | 0.28 |
| bottom-right | 0.67 | 0.67 | 0.28 | 0.28 |

**区域来源优先级**（默认只用第一档）：

1. **`positionZone` 派生 bbox**（默认，必用）
2. ③ 视觉精修 bbox（仅 `SCENE_VISION_ENABLED=true` 时，覆盖 zone）
3. 整图脉冲 `detectionFailed`（极端兜底：连 zone 都没有）

---

## 6. 需要改动的代码（具体）

只动 **edge 函数** + **schema 小幅扩展**，客户端基本不变。

### 6.1 `supabase/functions/scene-generate/index.ts`（主要工作）
1. **新增 `designScene(words, dayIndex)`**：调 gpt-4o（§4 契约），返回 `{ structuredPrompt, elements, sceneConcept }`。失败回退旧 `buildFusionPrompt`。
2. **主流程（默认两段，不再强制视觉检测）**：
   - `const design = await designScene(words, dayIndex);`
   - `tryGenerateByProvider(design.structuredPrompt, …)`（替换原来 `buildFusionPrompt` 的调用）
   - **`regions = design.elements.map(e => zoneToBbox(e.positionZone))`** —— 直接由 zone 表（§5）派生，**这是默认且唯一的区域来源**。
3. **③ 视觉精修设为可选**：仅当 `Deno.env.get('SCENE_VISION_ENABLED') === 'true'` 时，才在出图后调 `detectRegions(dataUrl, words, design.elements)`，用返回的紧致 bbox **覆盖** zone 派生值（失败的词仍回退 zone）。默认 OFF，省钱省时。
4. `persistScene`：`scene_assets` 增加 `scene_design JSONB`（存 `design` 全量，便于调试/复现）。每个 region 可带 `source: 'zone'|'vision'` 标记（可选，便于排查）。
5. 保留 `buildFusionPrompt` + `detectRegions` 函数体（detectRegions 仅在开关打开时被调用）。

### 6.2 SQL（增量小迁移，可选）
```sql
alter table public.scene_assets add column if not exists scene_design jsonb default null;
```
（regions 字段语义不变；默认全部由 zone 派生，③ 开启时部分被视觉 bbox 覆盖。前端 [SceneImageWithRegions.tsx](../components/SceneImageWithRegions.tsx) 无需改。）

### 6.3 客户端
基本无需改：`requestSceneGeneration` / `SceneGameMode` 拿到的还是 `{imageUrl, regions}`。若想展示 `sceneConcept`，可在 MODE_SELECT 加一行说明（可选增强）。

### 6.4 不动的部分
选词、大海捞针候选、计分、排行榜、阶段机、App 接线 —— 均保持现状。

---

## 7. 待决策项

### 7.1 缓存粒度：共享 vs 按用户（**Q1，未定**）
当前 `scene_assets` 按 `(词集hash + 当日 + 语言)` **全局共享**，不绑用户。诚实分析：
- **同用户重玩 / "用这张图玩另一种玩法"**：两种方案都受益（主要价值）。
- **跨用户**：仅当两人恰好选了同样 N 词且同一天才命中——自定义词库几乎为 0；CET-4/TOEFL 等共享词表才有意义。

**候选词永远从用户词库实时算，不进缓存**——所以缓存粒度只影响"渲染好的图+区域"，不影响候选词来源。

| 方案 | 优点 | 缺点 |
|---|---|---|
| 共享（现状） | 共享词表用户能省钱；schema 简单 | 自定义库跨用户无收益；语义上"别人的图窜进来" |
| **按用户**（key 加 `user_id`） | 隔离干净，语义清晰；同用户重玩照常受益 | 放弃跨用户省钱 |

**推荐：改为按用户缓存**（更贴"每个用户从自己词库玩"的设计初衷）。改动：`scene_assets` 加 `user_id` 列 + 唯一索引改为 `(user_id, word_set_hash, day_index, language)`；edge 函数从 JWT 取 `user_id` 写入；客户端无需改。**等你拍板。**

### 7.2 场景导演模型
默认 `gpt-4o`（omgteam 网关）。若想更强可换 thinking 模型——但 gpt-4o 对这种结构化场景规划已足够。经 `SCENE_DESIGN_MODEL` env 可覆盖。

---

## 8. 部署 + 验证

### 8.1 上线前必做
1. 应用迁移：`supabase db push`（或 Dashboard 跑 [20260614_add_scene_game.sql](../database/migrations/20260614_add_scene_game.sql) + §6.2 的 alter）。
2. 部署 edge 函数：`supabase functions deploy scene-generate`。
3. 确认 edge secrets：生图用 `PRIMARY_IMAGE_GEN_*`（已有）；场景导演 + 视觉检测默认复用同一网关 `gpt-4o`（即 `PRIMARY_IMAGE_GEN_BASE_URL` + `PRIMARY_IMAGE_GEN_API_KEY`）。可选用 `SCENE_DESIGN_*` / `SCENE_VISION_*` 单独覆盖。

### 8.2 端到端验证

1. **首次生成（默认路径，③ OFF）**：Dashboard → Quick Test → Option 4 → N=5 → 生成。看 edge 日志应为：**场景导演(LLM) → 生图 → zone 派生区域**（两段，无视觉调用）。确认 `scene_assets.prompt` 是 LLM 产出的连贯 `structuredPrompt`（非旧模板），`scene_design` 有值，`regions` 来自 zone 表。
2. **看图拼写**：150s 倒计时、区域（zone 聚光灯框）闪烁 3 次、字母数提示、答对铃声+✅、3 错锁定、超时揭示。**重点看：高亮框是否美观、是否大致框在对应元素所在区域**（不要求贴边精准）。
3. **同图切大海捞针**：75s、5 候选 POS 一致、去歧义。
4. **缓存命中**：重开同词集当日 → `<1s`、`source:'cache-hit'`、无生图计费。
5. **（可选）开启 ③ 精修**：设 `SCENE_VISION_ENABLED=true` 重新生成 → `regions` 变为视觉紧致 bbox，对比 zone 版视觉差异，决定是否长期开启。
6. **降级**：把视觉 key 弄坏（且 ③ 开启时）→ 区域回退 zone，不崩。
7. **移动端**：375px 下区域缩放、候选词竖排、无横向滚动。
8. **怪兽**：改系统日期 0–6 → 提示词含对应 `MASCOT_DESCRIPTIONS[dayIndex]`，UI 显示对应 `M{day}.webp`。

### 8.3 质量观察点

- **视觉美观（首要）**：高亮框是否像一个优雅的发光聚光灯，而不是生硬贴边裁剪；构图是否均衡。
- 场景连贯性：肉眼判断 N 个词是否"有主题地"融在一张图里（而非机械拼贴）。
- zone 与元素的对应度：高亮框是否大致落在对应元素上（偏离一点可接受，明显错位才需考虑开 ③）。
- 延迟：默认路径 = 场景导演 +3–8s + 生图；首局总时长 ~35–95s（缓存命中后 0）。开启 ③ 再 +3–8s。

---

## 9. 实施状态（2026-06-14 完成，TDD）

> §3 的刷新流水线已按测试驱动方式落地。纯逻辑有单测覆盖（34 项全过），`vite build` 通过，我的新增/改动文件 `tsc --noEmit` 零错误。

### 9.1 已落地清单

| 改动 | 文件 | 说明 |
|---|---|---|
| 纯逻辑（§4/§5） | [supabase/functions/scene-generate/sceneDesign.ts](../supabase/functions/scene-generate/sceneDesign.ts) | zone 表、`zoneToBbox`、`normalizeZone`、`parseSceneDesign`、`deriveRegionsFromElements`、导演 system/user prompt 构造。**零依赖**，Deno 边缘函数与 `node --test` 共用同一文件。 |
| 单元测试 | [__tests__/scene/sceneDesign.test.ts](../__tests__/scene/sceneDesign.test.ts) | 28 项：zone 表精确性、JSON 解析容错（fenced/嵌散文/垃圾）、zone→bbox 派生、缺 zone 回退 center、确定性、prompt 构造。 |
| LLM 设置模块 | [services/sceneGameSettings.ts](../services/sceneGameSettings.ts) + 测试 | 控制面板存储的 ①导演 / ③视觉 配置 + `visionEnabled`；`toRequestPayload()` 生成 edge 请求体 `llmConfig`。6 项单测。 |
| Edge 函数重构 | [supabase/functions/scene-generate/index.ts](../supabase/functions/scene-generate/index.ts) | `designScene`(①) → `tryGenerateByProvider`(② 用 structuredPrompt) → `deriveRegionsFromElements`(默认 zone 派生) → 可选 `detectRegions`(③)。① 失败回退 `buildFusionPrompt`。接收 `body.llmConfig`（面板配置优先 → Edge Secret 兜底）。从 JWT 解析 `user_id`，按用户缓存。`scene_design JSONB` 持久化。 |
| SQL 迁移 | [database/migrations/20260614_add_scene_game.sql](../database/migrations/20260614_add_scene_game.sql) | `scene_assets` 改为 **按用户**（`user_id NOT NULL`、唯一索引 `(user_id, word_set_hash, day_index, language)`、owner-read RLS）+ `scene_design JSONB`。基础迁移尚未应用到生产，已就地修正为最终 schema。 |
| 控制面板 | [components/AdminConsole.tsx](../components/AdminConsole.tsx) | 新增「场景游戏」标签：① 场景导演 + ③ 视觉精修 的 BASE_URL / API_KEY / MODEL + 视觉开关。 |
| 客户端接线 | [services/sceneGame.ts](../services/sceneGame.ts) | `requestSceneGeneration` / `requestSceneRegeneration` 注入 `llmConfig`。 |
| 测试脚本 | `package.json` | `npm run test:scene` → `node --test __tests__/scene/*.test.ts`（零依赖，Node 类型擦除）。 |

### 9.2 决策落定（覆盖原待定项）

- **§7.1 缓存粒度 → 按用户**（已实施）：`scene_assets.user_id` + owner-read RLS；edge 从 JWT 取 `user_id`；存储路径改为 `scenes/{user_id}/{day}/{hash}.webp`。
- **LLM 配置 → 控制面板优先**（覆盖 §4.4/§8.1 的纯 env 方案）：用户在「~」面板「场景游戏」标签填的 BASE_URL/API_KEY/MODEL 随请求体发给 edge 函数；留空则回退 Edge Secret（`SCENE_DESIGN_*` / `SCENE_VISION_*`）再回退默认（导演/视觉均 `gpt-4o`，复用 `PRIMARY_IMAGE_GEN_*`）。
- **§7.2 导演模型**：默认 `gpt-4o`，可在面板或 `SCENE_DESIGN_MODEL` 覆盖。
- **③ 视觉精修默认关闭**；面板有开关，或 `SCENE_VISION_ENABLED=true`。

### 9.3 配置解析优先级（edge 函数内）

```text
场景导演 baseUrl/apiKey/model : body.llmConfig.design > SCENE_DESIGN_* > PRIMARY_IMAGE_GEN_*(baseUrl/apiKey) / gpt-4o(model)
视觉开关                     : body.llmConfig.visionEnabled > SCENE_VISION_ENABLED==='true'
视觉 baseUrl/apiKey/model     : body.llmConfig.vision > SCENE_VISION_* > (回退导演配置) > PRIMARY_IMAGE_GEN_* / gpt-4o
```

### 9.4 部署步骤（上线前必做）

1. 应用迁移（基础迁移尚未应用）：Dashboard SQL Editor 跑 [20260614_add_scene_game.sql](../database/migrations/20260614_add_scene_game.sql)，或 `supabase db push`。
2. 部署 edge 函数：`supabase functions deploy scene-generate`（会把同目录 `sceneDesign.ts` 一起打包）。
3. （可选）配置 Edge Secret 兜底：`supabase secrets set SCENE_DESIGN_BASE_URL=... SCENE_DESIGN_API_KEY=...`；或仅依赖面板配置。
4. 端到端按 §8.2 验证（注意：③ 默认关闭，区域来自 zone 表）。

### 9.5 验证记录

- 单测：`npm run test:scene` → 34/34 通过。
- 构建：`npx vite build` → 通过（exit 0）。
- 类型：`npx tsc --noEmit` → 新增/改动文件零错误（仓库存在 1 个 **既有** 遗留测试 `services/__tests__/offlineSyncQueue.test.ts` 的语法错误，与本功能无关）。

### 9.6 控制台配置 vs Supabase Secret 的架构关系

> ⚠️ **本节所述「前端 `llmConfig` 随请求体回传」方案存在安全缺陷，已作废，由 §10 取代。** 保留本节仅作历史/对比说明。新 session 请直接按 §10 实施。

> 本项目的 AI 配置有**两条互不相干的执行路径**。理解这点才能正确配置「场景游戏」。**当前架构经验证稳定，本节为说明，不改动架构。**

**路径 A — 客户端执行（浏览器直接调 LLM）**

- 功能：TTS 朗读（[App.tsx](../App.tsx) `generateSpeech`）、拍照识词（`extractWordFromImage`）、短语/搭配/释义校验。
- 密钥来源：控制台「普通文本」等 BYOK 标签（`AISettings` localStorage）→ 未填则回退前端打包的 `VITE_*` 环境变量。
- Supabase 边缘函数与 Secret **完全不参与**。

**路径 B — 服务端执行（边缘函数调 LLM，用 Supabase Secret）**

- 功能：单词配图 `image-generate`、拼词校验 `spelling-check`、发音、词典查询、**以及本次的 `scene-generate`**。
- 密钥来源：Supabase Edge Secret（`PRIMARY_IMAGE_GEN_*`、`SCENE_DESIGN_*` 等），边缘函数用 `Deno.env.get()` 读取。
- 浏览器只 `invoke` 边缘函数，**永远看不到这些 Secret**。

**结论：Supabase Secret 自己就能独立工作。** 所有边缘函数功能即使控制台一个字都不填也完全正常；控制台配置是**可选的"覆盖 / 自带密钥"**，不是必需拼图，两者无需同时填。

**本次「场景游戏」是混合特例：**

- ① 导演 + ③ 视觉这两个 LLM 跑在服务端边缘函数里 → 本质是**路径 B**（靠 Supabase Secret）。
- 额外加了一条：浏览器把控制台填的 key 放进请求体 `llmConfig` 传给边缘函数；边缘函数**有就用控制台的，没有就回退自己的 Secret**。即控制台配置与 Secret 是"二选一"（控制台优先，Secret 兜底），填其一即可。
- ⚠️ **② 渲染出图永远走 `image-generate` 的 provider 链（`PRIMARY_IMAGE_GEN_*` 等 Supabase Secret），控制台无法覆盖。** 即使「场景游戏」面板填好了导演 key，若 Supabase 缺图片生成 Secret，仍出不了图。

**最小可用配置：**

- 完全靠服务端：Supabase 设好 `PRIMARY_IMAGE_GEN_*`（②出图必需）+ `SCENE_DESIGN_*`（①导演，或改在面板填）。
- 用户自带导演 key：面板「场景游戏」填导演配置，但 `PRIMARY_IMAGE_GEN_*` Secret **仍必须存在**。

### 9.7 控制台标签清理（仅 UI，架构不变）

经代码核查（`resolveConfig` 调用点 + 各 `aiService.*` 消费方），控制台原四个配置标签的实际归属：

| 原标签 | `AITask` | 运行时消费方 | 处置 |
|---|---|---|---|
| 普通文本 | `TEXT` | 客户端 TTS / 短语 / 搭配 / 释义 | **保留** |
| 场景游戏 | 本次新增 | `scene-generate` 边缘函数（①导演+③视觉） | **保留（本次新增）** |
| 图像生成 | `IMAGE_GEN` | ⚠️ 运行时**从未被读取**（配图走 `image-generate` 边缘函数 + Secret） | **移除标签** |
| 图像识别 | `VISION` | 客户端拍照识词 `extractWordFromImage` | **移除标签**（与场景游戏无关，避免误配） |

本次仅删除了「图像生成」「图像识别」两个**标签入口**（[AdminConsole.tsx](../components/AdminConsole.tsx)）。底层 `AISettings` / `resolveConfig` / `IMAGE_GEN` / `VISION` 代码与 localStorage 键**全部保留**，确保既有客户端 AI 功能（拍照识词等）行为零变化。

> 说明：「图像生成」标签移除的依据——`resolveConfig('IMAGE_GEN')` 在全代码库无任何运行时调用方；单词配图统一由 `image-generate` 边缘函数 + Supabase `PRIMARY_IMAGE_GEN_*` Secret 完成，与该标签写入的 localStorage 无关。

---

## 10. 安全重构规格（供下一个 session 执行）

> 本节是**自包含的实施规格**。新 session 读到这里即可独立开工，无需翻阅历史对话。
> **最高约束：绝对不得破坏当前已部署的功能，也不得改动已有数据库结构。** 详见 §10.4。
> **当前线上事实（2026-06-15 核查）**：`scene-generate` 边缘函数**尚未部署**；`scene_assets` / `scene_game_rounds` 表**尚未创建**。因此本特性整体处于"未上线"状态——重构它不会影响任何正在运行的功能。

### 10.1 为什么要重构（当前 `llmConfig` 方案的缺陷）

当前仓库实现（§9）把 ①导演/③视觉 的 `BASE_URL/API_KEY/MODEL` 存在前端 localStorage，再随请求体 `llmConfig` 明文回传给边缘函数。问题：

- **毫无安全收益**：key 明文存在浏览器 localStorage（DevTools / XSS 直接可见），又明文随 body 发出——等于公开。
- **本末倒置**：①②③ 三步都跑在边缘函数（服务端）里，服务端本可用 Supabase Secret（`Deno.env.get`，前端永远看不到）持有密钥。把 key 拽到前端再传回服务端是纯粹的多余且引入漏洞。
- **缺连通性自检**：用户配好后无法验证"端点通不通、模型能不能服务"。

### 10.2 目标架构

- **密钥只在服务端**：①导演 / ③视觉 的 `BASE_URL/API_KEY/MODEL` 一律放 **Supabase Edge Secret**，边缘函数用 `Deno.env.get()` 读取。前端**永不接触 key**。
- **前端控制台「场景游戏」标签只保留非敏感控件**：仅一个「启用视觉精修」布尔开关（可留 localStorage，无安全敏感性）。删除所有 `BASE_URL/API_KEY/MODEL` 输入框。
- **不再回传 `llmConfig`**：`requestSceneGeneration` / `requestSceneRegeneration` 的 invoke body 移除 `llmConfig`。
- **新增「测试连接」按钮**：见 §10.5，验证服务端 Secret 配置是否可用。

### 10.3 需要的 Supabase Secret（在 Supabase 后台设置，前端不可见）

```text
# ① 场景导演（文本 LLM，例如 minimax 的文本模型）
SCENE_DESIGN_BASE_URL    # OpenAI 兼容网关，如 https://.../v1
SCENE_DESIGN_API_KEY     # 导演模型 key
SCENE_DESIGN_MODEL       # 如 minimax-m3（或 gpt-4o）

# ③ 视觉精修（多模态 LLM，可选；留空则回退导演配置）
SCENE_VISION_BASE_URL / SCENE_VISION_API_KEY / SCENE_VISION_MODEL
# 是否启用 ③：默认 OFF；或设 SCENE_VISION_ENABLED=true 全局开启

# ② 出图（图片模型）—— 复用已部署 image-generate 的同一组 Secret，无需新增
PRIMARY_IMAGE_GEN_BASE_URL / PRIMARY_IMAGE_GEN_API_KEY / PRIMARY_IMAGE_GEN_MODEL
```

设置命令（示例）：

```bash
supabase secrets set SCENE_DESIGN_BASE_URL=https://gw.example.com/v1 SCENE_DESIGN_API_KEY=sk-xxx SCENE_DESIGN_MODEL=minimax-m3
```

### 10.4 硬约束（不可破坏清单）

重构必须**外科手术式**，只动场景融合相关文件。**严禁**触碰以下任一项：

1. **已部署的其它边缘函数**：`image-generate`、`pronunciation`、`pronunciation-rebuild`、`spelling-check`、`dictionary-lookup`、`lexeme-meaning-backfill`、`admin-console`、`update-leaderboard`、`check_user_exists`、`watcha-oauth-callback`、`image-migrate` —— 一行都不改。
2. **已有数据库结构**：`words`、`sessions`、`daily_stats`、`daily_test_records`、`leaderboards`、`puzzle_game_rounds`、`image_assets`、`pronunciation_assets`、`lexeme_*`、`user_*` 等所有**既有**表/索引/RLS/函数。场景迁移 `20260614_add_scene_game.sql` 只 **CREATE** 新表（`scene_assets` / `scene_game_rounds`）+ 2 个新 RPC，**纯增量**，不得 ALTER 任何既有表。
3. **既有 AI 服务架构**：[services/ai/](../services/ai/) 全家桶（`AISettings` / `resolveConfig` / `TEXT`/`VISION` BYOK / TTS / 拍照识词）、[imageGenerationEdge.ts](../services/imageGenerationEdge.ts)、[imageGenerationTask.ts](../services/imageGenerationTask.ts) —— 行为零变化。
4. **纯逻辑模块** [sceneDesign.ts](../supabase/functions/scene-generate/sceneDesign.ts) 及其单测 [sceneDesign.test.ts](../__tests__/scene/sceneDesign.test.ts)：zone 表 / `parseSceneDesign` / `deriveRegionsFromElements` / prompt 构造**保持不变**（这层逻辑与密钥来源无关，无需改动）。

允许改动（且仅限）的文件：

- [supabase/functions/scene-generate/index.ts](../supabase/functions/scene-generate/index.ts) — 去掉 `body.llmConfig` 解析，改纯读 Secret；新增 `probe` 分支。
- [services/sceneGameSettings.ts](../services/sceneGameSettings.ts) — 精简为"仅 `visionEnabled` 开关"（删 `design`/`vision` 端点字段与 `toRequestPayload`）。
- [services/sceneGame.ts](../services/sceneGame.ts) — invoke body 去掉 `llmConfig`。
- [components/AdminConsole.tsx](../components/AdminConsole.tsx) — 「场景游戏」标签去掉 key/baseUrl/model 输入，保留视觉开关 + 新增「测试连接」按钮。
- [__tests__/scene/sceneGameSettings.test.ts](../__tests__/scene/sceneGameSettings.test.ts) — 同步精简（只测开关读写）。

### 10.5 连通性自检（probe）设计

- **边缘函数**：在 handler 开头加分支——当 `body.action === 'probe'` 时，不生成图片、不读写 `scene_assets`，仅用服务端 `SCENE_DESIGN_*` Secret 向导演模型发一次**最小请求**（如 `messages:[{role:'user',content:'ping'}]`、`max_tokens:1`），计时并捕获错误，返回：

  ```json
  { "ok": true, "probe": "design", "model": "minimax-m3", "latencyMs": 612, "baseUrl": "…(脱敏)" }
  ```

  失败时 `{ "ok": false, "error": "...", "status": 502 }`。probe 仍需 JWT 鉴权（复用 `resolveUserId`），但不依赖任何表。
- **前端**：「场景游戏」标签放「测试导演连接」按钮 → `supabase.functions.invoke('scene-generate', { body:{ action:'probe' } })` → 绿/红显示 `model + 延迟` 或错误。可顺带提示"若失败请检查 Supabase Secret `SCENE_DESIGN_*`"。

### 10.6 仓库当前待回退状态（重构起点）

当前工作区已包含作废的 `llmConfig` 实现，新 session 需先回退再按 §10.2 落地：

- [services/sceneGameSettings.ts](../services/sceneGameSettings.ts) 含 `design`/`vision` 端点 + `toRequestPayload()` → **精简**。
- [services/sceneGame.ts](../services/sceneGame.ts) 两处 invoke body 含 `llmConfig: buildLlmConfigPayload()` → **删除**。
- [components/AdminConsole.tsx](../components/AdminConsole.tsx) `SceneGameSettingsPanel` 含 3×key 输入 → **改为开关 + 测试按钮**。
- [supabase/functions/scene-generate/index.ts](../supabase/functions/scene-generate/index.ts) `resolveDesignConfig/resolveVisionConfig` 读 `callerLlm` → **改为纯 `Deno.env.get`**；handler 去掉 `const callerLlm = body.llmConfig`。

### 10.7 验证（重构后）

1. `npm run test:scene` → 全绿（sceneDesign 逻辑不变；sceneGameSettings 测试同步精简后仍全绿）。
2. `npx tsc --noEmit`（除既有遗留 `offlineSyncQueue.test.ts` 外零错误）、`npx vite build` 通过。
3. grep 确认 `llmConfig` / `toRequestPayload` 在前端代码中**已无残留**。
4. 设好 Secret → 部署 `scene-generate` → 控制台「测试导演连接」返回 `ok:true`。
5. 端到端：LOAD SCENE → 边缘函数日志为"导演(服务端 Secret)→ 出图 → zone 区域"，前端不再传任何 key。

### 10.8 部署顺序（重构完成后，上线）

1. 应用迁移 [20260614_add_scene_game.sql](../database/migrations/20260614_add_scene_game.sql)（仅 CREATE 新表 + 2 RPC，不动既有结构）。
2. 设置 Secret（§10.3）。
3. `supabase functions deploy scene-generate`。
4. 控制台「测试连接」自检 → LOAD SCENE 端到端验证。

