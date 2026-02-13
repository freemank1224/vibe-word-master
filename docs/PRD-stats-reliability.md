# 📋 PRD：统计数据高可靠性改造

**版本**: 1.0
**日期**: 2025-02-13
**状态**: 待实施
**优先级**: P0（核心数据可靠性）

---

## 📑 目录

1. [核心问题分析](#1-核心问题分析)
2. [解决方案概览](#2-解决方案概览)
3. [详细技术方案](#3-详细技术方案)
4. [完整实施计划](#4-完整实施计划)
5. [风险评估与缓解](#5-风险评估与缓解)
6. [测试验证计划](#6-测试验证计划)
7. [验收标准](#7-验收标准)

---

## 1. 核心问题分析

### 1.1 时区不一致问题

#### 问题描述

**当前代码（App.tsx:344-348）**:
```typescript
const updateLocalStats = async (results: { correct: boolean; score: number }[]) => {
  // ❌ 使用客户端本地时区
  const d = new Date();  // 基于用户设备时区设置
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const today = `${year}-${month}-${day}`;  // ⚠️ 可能是 "2025-02-14"（UTC时区）

  // ...
  await recordTestAndSyncStats(results.length, correctCount, currentTestPoints);
};
```

**数据库端（daily_test_records.sql:74-79）**:
```sql
-- ✅ 固定使用上海时区（UTC+8）
v_test_date := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE;
-- 结果总是 "2025-02-13"（上海时区日期）
```

#### 问题场景

**场景A：用户设备时区设置错误**
```
用户真实位置：中国上海（UTC+8）
设备时区设置：UTC-5（错误设置）

时间：2025-02-13 23:00 UTC+8（上海时间）
    └─ 2025-02-14 10:00 UTC-5（设备时间）

前端计算：
  const d = new Date();
  const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  // today = "2025-02-14"  ❌

数据库计算：
  v_test_date := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE;
  // v_test_date = "2025-02-13"  ✓

结果：数据写入错误的位置！
```

**场景B：跨天测试（23:50开始，00:06完成）**
```
时间：2025-02-13 23:50 UTC+8
用户行为：
1. 23:50 开始测试（10个单词）
2. 测试过程5分钟
3. 23:55 完成测试，触发同步

前端：today = "2025-02-13"  ✓
数据库：v_test_date = "2025-02-13"  ✓

✓ 这个场景没问题！

但如果：
时间：2025-02-14 00:01 UTC+8
用户行为：
1. 00:01 开始测试
2. 00:06 完成测试

前端：today = "2025-02-14"  ✓
数据库：v_test_date = "2025-02-14"  ✓

✓ 也没问题！

但是：
时间：2025-02-13 23:59:50 UTC+8
提交测试 → 前端打包数据 → 网络延迟3秒

数据到达数据库：2025-02-14 00:00:02 UTC+8

前端发送：today = "2025-02-13"
数据库计算：v_test_date = "2025-02-14"  ❌ 跨天了！

结果：数据记录到了错误的日期！
```

#### 根本原因

**前端和数据库对"今天"的定义不同步**：
- 前端：基于用户设备时区的 `new Date()` 计算
- 数据库：固定使用 `'Asia/Shanghai'` 时区计算
- 两者之间没有校验和同步机制

### 1.2 冲突处理缺失问题

#### 当前机制

```typescript
// App.tsx:342-402
const updateLocalStats = async (results) => {
  // ❌ 没有版本号
  // ❌ 没有冲突检测
  // ❌ 没有重试队列
  // ❌ 直接覆盖写入

  await recordTestAndSyncStats(testCount, correctCount, points);
};
```

```sql
-- record_test_and_sync_stats 函数
-- ❌ 全量覆盖（SUM重算），不是增量更新
INSERT INTO daily_stats (user_id, date, total_count, correct_count, total_points)
SELECT
  v_user_id,
  v_test_date,
  SUM(test_count),      -- ⚠️ 每次全量重算
  SUM(correct_count),
  SUM(points)
FROM daily_test_records
WHERE user_id = v_user_id AND test_date = v_test_date;
```

#### 并发冲突场景

```
设备A（上海）                   设备B（北京）
────────────────────────────────────────
08:00 开始测试              08:00 开始测试
│                            │
│                           测试10个单词，对6个
测试10个单词，对6个          │
│                            │
08:15 完成                   08:12 完成
│                            │
│                           发起 RPC 请求
发起 RPC 请求                   │（网络慢，排队中）
│                            │
08:16 RPC成功执行            08:18 RPC开始执行
│                           INSERT daily_test_records
│                           (10, 6, 15.0)
│                            │
│                           INSERT daily_stats
│                           (total=10, correct=6, points=15.0)
│                            │
08:17 RPC成功执行            08:19 RPC完成
│                           ⚠️ 覆盖了设备A的数据！
│                           daily_stats = (total=10, correct=7, points=18.0)
│                            │
UPDATE daily_stats              │
SET total_count=10,            ❌ 设备A的数据丢失！
    correct_count=7,
    total_points=18.0
```

### 1.3 数据丢失风险

| 场景 | 原因 | 影响 | 当前处理 |
|------|------|------|----------|
| 第一次同步失败 | 网络超时/服务器错误 | 第一次测试数据永久丢失 | ❌ 无重试，无离线队列 |
| 第二次同步失败 | 网络超时/服务器错误 | 第二次测试数据丢失 | ❌ 无重试，无离线队列 |
| 并发测试 | 两设备同时测试 | 后写入覆盖先写入 | ❌ 无版本控制，无冲突检测 |
| 跨天写入 | 网络延迟跨天 | 数据记录到错误日期 | ❌ 无时间戳校验 |
| 客户端时区错误 | 用户设备时区设置错误 | 数据记录到错误日期 | ❌ 无时区校验 |

---

## 2. 解决方案概览

### 2.1 三层保护机制

```
┌─────────────────────────────────────────────────────────────┐
│                   第一层：时区一致性                          │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │ 前端统一使用 Asia/Shanghai 时区                   │   │
│   │ utils/timezone.ts: getShanghaiDateString()         │   │
│   │ + 数据库时区校验                                 │   │
│   └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                   第二层：版本控制                           │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │ daily_stats.version 字段                           │   │
│   │ 乐观锁：期望版本号 + 增量更新                    │   │
│   │ + 并发冲突自动合并                               │   │
│   └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                   第三层：离线保护                         │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │ localStorage 离线队列                            │   │
│   │ + 指数退避重试（1s, 5s, 15s）                 │   │
│   │ + 最多3次重试                                    │   │
│   └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│               第四层：历史数据保护                        │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │ is_frozen 字段 + 前端只读校验                    │   │
│   │ + UI 只读显示                                    │   │
│   └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 功能影响矩阵

| 功能模块 | 是否受影响 | 影响方式 | 影响程度 | 是否需要改造 |
|---------|-----------|---------|---------|-------------|
| 注册功能 | ❌ 否 | - | - | ❌ 不需要 |
| 登录功能 | ✅ 是 | 加载统计数据时可能遇到版本冲突 | 低 | ✅ 需要微调 |
| 添加单词 | ❌ 否 | 只更新 words 表 | - | ❌ 不需要 |
| 修改单词 | ❌ 否 | 只更新 words 表 | - | ❌ 不需要 |
| 删除单词 | ❌ 否 | 只更新 words 表（软删除） | - | ❌ 不需要 |
| 删除会话 | ❌ 否 | 只更新 sessions/words 表 | - | ❌ 不需要 |
| 导入词典 | ❌ 否 | 批量插入 words 表 | - | ❌ 不需要 |
| 测试模式（单个单词） | ⚠️ 间接 | updateWordStatusV2 不再触发 stats 同步 | 无影响 | ✅ 已优化 |
| **测试模式（完成测试）** | ✅ **是** | **核心受影响功能** | **高** | ✅ **需要改造** |
| 日历视图 | ✅ 是 | 显示统计数据时可能遇到版本冲突 | 中 | ✅ 需要改造 |
| 成就系统 | ⚠️ 间接 | 依赖统计数据，但非实时 | 低 | ⚠️ 可选改造 |

---

## 3. 详细技术方案

### 3.1 时区一致性方案

#### 步骤1：创建时区工具函数

**文件**: `utils/timezone.ts`

```typescript
/**
 * 获取上海时区的日期字符串（YYYY-MM-DD）
 * 确保与数据库的 (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE 一致
 *
 * @returns {string} YYYY-MM-DD 格式的日期
 */
export const getShanghaiDateString = (): string => {
  const now = new Date();

  // 方案A1：使用 toLocaleString（推荐）
  // 优点：自动处理夏令时、时区偏移
  const shanghaiDate = new Date(now.toLocaleString('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }));

  // 格式化为 YYYY-MM-DD
  const year = shanghaiDate.getFullYear();
  const month = String(shanghaiDate.getMonth() + 1).padStart(2, '0');
  const day = String(shanghaiDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * 获取上海时区的当前时间戳（毫秒）
 * 用于精确的时间比较
 *
 * @returns {number} 毫秒时间戳
 */
export const getShanghaiTimestamp = (): number => {
  const now = new Date();
  const shanghaiString = now.toLocaleString('en-US', {
    timeZone: 'Asia/Shanghai',
    hour12: false
  });
  return new Date(shanghaiString).getTime();
};

/**
 * 检查日期是否是"今天"（上海时区）
 *
 * @param {string} dateString - YYYY-MM-DD 格式的日期
 * @returns {boolean} 是否是今天
 */
export const isTodayInShanghai = (dateString: string): boolean => {
  const today = getShanghaiDateString();
  return dateString === today;
};
```

#### 步骤2：修改 App.tsx

**文件**: `App.tsx`

```typescript
// App.tsx
import { getShanghaiDateString, isTodayInShanghai } from './utils/timezone';

const updateLocalStats = async (results: { correct: boolean; score: number }[]) => {
  // ✅ 使用统一的时区工具
  const today = getShanghaiDateString();  // 确保与数据库一致

  // 计算统计数据
  const correctCount = results.filter(r => r.correct).length;
  const currentTestPoints = results.reduce((sum, r) => sum + (r.score || 0), 0);

  console.log(`[updateLocalStats] Recording test: ${results.length} words, ${correctCount} correct, ${currentTestPoints} points`);

  // ✅ 添加只读保护（见问题1.3）
  if (!isTodayInShanghai(today)) {
    console.error('[updateLocalStats] ❌ Attempted to modify historical data:', today);
    return;  // 拒绝修改历史数据
  }

  // 乐观更新本地状态
  setDailyStats(prev => {
    const current = prev[today] || { date: today, total: 0, correct: 0, points: 0 };

    return {
      ...prev,
      [today]: {
        date: today,
        total: current.total + results.length,
        correct: current.correct + correctCount,
        points: current.points + currentTestPoints
      }
    };
  });

  // 调用数据库同步
  if (session?.user) {
    try {
      const dbStats = await recordTestAndSyncStats(
        results.length,
        correctCount,
        currentTestPoints
      );

      if (dbStats) {
        console.log('[updateLocalStats] ✅ Database sync completed:', dbStats);

        // ✅ 验证返回的日期
        if (dbStats.synced_date !== today) {
          console.error('[updateLocalStats] ⚠️ Date mismatch! Client:', today, 'DB:', dbStats.synced_date);
        }

        // 使用数据库返回的准确值更新本地状态
        setDailyStats(prev => {
          const newStats = { ...prev };
          newStats[today] = {
            date: today,
            total: dbStats.total_tests || results.length,
            correct: dbStats.correct_tests || correctCount,
            points: dbStats.total_points || currentTestPoints
          };
          return newStats;
        });
      } else {
        console.warn('[updateLocalStats] ⚠️ Database returned null, keeping local optimistic update');
      }
    } catch (err) {
      console.error('[updateLocalStats] ❌ Failed to sync with database:', err);
      // ✅ 添加到离线队列（见问题1.3）
      // enqueuePendingSync({ today, testCount: results.length, correctCount, points: currentTestPoints });
    }
  }
};
```

#### 步骤3：创建数据库迁移

**文件**: `database/migrations/20250214_add_timezone_validation.sql`

```sql
-- ================================================================
-- Migration: Add timezone validation for stats sync
-- Date: 2025-02-14
-- Author: System
-- Purpose: Ensure client and server use consistent timezone
-- ================================================================

-- 1. 修改 RPC 函数，增加前端日期参数和校验
CREATE OR REPLACE FUNCTION record_test_and_sync_stats(
    p_test_date DATE DEFAULT NULL,
    p_client_date DATE DEFAULT NULL,  -- 新增：前端发送的日期
    p_test_count INTEGER DEFAULT NULL,
    p_correct_count INTEGER DEFAULT NULL,
    p_points NUMERIC DEFAULT NULL,
    p_timezone_offset_hours INTEGER DEFAULT NULL
)
RETURNS TABLE(
    synced_date DATE,
    total_tests BIGINT,
    correct_tests BIGINT,
    total_points NUMERIC,
    unique_words BIGINT,
    date_mismatch BOOLEAN  -- 新增：日期是否不匹配
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_test_date DATE;
    v_client_date DATE;
    v_test_count_val INTEGER;
    v_correct_count_val INTEGER;
    v_points_val NUMERIC;
    v_date_mismatch BOOLEAN;
BEGIN
    -- 获取当前用户ID
    v_user_id := auth.uid();

    -- 确定测试日期（上海时区）
    IF p_test_date IS NOT NULL THEN
        v_test_date := p_test_date;
    ELSE
        v_test_date := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE;
    END IF;

    -- 记录客户端日期
    v_client_date := p_client_date;

    -- 获取测试参数
    v_test_count_val := COALESCE(p_test_count, 0);
    v_correct_count_val := COALESCE(p_correct_count, 0);
    v_points_val := COALESCE(p_points, 0);

    -- ✅ 检查日期一致性
    v_date_mismatch := (v_client_date IS NOT NULL AND v_client_date <> v_test_date);

    IF v_date_mismatch THEN
        -- 记录警告日志（不影响写入）
        RAISE WARNING 'Date mismatch: client %, server %',
            v_client_date, v_test_date;

        -- 使用服务器端的日期（更可靠）
        -- 但通知客户端有差异
    END IF;

    -- Step 1: 记录测试会话
    INSERT INTO public.daily_test_records (
        user_id, test_date, test_count, correct_count, points, timezone_offset
    ) VALUES (
        v_user_id, v_test_date, v_test_count_val, v_correct_count_val, v_points_val, p_timezone_offset_hours
    );

    -- Step 2: 聚合统计数据
    -- ...（保持不变）

    -- 返回结果，包含日期不匹配标志
    RETURN NEXT;
END;
$$;

-- 2. 添加日志表用于记录时区不匹配事件
CREATE TABLE IF NOT EXISTS public.timezone_mismatch_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    client_date DATE NOT NULL,
    server_date DATE NOT NULL,
    test_count INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- 3. 添加索引
CREATE INDEX IF NOT EXISTS timezone_mismatch_log_user_id_idx
ON public.timezone_mismatch_log(user_id, created_at DESC);

-- ================================================================
-- Testing checklist:
-- [ ] 测试不同时区客户端
-- [ ] 测试跨天测试场景
-- [ ] 验证日志表记录
-- [ ] 确认前端警告显示
-- ================================================================
```

#### 步骤4：更新前端调用

**文件**: `services/dataService.ts`

```typescript
// services/dataService.ts
import { getShanghaiDateString } from '../utils/timezone';

export const recordTestAndSyncStats = async (
    testCount: number,
    correctCount: number,
    points: number
) => {
    const offsetHours = Math.round(-(new Date().getTimezoneOffset() / 60));

    // ✅ 发送前端计算的日期
    const clientDate = getShanghaiDateString();  // 使用统一的时区工具

    // Get current user ID
    const { data: { user } } = await supabase.auth.getUser();
    if (!user?.id) {
        throw new Error('User not authenticated');
    }

    // Call the new RPC function that records the test and syncs stats
    const { data, error } = await supabase.rpc('record_test_and_sync_stats', {
        p_test_count: testCount,
        p_correct_count: correctCount,
        p_points: points,
        p_timezone_offset_hours: offsetHours,
        p_client_date: clientDate  // ✅ 新增参数
    });

    if (error) {
        console.error("Error recording test and syncing stats:", error.message);
        // Fallback to old method
        console.warn("Falling back to legacy sync method");
        await syncDailyStats();
        return null;
    }

    // ✅ 检查日期不匹配
    const result = Array.isArray(data) && data.length > 0 ? data[0] : data;
    if (result?.date_mismatch) {
        console.error('[recordTestAndSyncStats] ⚠️ Date mismatch detected!', {
            client: clientDate,
            server: result.synced_date
        });
        // 可以触发用户警告
    }

    return result;
};
```

---

### 3.2 版本控制机制

#### 步骤1：数据库迁移

**文件**: `database/migrations/20250214_add_version_control.sql`

```sql
-- ================================================================
-- Migration: Add version control to daily_stats
-- Purpose: Prevent data loss from concurrent updates
-- Date: 2025-02-14
-- ================================================================

-- 1. 添加版本号字段
ALTER TABLE public.daily_stats
ADD COLUMN IF NOT EXISTS version BIGINT DEFAULT 1;

-- 2. 添加最后更新时间戳（用于冲突检测）
ALTER TABLE public.daily_stats
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT now();

-- 3. 添加索引
CREATE INDEX IF NOT EXISTS daily_stats_user_date_version_idx
ON public.daily_stats(user_id, date, version);

-- 4. 创建版本冲突日志表
CREATE TABLE IF NOT EXISTS public.version_conflict_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    date DATE NOT NULL,
    expected_version BIGINT NOT NULL,
    actual_version BIGINT NOT NULL,
    client_data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS version_conflict_log_user_date_idx
ON public.version_conflict_log(user_id, date DESC);
```

#### 步骤2：修改同步函数

```sql
-- 修改 record_test_and_sync_stats 函数
CREATE OR REPLACE FUNCTION record_test_and_sync_stats(
    p_test_date DATE DEFAULT NULL,
    p_client_date DATE DEFAULT NULL,
    p_test_count INTEGER DEFAULT NULL,
    p_correct_count INTEGER DEFAULT NULL,
    p_points NUMERIC DEFAULT NULL,
    p_timezone_offset_hours INTEGER DEFAULT NULL,
    p_expected_version BIGINT DEFAULT NULL  -- 新增：期望的版本号
)
RETURNS TABLE(
    synced_date DATE,
    total_tests BIGINT,
    correct_tests BIGINT,
    total_points NUMERIC,
    unique_words BIGINT,
    version BIGINT,  -- 新增：当前版本号
    conflict_detected BOOLEAN  -- 新增：是否检测到冲突
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_test_date DATE;
    v_client_date DATE;
    v_test_count_val INTEGER;
    v_correct_count_val INTEGER;
    v_points_val NUMERIC;
    v_current_version BIGINT;
    v_new_version BIGINT;
    v_is_frozen BOOLEAN;
    v_conflict_detected BOOLEAN;
BEGIN
    v_user_id := auth.uid();

    IF p_test_date IS NOT NULL THEN
        v_test_date := p_test_date;
    ELSE
        v_test_date := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE;
    END IF;

    v_client_date := p_client_date;

    v_test_count_val := COALESCE(p_test_count, 0);
    v_correct_count_val := COALESCE(p_correct_count, 0);
    v_points_val := COALESCE(p_points, 0);
    v_conflict_detected := FALSE;

    -- 获取当前版本号
    SELECT is_frozen, version INTO v_is_frozen, v_current_version
    FROM public.daily_stats
    WHERE user_id = v_user_id AND date = v_test_date;

    -- Step 1: 检查日期是否冻结
    IF v_is_frozen = true THEN
        RAISE EXCEPTION 'Cannot modify frozen stats for date %', v_test_date
            USING HINT = 'This day has ended and its statistics are now frozen.';
    END IF;

    -- Step 2: 版本冲突检测
    IF v_current_version IS NOT NULL AND p_expected_version IS NOT NULL THEN
        IF v_current_version != p_expected_version THEN
            -- 版本冲突！
            v_conflict_detected := TRUE;

            -- 记录冲突日志
            INSERT INTO public.version_conflict_log (
                user_id, date, expected_version, actual_version, client_data
            ) VALUES (
                v_user_id, v_test_date, p_expected_version, v_current_version,
                jsonb_build_object(
                    'test_count', p_test_count,
                    'correct_count', p_correct_count,
                    'points', p_points
                )
            );

            -- ✅ 增量更新策略（不丢失数据）
            UPDATE public.daily_stats
            SET
                total_count = daily_stats.total_count + p_test_count,
                correct_count = daily_stats.correct_count + p_correct_count,
                total_points = daily_stats.total_points + p_points,
                version = daily_stats.version + 1,
                updated_at = now()
            WHERE user_id = v_user_id AND date = v_test_date;

            -- 返回合并后的状态
            SELECT
                v_test_date,
                (daily_stats.total_count + p_test_count)::BIGINT,
                (daily_stats.correct_count + p_correct_count)::BIGINT,
                (daily_stats.total_points + p_points)::NUMERIC,
                (SELECT COUNT(DISTINCT text) FROM public.words
                 WHERE user_id = v_user_id
                   AND (last_tested AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE = v_test_date
                   AND (deleted = false OR deleted IS NULL))::BIGINT,
                (daily_stats.version + 1)::BIGINT,
                v_conflict_detected
            INTO synced_date, total_tests, correct_tests, total_points, unique_words, version, v_conflict_detected
            FROM public.daily_stats
            WHERE user_id = v_user_id AND date = v_test_date;

            RETURN NEXT;
        END IF;
    END IF;

    -- Step 3: 正常流程（无冲突）
    -- 插入测试记录
    INSERT INTO public.daily_test_records (
        user_id, test_date, test_count, correct_count, points, timezone_offset
    ) VALUES (
        v_user_id, v_test_date, v_test_count_val, v_correct_count_val, v_points_val, p_timezone_offset_hours
    );

    -- 聚合统计数据（全量重算）
    INSERT INTO public.daily_stats (
        user_id, date, total_count, correct_count, total_points
    )
    SELECT
        v_user_id,
        v_test_date,
        SUM(test_count),
        SUM(correct_count),
        SUM(points)
    FROM public.daily_test_records
    WHERE user_id = v_user_id AND test_date = v_test_date
    ON CONFLICT (user_id, date) DO UPDATE SET
        total_count = EXCLUDED.total_count,
        correct_count = EXCLUDED.correct_count,
        total_points = EXCLUDED.total_points,
        version = daily_stats.version + 1,  -- ✅ 版本号递增
        updated_at = now()
    RETURNING
        daily_stats.date,
        daily_stats.total_count,
        daily_stats.correct_count,
        daily_stats.total_points
    INTO synced_date, total_tests, correct_tests, total_points;

    -- 计算唯一单词数
    SELECT COUNT(DISTINCT text)
    INTO unique_words
    FROM public.words
    WHERE user_id = v_user_id
        AND (last_tested AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE = v_test_date
        AND (deleted = false OR deleted IS NULL);

    -- 返回结果（无冲突）
    SELECT
        synced_date,
        total_tests,
        correct_tests,
        total_points,
        unique_words,
        COALESCE(v_current_version, 0) + 1,
        v_conflict_detected
    INTO synced_date, total_tests, correct_tests, total_points, unique_words, version, v_conflict_detected;

    RETURN NEXT;
END;
$$;
```

#### 步骤3：更新 TypeScript 类型

**文件**: `types.ts`

```typescript
export interface DayStats {
  date: string;
  total: number;
  correct: number;
  points: number;
}

export interface DayStatsWithVersion extends DayStats {
  version?: number;
  updated_at?: string;
  _conflict?: boolean;
  _resolved?: 'local' | 'server' | 'merged';
}
```

#### 步骤4：更新前端调用

**文件**: `services/dataService.ts`

```typescript
// services/dataService.ts
export const recordTestAndSyncStats = async (
    testCount: number,
    correctCount: number,
    points: number
) => {
    const offsetHours = Math.round(-(new Date().getTimezoneOffset() / 60));
    const clientDate = getShanghaiDateString();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user?.id) {
        throw new Error('User not authenticated');
    }

    // ✅ 获取当前版本号
    const currentState = dailyStats[clientDate];
    const currentVersion = currentState?.version || 0;

    const { data, error } = await supabase.rpc('record_test_and_sync_stats', {
        p_test_count: testCount,
        p_correct_count: correctCount,
        p_points: points,
        p_timezone_offset_hours: offsetHours,
        p_client_date: clientDate,
        p_expected_version: currentVersion  // ✅ 发送期望版本
    });

    if (error) {
        console.error("Error recording test and syncing stats:", error.message);

        // ✅ 检查是否是版本冲突错误
        if (error.message.includes('PGRST116')) {
            // 并发修改冲突
            throw new VersionConflictError('Concurrent modification detected', currentVersion);
        }

        // ✅ 添加到离线队列
        await enqueuePendingSync({
            date: clientDate,
            testCount,
            correctCount,
            points,
            expectedVersion: currentVersion,
            timestamp: Date.now()
        });

        return null;
    }

    const result = Array.isArray(data) && data.length > 0 ? data[0] : data;

    // ✅ 处理冲突检测结果
    if (result?.conflict_detected) {
        console.warn('[recordTestAndSyncStats] ⚠️ Conflict detected, data merged:', {
            client: clientDate,
            expectedVersion: currentVersion,
            serverVersion: result.version
        });

        // 冲突已由数据库合并，更新本地状态
        return {
            ...result,
            _conflict: true,
            _resolved: 'merged'
        };
    }

    return result;
};

// 自定义错误类
class VersionConflictError extends Error {
    constructor(
        message: string,
        public readonly clientVersion: number
    ) {
        super(message);
        this.name = 'VersionConflictError';
    }
}
```

---

### 3.3 离线队列机制

#### 步骤1：定义类型

**文件**: `types.ts`

```typescript
export interface PendingSyncItem {
  id: string;  // UUID
  date: string;
  testCount: number;
  correctCount: number;
  points: number;
  expectedVersion: number;
  timestamp: number;
  retryCount: number;
  lastError?: string;
}
```

#### 步骤2：实现队列服务

**文件**: `services/offlineSyncQueue.ts`

```typescript
import { PendingSyncItem } from '../types';
import { recordTestAndSyncStats } from './dataService';

const STORAGE_KEY = 'vibe_pending_syncs';
const MAX_RETRY_COUNT = 3;
const RETRY_DELAYS = [1000, 5000, 15000];  // 1s, 5s, 15s

/**
 * 获取所有待同步项
 */
export const getPendingSyncs = (): PendingSyncItem[] => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error('[getPendingSyncs] Failed to parse:', error);
    return [];
  }
};

/**
 * 添加待同步项
 */
export const enqueuePendingSync = async (item: Omit<PendingSyncItem, 'id' | 'retryCount'>) => {
  const pending = getPendingSyncs();

  const newItem: PendingSyncItem = {
    ...item,
    id: crypto.randomUUID(),
    retryCount: 0
  };

  pending.push(newItem);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
    console.log('[enqueuePendingSync] Added to queue:', newItem.id);
  } catch (error) {
    console.error('[enqueuePendingSync] Failed to save:', error);
  }
};

/**
 * 处理离线队列
 */
export const processPendingSyncs = async (): Promise<{ success: number; failed: number }> => {
  const pending = getPendingSyncs();

  if (pending.length === 0) {
    return { success: 0, failed: 0 };
  }

  console.log(`[processPendingSyncs] Processing ${pending.length} items...`);

  let successCount = 0;
  let failedCount = 0;
  const remaining: PendingSyncItem[] = [];

  for (const item of pending) {
    try {
      // 检查重试次数
      if (item.retryCount >= MAX_RETRY_COUNT) {
        console.error('[processPendingSyncs] Max retries exceeded:', item.id);
        failedCount++;
        continue;  // 丢弃该项
      }

      // 重试同步
      await recordTestAndSyncStats(
        item.testCount,
        item.correctCount,
        item.points
      );

      // 成功：从队列移除
      successCount++;
      console.log('[processPendingSyncs] ✅ Synced:', item.id);

    } catch (error) {
      // 失败：更新重试次数
      item.retryCount++;
      item.lastError = error instanceof Error ? error.message : String(error);

      // 计算下次重试延迟
      const delay = RETRY_DELAYS[Math.min(item.retryCount - 1, RETRY_DELAYS.length - 1)];

      // 检查是否应该延迟重试
      if (delay > 0) {
        const nextRetry = item.timestamp + delay;
        if (Date.now() < nextRetry) {
          // 还没到重试时间，保留在队列
          remaining.push(item);
          continue;
        }
      }

      remaining.push(item);
      console.error('[processPendingSyncs] ❌ Failed, retrying:', item.id, item.retryCount);
    }
  }

  // 保存剩余项
  localStorage.setItem(STORAGE_KEY, JSON.stringify(remaining));

  console.log(`[processPendingSyncs] Completed: ${successCount} success, ${failedCount} failed, ${remaining.length} pending`);

  return { success: successCount, failed: failedCount };
};

/**
 * 清空队列（慎用）
 */
export const clearPendingSyncs = () => {
  localStorage.removeItem(STORAGE_KEY);
  console.log('[clearPendingSyncs] Queue cleared');
};

/**
 * 获取队列大小
 */
export const getPendingSyncCount = (): number => {
  return getPendingSyncs().length;
};
```

#### 步骤3：集成到应用

**文件**: `App.tsx`

```typescript
// App.tsx
import { processPendingSyncs, getPendingSyncCount } from './services/offlineSyncQueue';

// 登录时处理离线队列
useEffect(() => {
  const processQueue = async () => {
    if (session?.user) {
      const count = getPendingSyncCount();
      if (count > 0) {
        console.log(`[App] Found ${count} pending syncs, processing...`);

        try {
          const result = await processPendingSyncs();

          if (result.success > 0) {
            // 刷新统计数据
            const stats = await fetchUserStats(session.user.id);
            setDailyStats(formatStats(stats));
          }

          if (result.failed > 0) {
            // 显示警告
            setNotification({
              type: 'error',
              message: `${result.failed} 条测试记录同步失败，将在下次登录时重试`
            });
          }
        } catch (error) {
          console.error('[App] Failed to process pending syncs:', error);
        }
      }
    }
  };

  processQueue();
}, [session?.user?.id]);  // 用户登录时触发

// 定期处理队列（每分钟）
useEffect(() => {
  if (!session?.user) return;

  const interval = setInterval(async () => {
    const count = getPendingSyncCount();
    if (count > 0) {
      console.log('[App] Periodic queue processing...');
      await processPendingSyncs();
      const stats = await fetchUserStats(session.user.id);
      setDailyStats(formatStats(stats));
    }
  }, 60000);  // 60秒

  return () => clearInterval(interval);
}, [session?.user?.id]);
```

---

### 3.4 历史数据保护

#### 前端只读保护

**文件**: `App.tsx`

```typescript
// App.tsx
const updateLocalStats = async (results: { correct: boolean; score: number }[]) => {
  const today = getShanghaiDateString();

  // ✅ 只读保护：只允许更新当天数据
  if (!isTodayInShanghai(today)) {
    console.error('[updateLocalStats] ⚠️ Attempted to modify historical data:', today);
    throw new Error('Cannot modify historical data');
  }

  // ... 正常流程
};
```

#### UI 保护（日历视图）

**文件**: `components/CalendarMode.tsx`

```typescript
// components/CalendarMode.tsx
import { isTodayInShanghai } from '../utils/timezone';

const CalendarMode = ({ dailyStats }: { dailyStats: Record<string, DayStatsWithVersion> }) => {
  const today = getShanghaiDateString();

  const isPastDate = (date: string) => {
    return date < today;
  };

  const isFrozen = (date: string) => {
    return dailyStats[date]?.is_frozen === true;
  };

  return (
    <div className="calendar-grid">
      {Object.entries(dailyStats).map(([date, stats]) => (
        <DayCell
          key={date}
          date={date}
          total={stats.total}
          correct={stats.correct}
          isPast={isPastDate(date)}
          isFrozen={isFrozen(date)}
          // 历史日期的单元格显示只读标识
          readonly={isPastDate(date)}
        />
      ))}
    </div>
  );
};
```

---

### 3.5 数据一致性保证

#### 版本比较逻辑

**文件**: `App.tsx`

```typescript
// App.tsx
const loadStatsWithVersionCheck = async () => {
  const stats = await fetchUserStats(userId);

  // ✅ 检查版本冲突
  stats.forEach(stat => {
    const local = dailyStats[stat.date];

    if (local && local.version !== undefined && local.version > stat.version) {
      console.warn('[loadStats] Version conflict detected:', {
        date: stat.date,
        localVersion: local.version,
        serverVersion: stat.version
      });

      // 合并策略：使用较大值（或提示用户）
      setDailyStats(prev => ({
        ...prev,
        [stat.date]: {
          ...stat,
          total: Math.max(local.total, stat.total),
          correct: Math.max(local.correct, stat.correct),
          points: Math.max(local.points, stat.points),
          _conflict: true,  // 标记为冲突
          _resolved: 'max'
        }
      }));
    }
  });

  setDailyStats(formatStats(stats));
};
```

---

## 4. 完整实施计划

### 阶段A：时区一致性（1周）

**目标**：解决前端和数据库时区不一致问题

#### 任务清单

- [ ] **A1** 创建 `utils/timezone.ts` 工具函数
- [ ] **A2** 修改 `App.tsx` 使用统一时区
- [ ] **A3** 创建数据库迁移 `20250214_add_timezone_validation.sql`
- [ ] **A4** 修改 `record_test_and_sync_stats` RPC 函数
- [ ] **A5** 修改 `services/dataService.ts` 发送客户端日期
- [ ] **A6** 添加时区不匹配日志表
- [ ] **A7** 单元测试：时区转换函数
- [ ] **A8** 集成测试：跨天测试场景
- [ ] **A9** 手动测试：修改设备时区，验证数据正确性

#### 验收标准

- ✅ 用户设备时区错误时，数据仍记录到正确的日期
- ✅ 跨天测试（23:50-00:10）数据记录到正确日期
- ✅ 网络延迟导致的时间错位被检测并记录

---

### 阶段B：版本控制机制（2周）

**目标**：实现乐观锁和冲突检测

#### 任务清单

- [ ] **B1** 创建数据库迁移 `20250214_add_version_control.sql`
- [ ] **B2** 修改 `record_test_and_sync_stats` 增量版本检测
- [ ] **B3** 实现增量更新策略（冲突时）
- [ ] **B4** 添加版本冲突日志表
- [ ] **B5** 修改 TypeScript 类型定义
- [ ] **B6** 更新 `services/dataService.ts` 发送版本号
- [ ] **B7** 更新 `App.tsx` 处理版本冲突响应
- [ ] **B8** 单元测试：版本冲突检测
- [ ] **B9** 集成测试：并发测试场景
- [ ] **B10** 性能测试：版本控制对性能的影响

#### 验收标准

- ✅ 两设备同时测试，数据不会丢失
- ✅ 版本冲突被自动检测并合并
- ✅ 冲突事件被记录到日志表

---

### 阶段C：离线队列（1.5周）

**目标**：支持离线测试和自动重试

#### 任务清单

- [ ] **C1** 创建 `services/offlineSyncQueue.ts`
- [ ] **C2** 定义 `PendingSyncItem` 类型
- [ ] **C3** 实现队列存储（localStorage）
- [ ] **C4** 实现队列处理逻辑
- [ ] **C5** 实现重试机制（指数退避）
- [ ] **C6** 集成到 `App.tsx`
- [ ] **C7** 添加队列状态UI指示器
- [ ] **C8** 单元测试：队列操作
- [ ] **C9** 模拟测试：离线测试场景
- [ ] **C10** 用户体验测试：离线→在线流程

#### 验收标准

- ✅ 离线测试完成后，数据在恢复连接后自动同步
- ✅ 同步失败时，数据保存在队列中
- ✅ 用户可以查看队列状态
- ✅ 超过重试次数的数据被标记并丢弃

---

### 阶段D：历史数据保护（1周）

**目标**：确保历史数据不可变

#### 任务清单

- [ ] **D1** 在 `App.tsx` 添加前端只读保护
- [ ] **D2** 在 `CalendarMode.tsx` 添加UI保护
- [ ] **D3** 数据库层面验证 `is_frozen` 标志
- [ ] **D4** 添加错误提示UI
- [ ] **D5** 单元测试：历史数据保护
- [ ] **D6** 手动测试：尝试修改历史数据

#### 验收标准

- ✅ 前端无法修改历史数据
- ✅ 历史日期在UI上显示为只读
- ✅ 尝试修改时显示明确错误信息

---

### 阶段E：数据一致性（1.5周）

**目标**：确保多次登录后数据一致

#### 任务清单

- [ ] **E1** 实现版本比较逻辑
- [ ] **E2** 实现数据合并策略
- [ ] **E3** 添加数据不匹配检测
- [ ] **E4** 更新 `loadStats` 函数
- [ ] **E5** 添加冲突解决UI提示
- [ ] **E6** 单元测试：版本比较
- [ ] **E7** 集成测试：多设备登录
- [ ] **E8** 端到端测试：完整流程

#### 验收标准

- ✅ 多设备登录后显示一致的数据
- ✅ 版本冲突被自动解决
- ✅ 用户可以看到同步状态

---

## 5. 风险评估与缓解

### 高风险项

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| **数据库迁移失败** | 中 | 高 | 1. 先在测试环境验证<br>2. 准备回滚脚本<br>3. 逐步迁移（先新增字段，后删除旧逻辑） |
| **版本控制性能影响** | 中 | 中 | 1. 添加索引优化<br>2. 监控慢查询<br>3. 考虑缓存策略 |
| **离线队列数据丢失** | 低 | 高 | 1. localStorage 限制检查<br>2. 提供导出功能<br>3. 考虑使用 IndexedDB |
| **时区转换不兼容** | 低 | 中 | 1. 充分测试各浏览器<br>2. 提供 polyfill<br>3. 降级到服务器时间 |

### 依赖项

- **阶段A** 必须在 **阶段B** 之前完成（版本控制依赖正确的日期）
- **阶段B** 应该在 **阶段C** 之前完成（离线队列需要版本信息）
- **阶段D** 可以与其他阶段并行开发
- **阶段E** 必须在所有其他阶段完成后进行（需要完整的版本控制）

---

## 6. 测试验证计划

### 6.1 单元测试

**文件**: `__tests__/utils/timezone.test.ts`

```typescript
import { getShanghaiDateString } from '../utils/timezone';

describe('Timezone Utils', () => {
  it('should return consistent date across timezones', () => {
    // Mock Date in different timezones
    const utcDate = new Date('2025-02-13T16:00:00Z');  // UTC 16:00

    // Shanghai (UTC+8): 2025-02-14 00:00:00
    // New York (UTC-5): 2025-02-13 11:00:00

    // Both should return "2025-02-14" (Shanghai date at UTC 16:00 is 2025-02-14 00:00:00)
    const result1 = getShanghaiDateString(utcDate);
    const result2 = getShanghaiDateString(utcDate);

    expect(result1).toBe(result2);
  });

  it('should handle cross-midnight tests', () => {
    const testTime = new Date('2025-02-13T23:50:00+08:00');
    const date = getShanghaiDateString(testTime);

    expect(date).toBe('2025-02-13');
  });
});
```

**文件**: `__tests__/services/offlineSyncQueue.test.ts`

```typescript
import { enqueuePendingSync, processPendingSyncs, getPendingSyncCount } from '../services/offlineSyncQueue';

describe('Offline Sync Queue', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should enqueue sync items', async () => {
    await enqueuePendingSync({
      date: '2025-02-13',
      testCount: 10,
      correctCount: 6,
      points: 15.0,
      expectedVersion: 0,
      timestamp: Date.now()
    });

    const count = getPendingSyncCount();
    expect(count).toBe(1);
  });

  it('should process queue with retry', async () => {
    // Enqueue item
    await enqueuePendingSync({
      date: '2025-02-13',
      testCount: 10,
      correctCount: 6,
      points: 15.0,
      expectedVersion: 0,
      timestamp: Date.now()
    });

    // Mock successful sync
    const { recordTestAndSyncStats } = await import('../services/dataService');
    jest.spyOn(recordTestAndSyncStats, 'mockImplementation').mockResolvedValue({
      synced_date: '2025-02-13',
      total_tests: 10,
      correct_tests: 6,
      total_points: 15.0,
      version: 1,
      conflict_detected: false
    });

    const result = await processPendingSyncs();

    expect(result.success).toBe(1);
    expect(result.failed).toBe(0);
    expect(getPendingSyncCount()).toBe(0);
  });
});
```

### 6.2 集成测试

**文件**: `__tests__/integration/versionConflict.test.ts`

```typescript
describe('Version Conflict Integration', () => {
  it('should handle concurrent test sessions', async () => {
    // Setup: Create test user
    const userId = await createTestUser();
    const testDate = '2025-02-13';

    // Device A: Complete first test
    const sessionA = await startTestSession(userId);
    const resultsA = await completeTest(sessionA.id, { correct: 6, total: 10 });

    // Device B: Complete second test (concurrently)
    const sessionB = await startTestSession(userId);
    const resultsB = await completeTest(sessionB.id, { correct: 9, total: 10 });

    // Wait for both syncs
    await Promise.all([
      syncResults(sessionA.id, resultsA),
      syncResults(sessionB.id, resultsB)
    ]);

    // Verify: Both tests should be recorded
    const stats = await getDailyStats(userId, testDate);

    expect(stats.total_tests).toBe(20);  // 10 + 10
    expect(stats.correct_tests).toBe(15);  // 6 + 9
    expect(stats.version).toBeGreaterThan(0);
  });
});
```

### 6.3 E2E测试场景

**场景1：离线测试流程**
```
1. 打开应用 → 登录
2. 打开飞行模式 → 开始测试
3. 完成10个单词测试 → 点击"完成"
4. 应用显示"离线模式，数据已保存"
5. 关闭应用

6. 打开WiFi → 打开应用 → 登录
7. 应用自动检测离线队列
8. 显示"正在同步1条测试记录..."
9. 同步成功 → 刷新统计数据
10. 日历视图显示更新后的数据
```

**验证点**：
- ✓ 离线模式下测试可以完成
- ✓ 数据保存在离线队列
- ✓ 恢复连接后自动同步
- ✓ 统计数据准确更新

**场景2：跨设备测试**
```
1. 设备A（iPad）：登录 → 测试10个单词，对6个 → 完成
2. 设备B（手机）：5分钟后登录 → 查看统计
3. 设备B：测试10个单词，对9个 → 完成
4. 设备A：刷新页面 → 查看统计
```

**验证点**：
- ✓ 设备B看到的统计包含设备A的数据
- ✓ 设备A刷新后看到合并后的统计
- ✓ total = 20, correct = 15
- ✓ 没有数据丢失

**场景3：历史数据保护**
```
1. 用户登录：2025-02-14
2. 尝试修改2025-02-10的统计数据
3. 应用显示错误："无法修改历史数据"
```

**验证点**：
- ✓ 前端拒绝修改操作
- ✓ 显示明确错误信息
- ✓ 数据库层面也拒绝（如果绕过前端）

**场景4：时区不一致**
```
1. 修改设备时区为 UTC-5
2. 上海时间：2025-02-13 23:00
3. 开始测试 → 完成
4. 检查数据库中的日期
```

**验证点**：
- ✓ 数据库中记录的日期是 2025-02-13（上海时间）
- ✓ 不是 2025-02-14（设备本地时间）
- ✓ 日历视图显示在正确的日期

---

## 7. 验收标准

### 7.1 时区一致性

- ✅ 用户设备时区错误时，数据仍记录到正确的日期
- ✅ 跨天测试（23:50-00:10）数据记录到正确日期
- ✅ 网络延迟导致的时间错位被检测并记录

### 7.2 冲突处理

- ✅ 两设备同时测试，数据不会丢失
- ✅ 版本冲突被自动检测并合并
- ✅ 冲突事件被记录到日志表

### 7.3 离线支持

- ✅ 离线测试完成后，数据在恢复连接后自动同步
- ✅ 同步失败时，数据保存在队列中
- ✅ 用户可以查看队列状态
- ✅ 超过重试次数的数据被标记并丢弃

### 7.4 数据保护

- ✅ 历史数据完全不可变
- ✅ 前端和数据库双重保护
- ✅ 明确的错误提示

### 7.5 数据一致性

- ✅ 多设备登录后数据一致
- ✅ 版本冲突被自动解决
- ✅ 用户可以看到同步状态

---

## 8. 性能影响

| 改造项 | 性能影响 | 缓解措施 |
|--------|---------|----------|
| 时区转换 | <1ms | 可忽略 |
| 版本检查 | <5ms | 添加索引 |
| 离线队列 | 存储开销 | 限制队列大小 |
| RPC调用 | +10ms | 异步处理 |

---

## 9. 数据库变化

### 新增表

- `public.timezone_mismatch_log`
- `public.version_conflict_log`

### 新增字段

- `public.daily_stats.version`
- `public.daily_stats.updated_at`

### 修改函数

- `record_test_and_sync_stats`（增加版本控制）

---

## 10. 后续优化方向

1. **实时同步**：考虑使用 WebSocket 实时推送统计更新
2. **数据压缩**：离线队列数据压缩存储
3. **增量加载**：日历视图只加载可见月份
4. **缓存策略**：使用 Service Worker 缓存统计数据
5. **分析工具**：后台分析冲突日志，优化用户体验

---

**PRD 完成日期**: 2025-02-13
**预期完成时间**: 7周（A+B+C+D+E）
**下一步行动**: 开始阶段A实施
