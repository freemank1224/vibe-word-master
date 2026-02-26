# 排行榜初始化指南

## 概述

排行榜系统包含两个阶段：

1. **初始化阶段**（一次性）：回填所有历史排名数据
2. **运行阶段**（日常）：实时更新当天排名，历史排名永久冻结

---

## 初始化步骤

### 1. 部署数据库迁移

```bash
# 部署主排行榜表和函数
supabase db push

# 部署初始化函数
supabase migration up --file database/migrations/20260226_initialize_leaderboard_history.sql
```

### 2. 部署 Edge Functions

```bash
# 部署初始化函数
supabase functions deploy init-leaderboard

# 部署日常更新函数
supabase functions deploy update-leaderboard
```

### 3. 执行初始化

**通过 Supabase Dashboard**：
1. 进入 Edge Functions
2. 选择 `init-leaderboard`
3. 点击 "Invoke" 按钮
4. 等待初始化完成（可能需要几分钟）

**通过命令行**：
```bash
curl -X POST https://your-project.supabase.co/functions/v1/init-leaderboard \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json"
```

### 4. 验证初始化

在 Supabase SQL Editor 中运行：

```sql
-- 检查最早的排行榜记录
SELECT
    rank_date,
    COUNT(*) as user_count,
    MIN(rank_position) as min_rank,
    MAX(rank_position) as max_rank
FROM public.leaderboards
GROUP BY rank_date
ORDER BY rank_date ASC
LIMIT 10;

-- 检查最新的排行榜记录（今天）
SELECT
    rank_position,
    total_score,
    tests_completed,
    new_words_added,
    accuracy_rate
FROM public.leaderboards
WHERE rank_date = CURRENT_DATE
ORDER BY rank_position
LIMIT 10;
```

---

## 日常维护

### 实时更新（今天）

```bash
curl -X POST https://your-project.supabase.co/functions/v1/update-leaderboard \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-02-26"}'
```

### 设置定时任务（可选）

在 SQL Editor 中运行：

```sql
-- 启用 pg_cron 扩展
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 每天 UTC 17:00（北京时间次日凌晨 1:00）冻结前一天的排名
SELECT cron.schedule(
  'freeze-daily-leaderboard',
  '0 17 * * *',
  $$ SELECT calculate_daily_leaderboard((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::DATE - INTERVAL '1 day'); $$
);

-- 每 10 分钟更新今天的实时排行榜
SELECT cron.schedule(
  'update-realtime-leaderboard',
  '*/10 * * * *',
  $$ SELECT calculate_daily_leaderboard(CURRENT_DATE); $$
);
```

---

## 工作原理

### 初始化阶段（一次性）

- 扫描 `daily_stats` 表，找到最早的日期
- 从最早日期到昨天，逐日计算排行榜
- 为每一天生成完整的排名数据
- 计算并存储排名位置（rank_position）

**初始化后状态**：
- 历史日期：完整的冻结排名数据
- 今天：空的，等待实时更新

### 运行阶段（日常）

**实时更新**（每 10 分钟）：
- 计算**今天**的排行榜
- 更新所有用户的实时分数
- 更新排名位置
- 前端显示 "（Real-time）"

**每日冻结**（UTC 17:00）：
- 冻结**昨天**的排行榜
- 生成最终排名
- 前端显示 "（Frozen）"
- 历史排名永久不变

---

## 数据结构

### leaderboards 表

```sql
CREATE TABLE public.leaderboards (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    rank_date DATE NOT NULL,

    -- 计算得分 (0-1000)
    total_score NUMERIC NOT NULL,
    test_count_score NUMERIC NOT NULL,
    new_words_score NUMERIC NOT NULL,
    accuracy_score NUMERIC NOT NULL,
    difficulty_score NUMERIC NOT NULL,

    -- 原始指标
    tests_completed INTEGER NOT NULL,
    new_words_added INTEGER NOT NULL,
    accuracy_rate NUMERIC NOT NULL,
    avg_difficulty NUMERIC NOT NULL,

    -- 排名位置
    rank_position INTEGER,

    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),

    UNIQUE(user_id, rank_date)
);
```

---

## 故障排查

### 没有历史数据

**原因**：尚未执行初始化

**解决**：运行 `init-leaderboard` Edge Function

### 今天的排行榜为空

**原因**：初始化只回填到昨天，今天的需要实时更新

**解决**：
```sql
-- 手动触发今天的排名计算
SELECT calculate_daily_leaderboard(CURRENT_DATE);
```

### 排名位置为空

**原因**：数据插入了但未计算排名

**解决**：
```sql
-- 重新计算今天的排名位置
UPDATE public.leaderboards l1
SET rank_position = subquery.row_num
FROM (
    SELECT
        user_id,
        ROW_NUMBER() OVER (ORDER BY total_score DESC, user_id) as row_num
    FROM public.leaderboards
    WHERE rank_date = CURRENT_DATE
) subquery
WHERE l1.user_id = subquery.user_id
    AND l1.rank_date = CURRENT_DATE;
```

---

## API 参考

### 数据库函数

#### `initialize_leaderboard_history()`
一次性初始化，回填所有历史数据。

**返回**：
- `start_date`: 最早日期
- `end_date`: 最晚日期（昨天）
- `days_processed`: 处理的天数
- `total_users_processed`: 总用户记录数
- `processing_time`: 处理时间

#### `calculate_daily_leaderboard(p_date DATE DEFAULT NULL)`
计算指定日期的排行榜。

**参数**：
- `p_date`: 日期（NULL = 今天）

**返回**：
- `users_processed`: 处理的用户数
- `calculation_timestamp`: 计算时间

#### `get_leaderboard(p_date, p_limit, p_include_current_user)`
获取排行榜数据。

**参数**：
- `p_date`: 查询日期（NULL = 今天）
- `p_limit`: 返回数量（默认 100）
- `p_include_current_user`: 是否包含当前用户（默认 true）

**返回**：排行榜记录列表

---

## 注意事项

⚠️ **初始化时间**：根据数据量，可能需要 5-15 分钟

⚠️ **服务角色密钥**：初始化 Edge Function 需要 service_role_key

⚠️ **一次性操作**：`initialize_leaderboard_history()` 只需执行一次

⚠️ **时区**：所有日期使用北京时间（UTC+8）

⚠️ **未来日期**：系统自动阻止查询和计算未来日期的排行榜
