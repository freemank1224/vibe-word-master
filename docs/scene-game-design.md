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
② 渲染 (生图模型 gpt-image-2)           ← 用 ① 的 structuredPrompt
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
