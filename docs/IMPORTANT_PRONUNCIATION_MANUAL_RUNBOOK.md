# IMPORTANT Pronunciation Manual Runbook

本清单用于**生产方式手动操作**发音资产（删除 / 重建），不依赖命令行自动触发。

## 1) 操作前检查（30 秒）

- 登录账号必须是超级管理员邮箱（配置项 `superAdminEmail`）。
- 进入 Account 面板，确认已看到 `Global Pronunciation` 区域。
- 打开主开关（Global Voice Replacement Switch），确保功能按钮可点击。
- 记录当前基线：
  - Progress（done/total）
  - Generated / Skipped / Failed
  - Runtime message

## 2) 标准操作顺序（推荐）

1. 若当前有运行任务，先关闭主开关停止任务。
2. 点击 `Delete Minimax Audio`。
3. 观察状态文案从“删除中”到“删除完成（含计数）”。
4. 删除完成后，点击 `Regenerate All`。
5. 持续观察 Progress、Generated、Failed 是否持续变化。

## 3) 每一步的验收标准

### A. 点击 Delete Minimax Audio 后

期望看到：
- 按钮文案变为 `DELETING...`（或等价状态）。
- Runtime message 出现“Deleting...”/“Deleted assets=..., storage=...”。
- 删除完成后，状态区有明确结果计数（资产数、存储对象数）。

异常判定：
- 30 秒内无任何文案变化。
- 按钮恢复但 message 没有结果计数。
- 多次点击仍无状态变化。

### B. 点击 Regenerate All 后

期望看到：
- 按钮出现 `DISPATCHING...` / `RUNNING...` / `Restart Regenerate` 之一。
- Runtime message 出现“trigger accepted / polling progress / Progress x/y”等。
- `done` 增加，且 `generated` 或 `skipped` 至少有一个增长。

异常判定：
- 20~30 秒内 `updated_at` 无变化（疑似卡住）。
- `done` 长时间不变且无错误说明。
- `failed` 持续快速增长（通常是并发/速率过高）。

## 4) 失败与卡住处理

- 先停止当前任务（主开关关闭）。
- 重新开启后再触发一次 `Regenerate All`。
- 如果仍高失败率：
  - 降低并发（`batchReplacementConcurrency`）
  - 降低 RPM（`maxRequestsPerMinute`）
- 若确认需彻底重置：重复“删除 → 重建”流程。

## 5) 成功完成判定

- 任务状态最终为 Completed（或业务可接受的终态）。
- `done` 接近 `total`。
- `failed` 不再继续增长。
- 抽检前端若干单词：可正常播放、无明显空音频。

## 6) 建议保留的操作记录

每次运行建议记录：
- 开始/结束时间
- 触发人（管理员邮箱）
- 关键参数（并发、RPM、是否 force）
- 结果摘要（total/done/generated/skipped/failed）
- 是否执行过删除步骤及删除计数

---

如需，我可以再补一份配套的“故障分级与响应 SLA 模板”（P1/P2/P3），也放到 docs 并以 `IMPORTANT_` 开头命名。