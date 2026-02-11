# 增量统计修复文档

## 🔴 问题分析

### 用户报告的问题
- 用户连续测试两次，每次都是 100% 正确率
- 但最终 Activity Log 显示的准确率是 70%（或其他非 100% 的数字）

### 根本原因

#### 1. 数据库统计逻辑问题
数据库的 `sync_todays_stats_with_timezone` 函数使用全量计算：

```sql
SELECT
    COUNT(*),  -- 统计 last_tested=today 的不重复单词数
    COUNT(*) FILTER (WHERE correct = true),
    COALESCE(SUM(score), 0)
FROM words
WHERE last_tested = today
```

**问题**：当用户两次测试同样的 10 个单词时，数据库始终返回 10 个单词，不是 20 次！

#### 2. 前端数据流问题

**之前的流程**：
```
测试完成 → updateLocalStats(results)
  ↓
前端立即累积：{ total: 20, correct: 20, points: 60 }  ✅
  ↓
2秒后数据库查询返回：{ total: 10, correct: 10, points: 30 }  ❌
  ↓
数据库结果覆盖前端累积的数据  ❌
```

**关键 bug** (App.tsx 第 319-320 行)：
```typescript
if (fetchedMap[today]) {
    newStats[today] = fetchedMap[today];  // ❌ 直接覆盖！
}
```

#### 3. 统计口径不一致
- **前端**：累积测试次数（每次测试都累加）
- **数据库**：统计不重复单词数（去重）
- 两者口径不一致，导致数据错乱

---

## ✅ 解决方案

### 设计思路

1. **保留数据库的去重逻辑**（这是合理的，统计今天学习了多少个不同的单词）
2. **新增测试记录表** `daily_test_records`（记录每次测试的详细信息）
3. **增量累加统计数据**（从测试记录表计算，而不是全量计算）
4. **前端等待数据库完成后再跳转**（确保数据一致性）

### 核心改动

#### 1. 新增 `daily_test_records` 表

```sql
CREATE TABLE public.daily_test_records (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    test_date DATE NOT NULL,
    test_count INTEGER NOT NULL,           -- 本次测试的单词数
    correct_count INTEGER NOT NULL,        -- 本次测试正确的单词数
    points NUMERIC NOT NULL,               -- 本次测试的得分
    timezone_offset INTEGER,               -- 用户时区偏移
    created_at TIMESTAMP DEFAULT now()
);
```

#### 2. 新增 RPC 函数：`record_test_and_sync_stats`

**功能**：
- 记录本次测试到 `daily_test_records` 表
- 从 `daily_test_records` 增量计算统计数据
- 返回准确的增量统计结果

**关键逻辑**：
```sql
-- Step 1: 记录本次测试
INSERT INTO daily_test_records (...) VALUES (...);

-- Step 2: 增量计算统计数据
INSERT INTO daily_stats (...)
SELECT
    SUM(test_count),       -- 累加测试次数
    SUM(correct_count),    -- 累加正确次数
    SUM(points)            -- 累加得分
FROM daily_test_records
WHERE user_id = v_user_id AND test_date = v_test_date
ON CONFLICT (user_id, date) DO UPDATE SET
    total_count = EXCLUDED.total_count,     -- ✅ 使用增量计算的值
    correct_count = EXCLUDED.correct_count,
    total_points = EXCLUDED.total_points;
```

#### 3. 前端修改：`updateLocalStats` 改为 async 函数

**之前**：
```typescript
const updateLocalStats = (results) => {
    // 立即更新本地状态
    setDailyStats(...);

    // 2秒后用数据库结果覆盖 ❌
    setTimeout(() => {
        fetchUserStats(...).then(dbStats => {
            newStats[today] = dbStats[today];  // ❌ 覆盖！
        });
    }, 2000);
};
```

**现在**：
```typescript
const updateLocalStats = async (results) => {
    // 立即更新本地状态（乐观更新）
    setDailyStats(...);

    // 等待数据库完成 ✅
    const dbStats = await recordTestAndSyncStats(...);

    // 用准确的数据库数据更新 ✅
    setDailyStats(prev => ({
        ...prev,
        [today]: {
            total: dbStats.total_tests,      // 数据库返回的增量数据
            correct: dbStats.correct_tests,
            points: dbStats.total_points
        }
    }));
};
```

#### 4. TestModeV2 调用修改

```typescript
// 之前：onComplete 是同步函数
onComplete={(results) => {
    updateLocalStats(results);
    setMode('DASHBOARD');
}}

// 现在：onComplete 是异步函数
onComplete={async (results) => {
    await updateLocalStats(results);  // ✅ 等待数据库完成
    setMode('DASHBOARD');
}}
```

---

## 🎯 新的数据流

```
测试完成 → 用户点击"RESTORE SYSTEM"
  ↓
TestModeV2 显示 "Syncing Neural Database..."
  ↓
1.5秒后调用 onComplete(results)
  ↓
updateLocalStats(results)
  ├─ 前端立即更新（乐观更新）
  ├─ 调用 recordTestAndSyncStats()
  │   ├─ 插入 daily_test_records
  │   ├─ 增量计算 daily_stats
  │   └─ 返回准确的统计数据
  └─ 用数据库返回的数据更新本地 ✅
  ↓
setMode('DASHBOARD') → 跳转到首页
```

**关键改进**：
- ✅ 数据库返回的是增量统计（从测试记录表计算）
- ✅ 前端等待数据库完成后再跳转
- ✅ 数据库和前端数据一致

---

## 📝 数据库迁移

### 应用迁移

1. 在 Supabase Dashboard 中执行迁移：
   ```sql
   -- 文件：database/migrations/20250211_add_daily_test_records.sql
   ```

2. 迁移内容包括：
   - 创建 `daily_test_records` 表
   - 创建 `record_test_and_sync_stats` RPC 函数
   - 创建 `get_todays_stats` RPC 函数
   - 创建 `backfill_daily_stats_from_words` 辅助函数

### 回填历史数据（可选）

如果需要将历史数据转换为增量统计格式：

```sql
SELECT * FROM backfill_daily_stats_from_words();
```

这会将历史数据按日期聚合并插入到 `daily_test_records` 表中。

---

## 🧪 测试验证

### 测试场景

1. **场景 1：连续测试不同单词**
   - 测试 10 个新单词（全对）
   - 再测试 10 个新单词（全对）
   - 预期：total=20, correct=20, points=60

2. **场景 2：连续测试相同单词**
   - 测试 10 个单词（全对）
   - 再次测试同样的 10 个单词（全对）
   - 预期：total=20, correct=20, points=60（测试次数累加）

3. **场景 3：混合正确/错误**
   - 测试 10 个单词（5 对 5 错）
   - 再次测试同样的 10 个单词（全对）
   - 预期：
     - total=20
     - correct=15 (5+10)
     - points=45 (15+30)

### 验证方法

1. 打开浏览器控制台，查看日志：
   ```
   [updateLocalStats] Recording test: 10 words, 10 correct, 30 points
   [updateLocalStats] ✅ Database sync completed: { total_tests: 10, correct_tests: 10, total_points: 30 }
   ```

2. 查看 CalendarView 的 Activity Log，验证数字是否正确

3. 检查数据库：
   ```sql
   -- 查看测试记录
   SELECT * FROM daily_test_records WHERE user_id = '...' ORDER BY created_at DESC;

   -- 查看统计数据
   SELECT * FROM daily_stats WHERE user_id = '...' ORDER BY date DESC;
   ```

---

## 📊 统计口径说明

修复后的统计口径：

| 字段 | 含义 | 计算方式 |
|------|------|----------|
| `total_tests` | 总测试次数 | 累加每次测试的单词数（允许重复） |
| `correct_tests` | 正确次数 | 累加每次测试的正确数 |
| `total_points` | 总得分 | 累加每次测试的得分 |
| `unique_words` | 不重复单词数 | 统计 `last_tested=today` 的不同单词数（仅供参考） |

**准确率计算**：
```
accuracy = (total_points / (total_tests * 3)) * 100
```

**示例**：
- 测试 1：10 个单词，全对，30 分
- 测试 2：同样的 10 个单词，全对，30 分
- 结果：
  - total_tests = 20
  - total_points = 60
  - accuracy = 60 / (20 * 3) = 100%

---

## ⚠️ 注意事项

1. **向后兼容**：旧的 `sync_todays_stats_with_timezone` 函数保留，不会破坏现有功能

2. **性能考虑**：`daily_test_records` 表会持续增长，建议：
   - 添加索引：`(user_id, test_date)`
   - 定期归档旧数据（如保留最近 90 天）

3. **时区处理**：所有时间都转换为用户本地时区的日期

4. **并发安全**：使用 `ON CONFLICT` 子句确保并发更新的安全性

---

## 🔧 故障排查

### 问题 1：统计数字不准确

**检查**：
```sql
-- 查看测试记录是否正确插入
SELECT * FROM daily_test_records
WHERE user_id = '...' AND test_date = CURRENT_DATE
ORDER BY created_at DESC;

-- 查看统计数据是否正确累加
SELECT * FROM daily_stats
WHERE user_id = '...' AND date = CURRENT_DATE;
```

### 问题 2：前端显示与数据库不一致

**检查**：
1. 打开浏览器控制台，查看是否有错误日志
2. 检查 `updateLocalStats` 是否被正确调用
3. 检查 `recordTestAndSyncStats` 是否返回成功

### 问题 3：迁移失败

**检查**：
1. 确保 Supabase 项目有足够的权限
2. 检查 RPC 函数是否已创建
3. 查看迁移日志，确认错误信息

---

## 📚 相关文件

- `database/migrations/20250211_add_daily_test_records.sql` - 数据库迁移
- `services/dataService.ts` - 新增的 API 函数
- `App.tsx` - 修改的前端逻辑
- `components/TestModeV2.tsx` - 测试组件（无需修改）

---

## ✨ 总结

这次修复实现了：

✅ **增量统计**：每次测试都被正确记录和累加
✅ **数据一致性**：前端和数据库数据完全一致
✅ **鲁棒性**：支持连续多次测试，数据准确无误
✅ **向后兼容**：不破坏现有功能

**用户现在的体验**：
1. 测试完成 → 点击"RESTORE SYSTEM"
2. 看到"Syncing Neural Database..."提示
3. 等待 1.5 秒（确保数据库同步完成）
4. 跳转到首页，Activity Log 显示准确的数据 ✨
