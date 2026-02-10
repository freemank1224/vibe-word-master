-- ================================================================
-- 安全修复脚本 - 基于实际表结构
-- ================================================================
-- 此脚本会先检查列是否存在，再执行操作

-- ================================================================
-- 第 1 部分：检查并添加缺失的列
-- ================================================================

-- 1.1 daily_stats.points 列
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

-- 1.2 words 表的所有必需字段
DO $$
BEGIN
    -- last_tested
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'last_tested'
    ) THEN
        ALTER TABLE public.words ADD COLUMN last_tested TIMESTAMPTZ DEFAULT NULL;
        RAISE NOTICE 'Added last_tested column to words table';
    END IF;

    -- error_count
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'error_count'
    ) THEN
        ALTER TABLE public.words ADD COLUMN error_count INTEGER DEFAULT 0;
        RAISE NOTICE 'Added error_count column to words table';
    END IF;

    -- best_time_ms
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'best_time_ms'
    ) THEN
        ALTER TABLE public.words ADD COLUMN best_time_ms INTEGER DEFAULT NULL;
        RAISE NOTICE 'Added best_time_ms column to words table';
    END IF;

    -- score
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'score'
    ) THEN
        ALTER TABLE public.words ADD COLUMN score NUMERIC DEFAULT NULL;
        RAISE NOTICE 'Added score column to words table';
    END IF;

    -- phonetic
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'phonetic'
    ) THEN
        ALTER TABLE public.words ADD COLUMN phonetic TEXT DEFAULT NULL;
        RAISE NOTICE 'Added phonetic column to words table';
    END IF;

    -- audio_url
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'audio_url'
    ) THEN
        ALTER TABLE public.words ADD COLUMN audio_url TEXT DEFAULT NULL;
        RAISE NOTICE 'Added audio_url column to words table';
    END IF;

    -- definition_en
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'definition_en'
    ) THEN
        ALTER TABLE public.words ADD COLUMN definition_en TEXT DEFAULT NULL;
        RAISE NOTICE 'Added definition_en column to words table';
    END IF;

    -- definition_cn
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'definition_cn'
    ) THEN
        ALTER TABLE public.words ADD COLUMN definition_cn TEXT DEFAULT NULL;
        RAISE NOTICE 'Added definition_cn column to words table';
    END IF;

    -- deleted
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'deleted'
    ) THEN
        ALTER TABLE public.words ADD COLUMN deleted BOOLEAN DEFAULT false;
        RAISE NOTICE 'Added deleted column to words table';
    END IF;

    -- deleted_at
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'deleted_at'
    ) THEN
        ALTER TABLE public.words ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;
        RAISE NOTICE 'Added deleted_at column to words table';
    END IF;

    -- language
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'words'
        AND column_name = 'language'
    ) THEN
        ALTER TABLE public.words ADD COLUMN language TEXT DEFAULT 'en';
        RAISE NOTICE 'Added language column to words table';
    END IF;
END $$;

-- 1.3 sessions 表的软删除字段
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
-- 第 2 部分：显示当前表结构信息（完整诊断）
-- ================================================================

DO $$
DECLARE
    v_column_record RECORD;
    v_column_count INTEGER := 0;
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '========== daily_stats 表完整结构 ==========';

    -- 显示所有列及其类型
    FOR v_column_record IN
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'daily_stats'
        AND table_schema = 'public'
        ORDER BY ordinal_position
    LOOP
        v_column_count := v_column_count + 1;
        RAISE NOTICE '  列 #%: % (%) nullable:%',
            v_column_count,
            v_column_record.column_name,
            v_column_record.data_type,
            v_column_record.is_nullable;
    END LOOP;

    IF v_column_count = 0 THEN
        RAISE NOTICE '  ⚠️  警告: daily_stats 表没有任何列！';
    END IF;

    RAISE NOTICE '=================================================';
END $$;

DO $$
DECLARE
    v_has_correct BOOLEAN;
    v_has_total BOOLEAN;
    v_has_points BOOLEAN;
    v_has_user_id BOOLEAN;
    v_has_date BOOLEAN;
BEGIN
    -- 检查关键字段
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'daily_stats'
        AND column_name = 'correct'
    ) INTO v_has_correct;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'daily_stats'
        AND column_name = 'total'
    ) INTO v_has_total;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'daily_stats'
        AND column_name = 'points'
    ) INTO v_has_points;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'daily_stats'
        AND column_name = 'user_id'
    ) INTO v_has_user_id;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'daily_stats'
        AND column_name = 'date'
    ) INTO v_has_date;

    RAISE NOTICE '';
    RAISE NOTICE '========== 关键字段存在性检查 ==========';
    RAISE NOTICE 'user_id: %', CASE WHEN v_has_user_id THEN '✓ 存在' ELSE '✗ 缺失' END;
    RAISE NOTICE 'date: %', CASE WHEN v_has_date THEN '✓ 存在' ELSE '✗ 缺失' END;
    RAISE NOTICE 'correct: %', CASE WHEN v_has_correct THEN '✓ 存在' ELSE '✗ 缺失' END;
    RAISE NOTICE 'total: %', CASE WHEN v_has_total THEN '✓ 存在' ELSE '✗ 缺失' END;
    RAISE NOTICE 'points: %', CASE WHEN v_has_points THEN '✓ 存在' ELSE '✗ 缺失' END;
    RAISE NOTICE '=================================================';

    -- 根据检查结果给出建议
    IF NOT v_has_correct OR NOT v_has_total THEN
        RAISE NOTICE '';
        RAISE NOTICE '⚠️  警告: daily_stats 表缺少关键字段！';
        RAISE NOTICE '这意味着可能需要使用 words 表来重建统计数据。';
        RAISE NOTICE '请不要手动执行任何 UPDATE 操作，请联系技术支持。';
    END IF;
END $$;

-- ================================================================
-- 第 3 部分：数据回填（仅当列存在时执行）
-- ================================================================

DO $$
DECLARE
    v_has_correct BOOLEAN;
    v_has_total BOOLEAN;
    v_has_points BOOLEAN;
    v_row_count INT;
BEGIN
    -- 检查必需的列是否存在
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'daily_stats'
        AND column_name = 'correct'
    ) INTO v_has_correct;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'daily_stats'
        AND column_name = 'total'
    ) INTO v_has_total;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'daily_stats'
        AND column_name = 'points'
    ) INTO v_has_points;

    -- 只有当所有必需列都存在时才执行回填
    IF v_has_correct AND v_has_total AND v_has_points THEN
        RAISE NOTICE '';
        RAISE NOTICE '========== 执行数据回填 ==========';

        -- 为已有的 daily_stats 回填 points
        UPDATE public.daily_stats
        SET points = correct * 3
        WHERE points = 0 AND correct > 0;

        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE '已为 % 条 daily_stats 记录回填 points', v_row_count;

        RAISE NOTICE '====================================';
    ELSE
        RAISE NOTICE '';
        RAISE NOTICE '⚠️  跳过数据回填 - 缺少必需的列';
        RAISE NOTICE '需要 correct: %, total: %, points: %',
            CASE WHEN v_has_correct THEN '✓' ELSE '✗' END,
            CASE WHEN v_has_total THEN '✓' ELSE '✗' END,
            CASE WHEN v_has_points THEN '✓' ELSE '✗' END;
    END IF;
END $$;

-- ================================================================
-- 第 4 部分：手动验证查询（请在 SQL Editor 中单独运行）
-- ================================================================

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '========== 手动验证查询 ==========';
    RAISE NOTICE '请在 Supabase SQL Editor 中单独运行以下查询来检查数据：';
    RAISE NOTICE '';
    RAISE NOTICE '1. 查看 daily_stats 表结构和数据：';
    RAISE NOTICE '   SELECT * FROM public.daily_stats ORDER BY date DESC LIMIT 10;';
    RAISE NOTICE '';
    RAISE NOTICE '2. 查看 words 表结构和数据：';
    RAISE NOTICE '   SELECT id, text, correct, tested, last_tested, score, deleted';
    RAISE NOTICE '   FROM public.words WHERE deleted = false OR deleted IS NULL LIMIT 10;';
    RAISE NOTICE '';
    RAISE NOTICE '3. 统计数据：';
    RAISE NOTICE '   SELECT COUNT(*) as total, COUNT(CASE WHEN correct THEN 1 END) as correct_count';
    RAISE NOTICE '   FROM public.words WHERE deleted = false OR deleted IS NULL;';
    RAISE NOTICE '====================================';
END $$;

-- ================================================================
-- 第 5 部分：刷新 Schema 缓存
-- ================================================================

NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE 'Schema cache reload request sent.';
    RAISE NOTICE '请检查上方的表结构诊断信息，确认所有列都已正确添加。';
END $$;
