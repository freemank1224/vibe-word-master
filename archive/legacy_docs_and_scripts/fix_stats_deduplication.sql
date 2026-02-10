-- ================================================================
-- 修复：统计算法去重 - 每个单词每天只计一次（最后一次测试）
-- ================================================================
-- 问题：当前算法会重复计算同一单词的多次测试
-- 影响：用户可以通过重复测试相同单词来刷分
-- 解决：每个单词每天只计一次，以最后一次测试为准
-- ================================================================

-- 第1部分：更新 sync_todays_stats 函数（去重版本）
-- ================================================================

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

  -- ✅ 去重逻辑：每个单词只取最后一次测试
  WITH latest_tests AS (
    SELECT DISTINCT ON (text)
      text,
      correct,
      score,
      last_tested,
      deleted
    FROM public.words
    WHERE user_id = v_user_id
      AND date(last_tested AT TIME ZONE 'Asia/Shanghai') = v_today
    ORDER BY text, last_tested DESC  -- 取最后（最新）一次测试
  )
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
  FROM latest_tests
  WHERE (deleted = false OR deleted IS NULL);

  -- Upsert 到 daily_stats（使用正确的列名）
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

-- 第2部分：更新动态时区版本的函数
-- ================================================================

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

  -- ✅ 去重逻辑：每个单词只取最后一次测试
  WITH latest_tests AS (
    SELECT DISTINCT ON (text)
      text,
      correct,
      score,
      last_tested,
      deleted
    FROM public.words
    WHERE user_id = v_user_id
      AND date(last_tested + v_interval) = v_client_today
    ORDER BY text, last_tested DESC  -- 取最后（最新）一次测试
  )
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
  FROM latest_tests
  WHERE (deleted = false OR deleted IS NULL);

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

-- 第3部分：更新历史数据回填函数
-- ================================================================

CREATE OR REPLACE FUNCTION consolidate_daily_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- ✅ 去重逻辑：回填历史数据，每个单词每天只计一次
  INSERT INTO public.daily_stats (user_id, date, total_count, correct_count, points)
  SELECT
      user_id,
      date,
      count(*) as total_count,
      count(CASE WHEN correct THEN 1 END) as correct_count,
      sum(coalesce(score, CASE WHEN correct THEN 3 ELSE 0 END)) as points
  FROM (
    SELECT DISTINCT ON (user_id, text, date)
      user_id,
      text,
      correct,
      score,
      date(last_tested AT TIME ZONE 'Asia/Shanghai') as date
    FROM public.words
    WHERE last_tested IS NOT NULL
      AND (deleted = false OR deleted IS NULL)
    ORDER BY user_id, text, date, last_tested DESC  -- 取最后（最新）一次测试
  ) deduplicated_words
  GROUP BY user_id, date
  ON CONFLICT (user_id, date)
  DO UPDATE SET
    total_count = EXCLUDED.total_count,
    correct_count = EXCLUDED.correct_count,
    points = EXCLUDED.points,
    updated_at = now();
END;
$$;

-- 第4部分：立即修复今天的数据
-- ================================================================

-- 手动修复今天的数据（用户 3da531f4-0648-4aca-a268-9450ea8b7e27）
DO $$
DECLARE
  v_user_id uuid := '3da531f4-0648-4aca-a268-9450ea8b7e27';
  v_today date := date(now() AT TIME ZONE 'Asia/Shanghai');
  v_total int;
  v_correct int;
  v_points numeric;
BEGIN
  -- 计算去重后的统计
  WITH latest_tests AS (
    SELECT DISTINCT ON (text)
      text,
      correct,
      score,
      last_tested,
      deleted
    FROM public.words
    WHERE user_id = v_user_id
      AND date(last_tested AT TIME ZONE 'Asia/Shanghai') = v_today
    ORDER BY text, last_tested DESC
  )
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
  FROM latest_tests
  WHERE (deleted = false OR deleted IS NULL);

  -- 更新 daily_stats
  INSERT INTO public.daily_stats (user_id, date, total_count, correct_count, points)
  VALUES (v_user_id, v_today, coalesce(v_total, 0), coalesce(v_correct, 0), coalesce(v_points, 0))
  ON CONFLICT (user_id, date)
  DO UPDATE SET
    total_count = excluded.total_count,
    correct_count = excluded.correct_count,
    points = excluded.points,
    updated_at = now();

  RAISE NOTICE '今天的数据已修复：总单词数=%，正确=%，分数=%', v_total, v_correct, v_points;
END $$;

-- 第5部分：回填所有历史数据
-- ================================================================

SELECT consolidate_daily_stats() as result;

-- 第6部分：验证修复效果
-- ================================================================

-- 显示今天的统计（修复后）
SELECT
    '=== 修复后的今天统计（去重）===' as section,
    date,
    total_count as total_words,
    correct_count as correct_words,
    points
FROM public.daily_stats
WHERE user_id = '3da531f4-0648-4aca-a268-9450ea8b7e27'
  AND date = CURRENT_DATE;

-- 对比：修复前 vs 修复后
SELECT
    '=== 去重前后的对比（今天）===' as section,
    COUNT(*) as with_duplicates,
    COUNT(DISTINCT text) as without_duplicates
FROM public.words
WHERE user_id = '3da531f4-0648-4aca-a268-9450ea8b7e27'
  AND date(last_tested AT TIME ZONE 'Asia/Shanghai') = CURRENT_DATE
  AND (deleted = false OR deleted IS NULL);

-- 刷新 Schema 缓存
NOTIFY pgrst, 'reload schema';

SELECT '✅ 统计算法去重修复完成！' as status;
