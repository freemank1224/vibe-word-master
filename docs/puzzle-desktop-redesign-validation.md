# 九格连线：桌面重设计验收记录

日期：2026-10-23。以下截图与完整局记录对应移除跨图绿线之前的版本；最新视觉修订见文末。状态：**桌面浏览器回归、最终自动化检查、官方线上读回及 QA 清理已完成。** 前端尚未发布。本次结果不以历史测试代替。

## 验收目标与范围

本轮解决九宫格在电脑横屏中棋盘过小、纵向堆叠造成留白过多，以及视觉反馈与网站原有风格脱节的问题。验收关注大棋盘与作答控制台同屏、空间紧凑、图像揭晓和连线反馈，以及键盘连续作答体验。

本轮没有修改复习选词策略；既有判题、计分和学习持久化规则保持。

- 仅以 **1366×768、1440×900、1920×1080** 电脑视口验收，使用键盘和鼠标；截图为视口截图，不使用整页截图替代同屏检查。
- 浏览器操作使用 gstack `/browse`。手机竖屏、软键盘和移动适配不属于本轮范围。
- 业务数据直接连接 Supabase 官方线上项目 `VocabularyVibe`（`mkdxdlsjisqazermmfoe`），使用独立临时 QA 账号。未创建 Docker 或模拟数据库。
- 本轮没有新增数据库迁移、没有发布前端。浏览器使用稳定生产构建的本地预览。

## 已准备的真实词库与媒体

在官方线上库只读查找现有公共资源，按同一英文词与 `en` 语言匹配 `lexeme_entries`、`lexeme_meanings`、`image_assets` 和 `pronunciation_assets`。最终仅向本次 QA 账号新增 1 个词库批次与 12 个词。

词库为：apple（苹果）、banana（香蕉）、orange（橙子）、cat（猫）、dog（狗）、fish（鱼）、elephant（大象）、horse（马）、tree（树）、car（车）、book（书）、bread（面包）。

- 12 个词使用 **12 个不同的现有 ready 图片资产**，按对应英文词关联；没有以同一张共享图片填满棋盘。
- 12 个词均使用对应的现有 ready 发音资产；未使用静音 WAV 替代发音，未调用图片或音频生成服务。
- 24 个媒体地址的 Storage HEAD 检查均返回 HTTP 200，图片为 PNG/WebP、音频为 MP3。浏览器回归进一步确认图片解码、准备完成和游戏交互；本轮不据此宣称人工试听或主观发音质量通过。
- 共享词典、图片和发音资产均未修改。本次可写数据范围限定为该临时 QA 账号。
- 种词后线上回读确认：12 个词、12 个不同图片关联、学习修订总和 0、日统计为空、金币余额 0。

准备证据：`/tmp/vocab-puzzle-design-fixtures.json`、`/tmp/vocab-puzzle-design-cloud-before.json`。它们是本次工作机临时证据，不是部署资源。密码、密钥和登录凭据不记录到本文或仓库。

## 桌面布局与视觉验收

从稳定生产构建采集 `getBoundingClientRect()`，三档均确认棋盘、题目、输入、操作按钮与右侧控制台同时可见，文档无横向溢出，控制台正文无滚动。原布局与新布局均来自对应电脑视口，不能将扩大截图画布视为界面扩大。

| 电脑视口 | 原棋盘 → 新棋盘 | 棋盘面积 | 输入底部 / 控制台底部 | 结果 |
| --- | --- | --- | --- | --- |
| 1366×768 | 410×307.19 → 926×461 px | 原来的 3.39 倍 | 373.39 / 718 px | 同屏、无横向溢出 |
| 1440×900 | 410×350 → 1000×593 px | 原来的 4.13 倍 | 410.58 / 850 px | 同屏、无横向溢出 |
| 1920×1080 | 410×350 → 1142×730 px | 原来的 5.81 倍 | 453.58 / 1024 px | 同屏、无横向溢出 |

1366×768 中单格由约 131×98 px 增至 302×147 px。棋盘放大同时将输入放到右侧，不再让下方大输入条挤占棋盘高度。三档已揭晓图片的计算样式 `filter` 均为 `none`，图像不再残留模糊效果。

额外输入 52 字母错误答案复测：原错误位置列表使右侧正文 `scrollHeight=457 > clientHeight=439`；现在使用紧凑错误摘要，`scrollHeight=clientHeight=439`，完整错误位置保留在 `title`，输入与按钮仍可见。

几何证据：旧 `/tmp/vocab-desktop-puzzle-layout.json`；新 `/tmp/vocab-puzzle-design-layouts.json`；长答案 `/tmp/vocab-puzzle-design-long-error.json`。视口截图：

- `/tmp/vocab-puzzle-redesign-intro-1366.png`
- `/tmp/vocab-puzzle-redesign-active-1366.png`
- `/tmp/vocab-puzzle-redesign-active-1440.png`
- `/tmp/vocab-puzzle-redesign-active-1920.png`
- `/tmp/vocab-puzzle-redesign-error-1366.png`
- `/tmp/vocab-puzzle-redesign-result-1366.png`

## 交互与记录回归

自动回归通过可见中文提示映射作答，不读取 React 内部状态。脚本入口为 `/tmp/vocab-puzzle-design-round.js`，执行结果 `window.puzzleDesignRun.status='passed'`。本轮完成两盘完整九格（各 1470 分、9/9、8 条线）以及一盘三词补练（290 分、3/3、1 条线）。完整盘使用提示作答，得分构成为单词 630 + 连线 640 + 全盘 200；补练为单词 210 + 连线 80。

| 检查项 | 预期 | 本次结果 |
| --- | --- | --- |
| 准备与开始 | 图片和声音就绪后才开始倒计时 | 通过，使用真实既有媒体 |
| 鼠标选格、重播 | 选中正确卡片，输入焦点恢复 | 通过 |
| Alt + 1–9 | 在输入框中切换目标格，不污染答案 | 通过；另模拟 macOS Option 的符号 `key` 与物理 `Digit` 的 `code` 事件验证 |
| 首次错误与纠正 | 显示对应错误提示，保留输入和焦点，纠正后推进 | 通过；另覆盖 52 字母长错误 |
| Enter 连续提交 | 自动进入下一格，输入节点与焦点连续 | 通过 |
| 暂停与继续 | 暂停锁定作答；继续恢复焦点和本局状态 | 通过 |
| 音效开关 | 切换后保留连续输入焦点 | 通过 |
| 九格八线 | `RESULT` 状态、9 张 solved 卡片、8 条 SVG 连线，结果指标显示 9/9 与 8 | 移除前版本两盘通过；结果记忆地图同屏，跨图 SVG 已在后续修订中删除 |
| 三词补练 | 原盘结束后继续巩固提示/纠正词 | 通过，3/3、1 条线、290 分 |
| 本地记录幂等 | 一局只新增一条轮次记录 | 通过；两盘完整局后为 2，补练后最终为 3 |
| 官方线上读回 | 核对本次学习事件、修订与统计，不将练习分误写为旧排名 | 通过，见下方读回 |
| QA 清理 | 专用账号与业务记录删除，共享资源保留 | 通过，11 类剩余数均为 0 |

浏览器证据：`/tmp/vocab-puzzle-design-browser-result.json`、`/tmp/vocab-puzzle-design-first-result.json`、`/tmp/vocab-puzzle-design-short-result.json`。音效焦点与模拟 macOS Option 事件由主 Agent 追加浏览器检查；52 字母纠错使用 gstack `fill` 与 `press Enter` 驱动。

## 官方线上读回

在浏览器完成后使用同一 QA 账号查询官方线上实例，并用限定该 userId 的只读 SQL 核对私有事件和旧排名：

| 指标 | 初始 | 最终 | 解释 |
| --- | ---: | ---: | --- |
| QA 单词 | 12 | 12 | 未新增其它词 |
| 学习修订总和 | 0 | 21 | 两盘各 9 词 + 补练 3 词 |
| 私有学习事件 | 0 | 21 | 与修订总和和实际完成词数一致 |
| 私有测验事件 / 日测验记录 | 0 / 0 | 0 / 0 | 练习不误写普通测验 |
| 日统计 / 旧排行榜行数 | 0 / 0 | 0 / 0 | 练习分没有进入旧排行榜 |
| 钱包余额 | 0 | 41 | 登录奖励 +1，四项既有成就各 +10；无 `quiz_score` 交易 |

本机 journal 最终为 **3 局、21 条事件、待传事件 0、待同步词 0**，与线上 21 条学习事件一致。数据证据：`/tmp/vocab-puzzle-design-cloud-after.json`、`/tmp/vocab-puzzle-design-cloud-counts.json`、`/tmp/vocab-puzzle-design-local-sync.json`。采集期间 SDK 查询未调用全局 `signOut`，避免撤销仍在浏览器中的 QA 会话。

## QA 清理

主 Agent 关闭游戏并通过界面退出登录，确认回到 `START NOW` 首页后，清理脚本再次校验固定项目、专用 userId 和保留 QA 邮箱前缀，只删除本次临时账号下的业务记录与 Auth 用户。

最终只读复核 **11 类剩余数均为 0**：Auth users、identities、words、sessions、daily_stats、daily_test_records、wallets、coins、leaderboards、learning_events、test_events。共享词典、图片与发音资产保留。凭据文件及含密码的登录脚本已移除。

本次证据保存在 `/tmp/vocab-puzzle-design-cleanup-result.json`；通用清理工具使用的历史报告先备份，随后原样恢复，没有覆盖前次验收证据。

## 自动化检查

本轮最终 `npm run verify` 退出码 0：app、Node、tests、Edge Functions 四组类型检查通过，**221 项测试通过、0 失败**，Vite 生产构建完成（42.56 秒）；`git diff --check` 通过。日志 `/tmp/vocab-puzzle-design-verify.log`。

本次生产构建标识为 `index-D9n0CBYT.js`；九宫格分包为 `PuzzleGameMode-pokw27dw.js`，27.63 kB / gzip 9.85 kB；按需 CSS 为 25.18 kB / gzip 5.21 kB。九宫格资源随功能加载，不进入首页主包。既有主包与 wink 分包的大包警告仍存在，本轮没有调整告警阈值隐藏它们。

## 最终证据与边界

减少动态效果的 CSS 已静态审查；gstack 当前拒绝 `Emulation.setEmulatedMedia`，未获得浏览器强制模拟 `prefers-reduced-motion` 的执行证据，因此**不将该项写为浏览器验收通过**。

本机生产预览、现有真实媒体与单个专用 QA 账号构成本次验证范围。没有发布前端、没有新增迁移，不将本机表现外推为所有电脑、所有浏览器或公网环境的结果。

## 后续视觉修订：取消跨图片绿线（2026-10-23）

用户指出跨图片绿色连线遮挡了图片主体，完成多条线后画面过于杂乱。已删除棋盘上方的 SVG 连线层及其描线动画、描边样式；成线通过底部进度灯、顶部计数和短暂奖励提示呈现。成线判定和奖励来自既有规则计算，与 SVG 无关。

本次仅修改呈现层：app 类型检查、20 项九宫格测试及生产构建通过，`git diff --check` 通过，源文件确认不存在 `puzzle-links` / `puzzle-connect` 残留。构建日志 `/tmp/vocab-puzzle-no-overlay-build.log`。上述截图、221 项完整回归和线上数据记录为删除线条前的历史证据，本次没有重建测试账号、没有修改线上数据库，也没有重新声明三档浏览器回归。
