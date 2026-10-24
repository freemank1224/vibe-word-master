# Inkfin / 墨鳍 — V6 海妖动作图

## 原画

- `public/monster-surf/inkfin-atlas-v6.png`：1536×1024 RGBA，三列两行，源文件原样复制，保留透明通道。
- 生成工具：内置 imagegen；没有重新制作 3D 模型，也没有用站立角色图充当游泳动作。
- 原始输出：`/Users/softmaple/.codex/generated_images/01a1640e-4f93-76e0-8052-5f94cf5cd7db/exec-33ad2e6f-ca7a-4b4a-b7cc-a19a6194276b.png`。
- 风格参考：现有 `characters/M1-surf.png` 的手绘轮廓与表情，`islands-native-v4.png` 的俯视角度及海水配色。
- 角色：紫靛色章鱼海龙、珊瑚红卷角、青绿耳鳍与斑点、琥珀色眼睛、桃色吸盘。以清晰轮廓和夸张神态表达威胁，保持卡通风格。
- 六帧从左到右、从上到下：浮出、左划、右划、逼近、扑袭、回头撤退。每帧都重新绘制肢体重心与触手动作。
- 图集裁切和水线锚点由 `features/monster-surf/seaMonsterArt.ts` 统一维护；Canvas 动画使用模拟时钟，暂停时全部冻结。

## 生成提示词

```text
Use case: stylized-concept. Asset type: production 2D game character animation sprite atlas.
Create one NEW original sea monster called Inkfin for this illustrated surfing vocabulary game. Input image1 supplies the hand-drawn expressive Monster character style and image2 the elevated 45-degree game camera and tropical palette. Do not copy their characters or islands into output.
A memorable mischievous young kraken sea-dragon hybrid: broad deep indigo/plum head and body, two thick sweeping coral-red brow horns, turquoise fin-like ears, luminous mint freckles, large amber eyes under expressive heavy brows, six stout curling tentacles with peach suckers, pale lavender throat. Menacing but playful, clear silhouette, rounded forms, fine dark navy ink outlines and rich painterly cel shading. NOT 3D rendered, NOT photorealistic, NOT generic emoji. Consistent anatomy, proportions and colors in all six poses.
Atlas landscape1536x1024, exactly THREE COLUMNS by TWO ROWS. Each cell512x512 with sprite centered and FULLY contained within central390x390px; minimum60px transparent margins every cell, at least100px empty transparent gutters between sprites. All six bodies share same physical size; not filling each cell. True alpha transparency outside each cutout, no backdrops.
Camera is orthographic45-degree elevated, creature traveling toward bottom of screen and showing its face, like the surfing reference. Six clearly distinct hand-drawn keyframes in reading order:
TOP LEFT: EMERGE—brow horns, amber eyes and head rising from a tight turquoise splash, tentacles partly submerged, curious threatening expression.
TOP MIDDLE: SWIM LEFT—whole creature visible, leaning slightly left, left tentacles pulling backward through water, right tentacles extended forward; alert closed mouth; crescent ripples tightly around tentacles.
TOP RIGHT: SWIM RIGHT—whole creature visible, opposite swimming stroke and right lean, left tentacles extended forward, right pulling back. SAME character and scale.
BOTTOM LEFT: APPROACH—hunched forward determined squint, both front tentacles reach toward viewer, small mischievous grin with two little cream fangs, powerful bow splash.
BOTTOM MIDDLE: ATTACK—explosive forward lunge toward bottom of frame, both front tentacles raised curling inward, mouth open roaring with a bright tongue and small fangs, dramatic eyes, arcing water droplets. Family-friendly, no blood.
BOTTOM RIGHT: RETREAT—turned three-quarter away toward upper right, head looks back with defeated grumpy expression, tentacles curling under as it dives away, small spiral of water.
Water accents remain compact and semi-transparent cyan; no wide water ovals that touch other cells. No ground shadows outside water, no labels, letters, numbers, grid lines, borders, text or watermarks. Entire horns, tentacles and water splashes fully visible and uncropped. Prioritize stylish expressive drawn poses, coherent creature identity and genuinely transparent gutters.
```

## 动作规则

第 10 个正确单词唤醒海妖，警报期间即可继续听写。此后每个正确单词带来短时加速、扩大身后距离并点亮一格逃脱进度；连续五次后海妖转身下潜。错误清空连续逃脱进度、累计一次逼近，第三次错误才触发扑袭与落水。追逐错误与此前的普通受伤分开计数，撞岛仍按原有规则处理。
