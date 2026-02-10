-- ================================================================
-- 紧急修复脚本：解决统计数据无法保存的问题
-- ================================================================
-- 问题：
-- 1. daily_stats 表缺少必要的列（total, correct）
-- 2. RPC 函数调用失败导致数据无法同步到数据库
-- 3. 刷新页面后统计丢失
-- ================================================================

-- 第 1 部分：确保 daily_stats 表存在并且有正确的列
-- ================================================================

-- 1.1 创建表（如果不存在）
CREATE TABLE IF NOT EXISTS public.daily_stats (
    user_id UUID NOT NULL,
    date DATE NOT NULL,
    total_count INTEGER DEFAULT 0,
    correct_count INTEGER DEFAULT 0,
    points NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, date)
);

-- 1.2 添加缺失的列（如果不存在）
DO $$
BEGIN
    -- total_count 列
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'daily_stats'
        AND column_name = 'total_count'
    ) THEN
        ALTER TABLE public.daily_stats ADD COLUMN total_count INTEGER DEFAULT 0;
        RAISE NOTICE 'Added total_count column to daily_stats';
    END IF;

    -- correct_count 列
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'daily_stats'
        AND column_name = 'correct_count'
    ) THEN
        ALTER TABLE public.daily_stats ADD COLUMN correct_count INTEGER DEFAULT 0;
        RAISE NOTICE 'Added correct_count column to daily_stats';
    END IF;

    -- points 列
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'daily_stats'
        AND column_name = 'points'
    ) THEN
        ALTER TABLE public.daily_stats ADD COLUMN points NUMERIC DEFAULT 0;
        RAISE NOTICE 'Added points column to daily_stats';
    END IF;

    -- 创建索引（如果不存在）
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'daily_stats'
        AND indexname = 'idx_daily_stats_user_date'
    ) THEN
        CREATE INDEX idx_daily_stats_user_date ON public.daily_stats(user_id, date);
        RAISE NOTICE 'Created index on daily_stats';
    END IF;
END $$;

-- ================================================================
-- 第 2 部分：创建/更新同步函数
-- ================================================================

-- 2.1 简化版同步函数（使用固定时区 UTC+8）
CREATE OR REPLACE FUNCTION sync_todays_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id uuid;
  v_today date;
  v_total int;
  v_correct int;
  v_points numeric;
BEGIN
  v_user_id := auth.uid();

  -- 使用 Asia/Shanghai (UTC+8) 时区
  v_today := date(now() AT TIME ZONE 'Asia/Shanghai');

  -- 从 words 表聚合今天的统计数据
  SELECT
    count(*),
    count(CASE WHEN correct THEN 1 END),
    sum(
      CASE
        WHEN score IS NOT NULL THEN score
        WHEN correct THEN 3  -- 旧数据回退：正确的单词如果没有分数，默认3分
        ELSE 0
      END
    )
  INTO v_total, v_correct, v_points
  FROM public.words
  WHERE user_id = v_user_id
    AND date(last_tested AT TIME ZONE 'Asia/Shanghai') = v_today
    AND (deleted = false OR deleted IS NULL);

  -- Upsert 到 daily_stats
  INSERT INTO public.daily_stats (user_id, date, total_count, correct_count, points)
  VALUES (v_user_id, v_today, coalesce(v_total, 0), coalesce(v_correct, 0), coalesce(v_points, 0))
  ON CONFLICT (user_id, date)
  DO UPDATE SET
    total_count = excluded.total_count,
    correct_count = excluded.correct_count,
    points = excluded.points,
    updated_at = now();
END;
$$;

-- 2.2 动态时区版同步函数
CREATE OR REPLACE FUNCTION sync_todays_stats_with_timezone(p_timezone_offset_hours int DEFAULT 8)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id uuid;
  v_client_today date;
  v_total int;
  v_correct int;
  v_points numeric;
  v_interval interval;
BEGIN
  v_user_id := auth.uid();

  -- 构建时区间隔（默认 UTC+8）
  v_interval := (p_timezone_offset_hours || ' hours')::interval;

  -- 根据客户端时区确定"今天"
  v_client_today := date(now() + v_interval);

  -- 聚合今天的单词数据
  SELECT
    count(*),
    count(CASE WHEN correct THEN 1 END),
    sum(
      CASE
        WHEN score IS NOT NULL THEN score
        WHEN correct THEN 3
        ELSE 0
      END
    )
  INTO v_total, v_correct, v_points
  FROM public.words
  WHERE user_id = v_user_id
    AND date(last_tested + v_interval) = v_client_today
    AND (deleted = false OR deleted IS NULL);

  -- Upsert 到 daily_stats
  INSERT INTO public.daily_stats (user_id, date, total_count, correct_count, points)
  VALUES (v_user_id, v_client_today, coalesce(v_total, 0), coalesce(v_correct, 0), coalesce(v_points, 0))
  ON CONFLICT (user_id, date)
  DO UPDATE SET
    total_count = excluded.total_count,
    correct_count = excluded.correct_count,
    points = excluded.points,
    updated_at = now();
END;
$$;

-- ================================================================
-- 第 3 部分：历史数据整合（回填）
-- ================================================================

-- 3.1 从 words 表重新计算历史统计数据
CREATE OR REPLACE FUNCTION consolidate_daily_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- 清空旧的统计数据（可选，如果你想完全重新计算）
  -- TRUNCATE public.daily_stats;

  -- 从 words 表聚合历史数据到 daily_stats
  INSERT INTO public.daily_stats (user_id, date, total_count, correct_count, points)
  SELECT
      user_id,
      date(last_tested AT TIME ZONE 'Asia/Shanghai') as date,
      count(*) as total_count,
      count(CASE WHEN correct THEN 1 END) as correct_count,
      sum(coalesce(score, CASE WHEN correct THEN 3 ELSE 0 END)) as points
  FROM public.words
  WHERE last_tested IS NOT NULL
    AND (deleted = false OR deleted IS NULL)
  GROUP BY user_id, date(last_tested AT TIME ZONE 'Asia/Shanghai')
  ON CONFLICT (user_id, date)
  DO UPDATE SET
    total_count = EXCLUDED.total_count,
    correct_count = EXCLUDED.correct_count,
    points = EXCLUDED.points,
    updated_at = now();
END;
$$;

-- ================================================================
-- 第 4 部分：执行修复
-- ================================================================

-- 4.1 回填历史数据
SELECT consolidate_daily_stats() as result;

-- 4.2 检查修复结果
DO $$
DECLARE
    v_stats_count INT;
    v_total_words INT;
    v_tested_words INT;
BEGIN
    SELECT COUNT(*) INTO v_stats_count FROM public.daily_stats;
    SELECT COUNT(*) INTO v_total_words FROM public.words WHERE (deleted = false OR deleted IS NULL);
    SELECT COUNT(*) INTO v_tested_words FROM public.words WHERE tested = true AND (deleted = false OR deleted IS NULL);

    RAISE NOTICE '';
    RAISE NOTICE '========== 修复完成报告 ==========';
    RAISE NOTICE 'daily_stats 记录数: %', v_stats_count;
    RAISE NOTICE '总单词数: %', v_total_words;
    RAISE NOTICE '已测试单词数: %', v_tested_words;
    RAISE NOTICE '====================================';
END $$;

-- ================================================================
-- 第 5 部分：刷新 Schema 缓存
-- ================================================================

NOTIFY pgrst, 'reload schema';

-- 完成
SELECT 'Database fix completed successfully!' as status;
