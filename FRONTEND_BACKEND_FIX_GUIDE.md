# 前后端数据不匹配问题修复指南

## 问题概述

当前项目存在前后端数据库不匹配的严重问题，导致以下症状：

1. ✗ **日历颜色全部显示绿色** - 无法正确显示每日准确率
2. ✗ **Activity Log 悬浮面板无法正常显示** - 无法查看每日详情
3. ✗ **Session 面板删除功能可能异常** - 需要验证
4. ✗ **Section 面板找不到** - 需要进一步调查

## 根本原因分析

### 问题 1: `points` 字段缺失导致日历颜色错误

**位置**: `App.tsx:121`

**原因**: 前端从 `daily_stats` 表获取数据时，**没有映射 `points` 字段**：

```typescript
// ❌ 错误的代码（已修复）
stats.forEach((s: any) => {
    statsMap[s.date] = { date: s.date, total: s.total, correct: s.correct };
    // 缺少 points: s.points
});
```

**影响链**:
1. `App.tsx` 加载统计数据时丢失 `points`
2. `CalendarView.tsx:30-32` 使用 `stat.points / (stat.total * 3)` 计算准确率
3. 当 `points` 为 `undefined` 时，计算结果为 `NaN`
4. 日历颜色逻辑失效，所有日期显示为默认绿色

### 问题 2: 数据库表结构可能不完整

如果数据库迁移脚本没有全部执行，可能缺少：
- `daily_stats.points` 列
- `words.last_tested` 列
- `words.score` 列
- `words.deleted` 列
- `sessions.library_tag` 列

### 问题 3: 历史数据未回填

即使表结构正确，已有的历史记录可能：
- `points` 值为 NULL
- `last_tested` 值为 NULL
- `score` 值为 NULL

---

## 修复步骤

### 步骤 1: 修复前端代码（已完成）

✅ **文件**: [App.tsx:121](App.tsx#L121)

已将代码修改为：

```typescript
// ✅ 正确的代码
stats.forEach((s: any) => {
    statsMap[s.date] = { date: s.date, total: s.total, correct: s.correct, points: s.points };
});
```

### 步骤 2: 执行数据库迁移脚本

1. **打开 Supabase 控制台**
   - 访问 https://app.supabase.com
   - 选择你的项目
   - 进入 SQL Editor

2. **执行验证脚本**（可选但推荐）
   ```sql
   -- 打开 verify_database_state.sql
   -- 复制全部内容到 SQL Editor
   -- 执行并查看结果
   ```

3. **执行修复脚本**
   ```sql
   -- 打开 fix_frontend_backend_mismatch.sql
   -- 复制全部内容到 SQL Editor
   -- 执行脚本
   ```

4. **检查执行结果**
   - 查看底部输出的 NOTICE 消息
   - 确认所有列都已添加
   - 确认数据已回填

### 步骤 3: 测试验证

1. **清除浏览器缓存**
   ```bash
   # 在浏览器中按 Cmd+Shift+R (Mac) 或 Ctrl+Shift+R (Windows)
   # 或者打开开发者工具，右键刷新按钮选择"清空缓存并硬性重新加载"
   ```

2. **重启应用**
   ```bash
   npm run dev
   ```

3. **验证功能**
   - [ ] 日历颜色是否正确显示（红/橙/黄/绿）
   - [ ] 鼠标悬停日期是否显示 Activity Log 面板
   - [ ] Activity Log 中是否显示正确的准确率
   - [ ] Session 删除功能是否正常

---

## 数据库迁移脚本说明

### fix_frontend_backend_mismatch.sql

此脚本执行以下操作：

#### 第 1 部分：验证并添加缺失的列
- ✅ 检查 `daily_stats.points` 列
- ✅ 检查 `words` 表所有必需列（last_tested, score, error_count, etc.）
- ✅ 检查 `sessions` 表软删除列
- ✅ 自动添加缺失的列（不会报错如果已存在）

#### 第 2 部分：回填历史数据
- ✅ 为已有 `daily_stats` 记录计算 `points`
- ✅ 为已测试的 `words` 回填 `last_tested`
- ✅ 为正确的 `words` 回填 `score = 3`
- ✅ 为无 tags 的 `words` 设置 `['Custom']`

#### 第 3 部分：创建/更新数据库函数
- ✅ `sync_todays_stats_with_timezone()` - 同步今日统计数据
- ✅ `consolidate_daily_stats()` - 回填历史数据

#### 第 4 部分：验证和报告
- ✅ 输出数据完整性报告
- ✅ 显示修复前后的统计信息

#### 第 5 部分：刷新 Schema 缓存
- ✅ 通知 PostgREST 重新加载 schema

### verify_database_state.sql

此脚本用于诊断数据库当前状态：
- 检查所有必需的表
- 检查所有必需的列
- 检查数据完整性
- 检查数据库函数
- 显示用户数据摘要

---

## 故障排除

### 问题：日历颜色仍然全部是绿色

**可能原因**:
1. 浏览器缓存了旧数据
2. 数据库 `points` 列仍然为 NULL

**解决方案**:
```sql
-- 强制回填所有 daily_stats 的 points
UPDATE public.daily_stats
SET points = CASE
    WHEN correct > 0 THEN correct * 3
    ELSE 0
END
WHERE points IS NULL OR points = 0;
```

### 问题：Activity Log 面板打不开

**可能原因**:
1. JavaScript 错误
2. 数据格式问题

**解决方案**:
```sql
-- 检查 daily_stats 数据格式
SELECT date, total, correct, points
FROM public.daily_stats
ORDER BY date DESC
LIMIT 5;

-- 确保 points 列存在且有值
-- 如果没有，执行上面的 UPDATE 语句
```

### 问题：Session 无法删除

**可能原因**:
1. RLS (Row Level Security) 策略问题
2. 权限不足

**解决方案**:
```sql
-- 检查 RLS 策略
SELECT *
FROM pg_policies
WHERE tablename = 'sessions';

-- 确保有正确的删除策略
-- 应该有类似这样的策略：
-- POLICY "Users can delete their own sessions"
-- ON sessions FOR DELETE
-- USING (auth.uid() = user_id)
```

### 问题：看不到历史数据

**可能原因**:
1. `last_tested` 字段为空
2. 时区不匹配

**解决方案**:
```sql
-- 1. 回填 last_tested
UPDATE public.words
SET last_tested = created_at
WHERE tested = true AND last_tested IS NULL;

-- 2. 重新整合统计数据
SELECT consolidate_daily_stats();
```

---

## 数据完整性检查清单

执行修复后，使用以下清单验证：

### 数据库层面
- [ ] `daily_stats` 表有 `points` 列
- [ ] `daily_stats` 中所有记录都有 `points` 值
- [ ] `words` 表有 `last_tested` 列
- [ ] `words` 表有 `score` 列
- [ ] `words` 表有 `deleted` 列
- [ ] `sessions` 表有 `library_tag` 列

### 前端层面
- [ ] `App.tsx` 正在映射 `points` 字段
- [ ] `CalendarView.tsx` 正确计算准确率
- [ ] 没有控制台错误

### 功能层面
- [ ] 日历颜色多样化（不是全绿）
- [ ] 悬停显示 Activity Log
- [ ] Activity Log 显示准确率百分比
- [ ] 可以删除 Session
- [ ] 可以看到历史统计数据

---

## 预防措施

为了避免将来出现类似问题，建议：

1. **使用版本控制的数据库迁移**
   - 将所有 schema 变更保存在 SQL 文件中
   - 按时间顺序命名（如 `migration_2025_01_27.sql`）
   - 在 README.md 中记录迁移历史

2. **添加数据库验证测试**
   - 在 CI/CD 中运行 `verify_database_state.sql`
   - 确保所有必需的列都存在

3. **前端类型安全**
   - 使用 TypeScript 严格模式
   - 确保 DayStats 接口与数据库表结构一致
   - 添加运行时数据验证

4. **定期备份**
   - 在执行迁移前备份数据库
   - Supabase 提供自动备份，但也要手动备份关键数据

---

## 相关文件

- [App.tsx](App.tsx) - 主应用文件（已修复）
- [components/CalendarView.tsx](components/CalendarView.tsx) - 日历组件
- [services/dataService.ts](services/dataService.ts) - 数据服务
- [fix_frontend_backend_mismatch.sql](fix_frontend_backend_mismatch.sql) - 数据库修复脚本
- [verify_database_state.sql](verify_database_state.sql) - 数据库验证脚本

---

## 联系与支持

如果问题仍然存在，请：

1. 运行 `verify_database_state.sql` 并保存输出
2. 打开浏览器控制台（F12）查看错误
3. 提供以上信息以便进一步诊断

---

**文档版本**: 1.0
**最后更新**: 2025-01-27
**作者**: Claude Code
