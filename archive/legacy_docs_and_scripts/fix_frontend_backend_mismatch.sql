-- ================================================================
-- 前后端数据不匹配修复脚本
-- ================================================================
-- 此脚本将修复以下问题：
-- 1. Activity Log 日历颜色显示问题（points 字段）
-- 2. daily_stats 表的数据完整性
-- 3. words 表的数据回填
-- 4. 确保所有必需的数据库函数都存在
-- ================================================================

-- ================================================================
-- 第 1 部分：验证并添加缺失的列
-- ================================================================

-- 1.1 确保 daily_stats 表有 points 列
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'daily_stats'
        AND column_name = 'points'
    ) THEN
        ALTER TABLE public.daily_stats ADD COLUMN points NUMERIC DEFAULT 0;
        RAISE NOTICE 'Added points column to daily_stats table';
    ELSE
        RAISE NOTICE 'points column already exists in daily_stats table';
    END IF;
END $$;

-- 1.2 确保 words 表有所有必需的字段
DO $$
BEGIN
    -- last_tested 字段（必需）
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'last_tested'
    ) THEN
        ALTER TABLE public.words ADD COLUMN last_tested TIMESTAMPTZ DEFAULT NULL;
        RAISE NOTICE 'Added last_tested column to words table';
    END IF;

    -- error_count 字段（必需）
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'error_count'
    ) THEN
        ALTER TABLE public.words ADD COLUMN error_count INTEGER DEFAULT 0;
        RAISE NOTICE 'Added error_count column to words table';
    END IF;

    -- best_time_ms 字段（必需）
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'best_time_ms'
    ) THEN
        ALTER TABLE public.words ADD COLUMN best_time_ms INTEGER DEFAULT NULL;
        RAISE NOTICE 'Added best_time_ms column to words table';
    END IF;

    -- score 字段（必需）
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'score'
    ) THEN
        ALTER TABLE public.words ADD COLUMN score NUMERIC DEFAULT NULL;
        RAISE NOTICE 'Added score column to words table';
    END IF;

    -- phonetic 字段（可选）
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'phonetic'
    ) THEN
        ALTER TABLE public.words ADD COLUMN phonetic TEXT DEFAULT NULL;
        RAISE NOTICE 'Added phonetic column to words table';
    END IF;

    -- audio_url 字段（可选）
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'audio_url'
    ) THEN
        ALTER TABLE public.words ADD COLUMN audio_url TEXT DEFAULT NULL;
        RAISE NOTICE 'Added audio_url column to words table';
    END IF;

    -- definition_en 字段（可选）
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'definition_en'
    ) THEN
        ALTER TABLE public.words ADD COLUMN definition_en TEXT DEFAULT NULL;
        RAISE NOTICE 'Added definition_en column to words table';
    END IF;

    -- definition_cn 字段（可选）
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'definition_cn'
    ) THEN
        ALTER TABLE public.words ADD COLUMN definition_cn TEXT DEFAULT NULL;
        RAISE NOTICE 'Added definition_cn column to words table';
    END IF;

    -- deleted 字段（软删除必需）
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'deleted'
    ) THEN
        ALTER TABLE public.words ADD COLUMN deleted BOOLEAN DEFAULT false;
        RAISE NOTICE 'Added deleted column to words table';
    END IF;

    -- deleted_at 字段（软删除必需）
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'deleted_at'
    ) THEN
        ALTER TABLE public.words ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;
        RAISE NOTICE 'Added deleted_at column to words table';
    END IF;

    -- language 字段（可选）
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'language'
    ) THEN
        ALTER TABLE public.words ADD COLUMN language TEXT DEFAULT 'en';
        RAISE NOTICE 'Added language column to words table';
    END IF;
END $$;

-- 1.3 确保 sessions 表有软删除字段
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'sessions'
        AND column_name = 'deleted'
    ) THEN
        ALTER TABLE public.sessions ADD COLUMN deleted BOOLEAN DEFAULT false;
        RAISE NOTICE 'Added deleted column to sessions table';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'sessions'
        AND column_name = 'deleted_at'
    ) THEN
        ALTER TABLE public.sessions ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;
        RAISE NOTICE 'Added deleted_at column to sessions table';
    END IF;

    -- library_tag 字段（词库标签）
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'sessions'
        AND column_name = 'library_tag'
    ) THEN
        ALTER TABLE public.sessions ADD COLUMN library_tag TEXT DEFAULT 'Custom';
        RAISE NOTICE 'Added library_tag column to sessions table';
    END IF;
END $$;

-- ================================================================
-- 第 2 部分：回填历史数据
-- ================================================================

-- 2.1 为已有的 daily_stats 回填 points
-- 如果有 correct 和 total 但没有 points 的记录，按旧规则计算（每个 correct = 3分）
DO $$
DECLARE
    row_count INT;
BEGIN
    UPDATE public.daily_stats
    SET points = correct * 3
    WHERE points = 0 AND correct > 0;

    GET DIAGNOSTICS row_count = ROW_COUNT;
    RAISE NOTICE 'Backfilled points for % daily_stats rows', row_count;
END $$;

-- 2.2 为 words 表回填 last_tested
-- 对于 tested=true 但 last_tested 为空的记录，使用 created_at 作为近似值
DO $$
DECLARE
    row_count INT;
BEGIN
    UPDATE public.words
    SET last_tested = created_at
    WHERE tested = true AND last_tested IS NULL;

    GET DIAGNOSTICS row_count = ROW_COUNT;
    RAISE NOTICE 'Backfilled last_tested for % words', row_count;
END $$;

-- 2.3 为 words 表回填 score
-- 对于 correct=true 但 score 为空的记录，设置默认分数 3
DO $$
DECLARE
    row_count INT;
BEGIN
    UPDATE public.words
    SET score = 3
    WHERE correct = true AND (score IS NULL OR score = 0);

    GET DIAGNOSTICS row_count = ROW_COUNT;
    RAISE NOTICE 'Backfilled score for % words', row_count;
END $$;

-- 2.4 为 words 表回填 tags
-- 对于没有 tags 的记录，设置为 ['Custom']
DO $$
DECLARE
    row_count INT;
BEGIN
    UPDATE public.words
    SET tags = ARRAY['Custom']::TEXT[]
    WHERE tags IS NULL;

    GET DIAGNOSTICS row_count = ROW_COUNT;
    RAISE NOTICE 'Backfilled tags for % words', row_count;
END $$;

-- ================================================================
-- 第 3 部分：创建或更新数据库函数
-- ================================================================

-- 3.1 创建/更新 sync_todays_stats_with_timezone 函数
CREATE OR REPLACE FUNCTION sync_todays_stats_with_timezone(p_timezone_offset_hours int)
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

  -- 构建时间间隔
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
        WHEN correct THEN 3 -- 旧数据回退
        ELSE 0
      END
    )
  INTO v_total, v_correct, v_points
  FROM public.words
  WHERE user_id = v_user_id
  AND date(last_tested + v_interval) = v_client_today
  AND (deleted = false OR deleted IS NULL);

  -- Upsert 到 daily_stats
  INSERT INTO public.daily_stats (user_id, date, total, correct, points)
  VALUES (v_user_id, v_client_today, coalesce(v_total, 0), coalesce(v_correct, 0), coalesce(v_points, 0))
  ON CONFLICT (user_id, date)
  DO UPDATE SET
    total = excluded.total,
    correct = excluded.correct,
    points = excluded.points,
    updated_at = now();
END;
$$;

-- 3.2 创建/更新 consolidate_daily_stats 函数（用于历史数据回填）
CREATE OR REPLACE FUNCTION consolidate_daily_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- 从 words 表聚合历史数据到 daily_stats
    INSERT INTO public.daily_stats (user_id, date, total, correct, points)
    SELECT
        user_id,
        date(last_tested) as date,
        count(*) as total,
        count(CASE WHEN correct THEN 1 END) as correct,
        sum(coalesce(score, CASE WHEN correct THEN 3 ELSE 0 END)) as points
    FROM public.words
    WHERE last_tested IS NOT NULL
    AND (deleted = false OR deleted IS NULL)
    GROUP BY user_id, date(last_tested)
    ON CONFLICT (user_id, date)
    DO UPDATE SET
        total = EXCLUDED.total,
        correct = EXCLUDED.correct,
        points = EXCLUDED.points,
        updated_at = now();
END;
$$;

-- 3.3 运行历史数据整合（可选，可能需要一些时间）
-- 取消下面的注释来执行历史数据整合
-- SELECT consolidate_daily_stats();
-- RAISE NOTICE 'Consolidated historical stats';

-- ================================================================
-- 第 4 部分：验证和报告
-- ================================================================

-- 4.1 检查 daily_stats 表的完整性
DO $$
DECLARE
    v_total_stats INT;
    v_stats_with_points INT;
    v_stats_without_points INT;
BEGIN
    SELECT COUNT(*) INTO v_total_stats FROM public.daily_stats;
    SELECT COUNT(*) INTO v_stats_with_points FROM public.daily_stats WHERE points IS NOT NULL;
    SELECT COUNT(*) INTO v_stats_without_points FROM public.daily_stats WHERE points IS NULL OR points = 0;

    RAISE NOTICE '';
    RAISE NOTICE '========== 数据完整性报告 ==========';
    RAISE NOTICE 'daily_stats 总记录数: %', v_total_stats;
    RAISE NOTICE '有 points 字段的记录: %', v_stats_with_points;
    RAISE NOTICE '缺少 points 字段的记录: %', v_stats_without_points;
END $$;

-- 4.2 检查 words 表的完整性
DO $$
DECLARE
    v_total_words INT;
    v_words_tested INT;
    v_words_with_last_tested INT;
    v_words_with_score INT;
BEGIN
    SELECT COUNT(*) INTO v_total_words FROM public.words WHERE (deleted = false OR deleted IS NULL);
    SELECT COUNT(*) INTO v_words_tested FROM public.words WHERE tested = true AND (deleted = false OR deleted IS NULL);
    SELECT COUNT(*) INTO v_words_with_last_tested FROM public.words WHERE last_tested IS NOT NULL AND (deleted = false OR deleted IS NULL);
    SELECT COUNT(*) INTO v_words_with_score FROM public.words WHERE score IS NOT NULL AND (deleted = false OR deleted IS NULL);

    RAISE NOTICE '';
    RAISE NOTICE 'words 表统计:';
    RAISE NOTICE '活跃单词总数: %', v_total_words;
    RAISE NOTICE '已测试单词: %', v_words_tested;
    RAISE NOTICE '有 last_tested 的单词: %', v_words_with_last_tested;
    RAISE NOTICE '有 score 的单词: %', v_words_with_score;
    RAISE NOTICE '====================================';
    RAISE NOTICE '';
END $$;

-- ================================================================
-- 第 5 部分：刷新 Schema 缓存
-- ================================================================

NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
    RAISE NOTICE 'Schema cache reloaded. Please refresh your application.';
END $$;
