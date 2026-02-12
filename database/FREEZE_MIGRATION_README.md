# 历史数据冻结修复

## 问题

1. **准确率超过100%** - 由于数据库字段优先级错误，导致显示超过100%的准确率
2. **历史数据不稳定** - 每次修改计分规则后，所有历史数据都会被重新计算，导致过去的统计数据不断变化

## 解决方案

### 1. 准确率范围限制

在以下文件中添加了 `Math.max(0, Math.min(100, accuracy))` 限制：

- `components/CalendarView.tsx` - 日历视图准确率显示
- `components/TestModeV2.tsx` - 测试完成页面准确率显示
- `App.tsx` - 数据读取时优先使用 `total_points` 而非旧的 `points`

### 2. 历史数据冻结机制

创建数据库迁移 `20250213_freeze_historical_stats.sql`，实现：

- **自动冻结**：每次同步统计数据时，自动冻结前一天的数据
- **写保护**：一旦冻结，数据无法被任何同步操作修改
- **历史固定**：过去的统计数据永远固定，不受新规则影响

## 如何应用迁移

### 方法1：使用 Supabase Dashboard（推荐）

1. 打开 Supabase Dashboard
2. 进入 **SQL Editor**
3. 复制 `database/migrations/20250213_freeze_historical_stats.sql` 的内容
4. 粘贴到 SQL Editor 中
5. 点击 **Run** 执行

### 方法2：使用命令行脚本

```bash
cd database
node apply-freeze-migration.js
```

这个脚本会显示 SQL 内容，你需要手动复制到 Supabase Dashboard 执行。

## 迁移功能

### 自动冻结函数

```sql
freeze_previous_days()
```
- 自动冻结所有今天之前的统计数据
- 每次调用 `record_test_and_sync_stats` 时自动执行

### 增强的同步函数

```sql
record_test_and_sync_stats(...)
```
- 检查日期是否已冻结
- 如果冻结，抛出异常，不允许修改
- 自动冻结前一天的数据

### 手动冻结函数

```sql
freeze_all_past_days()
```
- 手动冻结当前用户的所有历史数据
- 用于管理员操作或数据修复

## 数据库字段

`daily_stats` 表：

| 字段 | 类型 | 说明 |
|------|------|------|
| `is_frozen` | BOOLEAN | 是否已冻结（true=不可修改） |
| `total_points` | NUMERIC | 新的正确积分字段 |
| `points` | NUMERIC | 旧字段（已废弃） |

## 关键设计原则

✅ **历史数据即历史**
- 一旦一天结束，那天的数据永远固定
- 就像历史书，不能因为新观点就修改过去的事件

✅ **向前兼容，向后不变**
- 新规则只影响今天和未来的数据
- 过去的数据保持当时的计分规则

✅ **防御性编程**
- 准确率强制限制在 0-100%
- 优先使用正确的字段
- 冻结数据拒绝修改

## 验证

应用迁移后，检查：

```sql
-- 查看冻结状态
SELECT
    date,
    total_count,
    correct_count,
    total_points,
    is_frozen
FROM daily_stats
ORDER BY date DESC
LIMIT 30;
```

- 今天的数据应该显示 `is_frozen = false`（或 NULL）
- 昨天及更早的数据应该显示 `is_frozen = true`

## 回滚

如果需要取消冻结（不推荐）：

```sql
UPDATE public.daily_stats
SET is_frozen = false
WHERE date < CURRENT_DATE;
```

⚠️ **警告**：取消冻结后，历史数据可能会被重新计算！

## 相关文件

- `database/migrations/20250213_freeze_historical_stats.sql` - 迁移SQL
- `database/apply-freeze-migration.js` - 应用脚本
- `services/dataService.ts` - 数据服务（调用冻结函数）
- `App.tsx` - 数据读取（修复字段优先级）
- `components/CalendarView.tsx` - 日历视图（添加准确率限制）
- `components/TestModeV2.tsx` - 测试视图（添加准确率限制）
