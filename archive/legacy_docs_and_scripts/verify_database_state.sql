-- ================================================================
-- 数据库状态验证脚本
-- ================================================================
-- 此脚本用于检查数据库的当前状态，诊断前后端不匹配问题
-- ================================================================

-- ================================================================
-- 1. 检查所有必需的表是否存在
-- ================================================================

SELECT
    'Tables Check' as check_type,
    table_name,
    CASE
        WHEN table_name IN ('words', 'sessions', 'daily_stats', 'user_achievements')
        THEN '✓ EXISTS'
        ELSE '✗ MISSING'
    END as status
FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN ('words', 'sessions', 'daily_stats', 'user_achievements')
ORDER BY table_name;

-- ================================================================
-- 2. 检查 daily_stats 表的列
-- ================================================================

SELECT
    'daily_stats Columns' as check_type,
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_name = 'daily_stats'
AND table_schema = 'public'
ORDER BY ordinal_position;

-- ================================================================
-- 3. 检查 words 表的列（关键字段）
-- ================================================================

SELECT
    'words Columns Check' as check_type,
    column_name,
    data_type,
    is_nullable,
    CASE
        WHEN column_name IN ('id', 'user_id', 'text', 'session_id', 'created_at',
                            'tested', 'correct', 'deleted',
                            'last_tested', 'error_count', 'best_time_ms',
                            'score', 'phonetic', 'audio_url',
                            'definition_en', 'definition_cn', 'tags', 'language')
        THEN '✓ REQUIRED'
        ELSE 'OPTIONAL'
    END as importance
FROM information_schema.columns
WHERE table_name = 'words'
AND table_schema = 'public'
ORDER BY
    CASE
        WHEN column_name = 'id' THEN 1
        WHEN column_name = 'user_id' THEN 2
        WHEN column_name = 'text' THEN 3
        WHEN column_name = 'session_id' THEN 4
        WHEN column_name = 'tested' THEN 5
        WHEN column_name = 'correct' THEN 6
        WHEN column_name = 'deleted' THEN 7
        WHEN column_name = 'last_tested' THEN 8
        WHEN column_name = 'score' THEN 9
        WHEN column_name = 'points' THEN 10
        ELSE 99
    END,
    column_name;

-- ================================================================
-- 4. 检查 sessions 表的列
-- ================================================================

SELECT
    'sessions Columns Check' as check_type,
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_name = 'sessions'
AND table_schema = 'public'
ORDER BY ordinal_position;

-- ================================================================
-- 5. 检查数据完整性
-- ================================================================

-- 5.1 daily_stats 中缺少 points 的记录
SELECT
    'daily_stats Missing points' as check_type,
    COUNT(*) as total_records,
    COUNT(CASE WHEN points IS NULL THEN 1 END) as missing_points,
    COUNT(CASE WHEN points > 0 THEN 1 END) as has_points
FROM public.daily_stats;

-- 5.2 words 中缺少关键字的记录
SELECT
    'words Data Completeness' as check_type,
    COUNT(*) FILTER (WHERE tested = true) as tested_words,
    COUNT(*) FILTER (WHERE last_tested IS NOT NULL) as has_last_tested,
    COUNT(*) FILTER (WHERE score IS NOT NULL) as has_score,
    COUNT(*) FILTER (WHERE deleted = true) as deleted_words
FROM public.words
WHERE deleted = false OR deleted IS NULL;

-- 5.3 检查每天的统计是否合理
SELECT
    'daily_stats Data Sample' as check_type,
    date,
    total,
    correct,
    points,
    CASE
        WHEN total > 0 THEN ROUND(100.0 * correct / total, 2)
        ELSE 0
    END as accuracy_percent,
    CASE
        WHEN points IS NOT NULL AND total > 0 THEN ROUND(points / (total * 3.0) * 100, 2)
        ELSE NULL
    END as points_accuracy_percent
FROM public.daily_stats
ORDER BY date DESC
LIMIT 10;

-- ================================================================
-- 6. 检查数据库函数
-- ================================================================

SELECT
    'Functions Check' as check_type,
    routine_name,
    CASE
        WHEN routine_name IN ('sync_todays_stats_with_timezone', 'consolidate_daily_stats', 'sync_todays_stats')
        THEN '✓ EXISTS'
        ELSE 'OTHER'
    END as status
FROM information_schema.routines
WHERE routine_schema = 'public'
AND routine_type = 'FUNCTION'
ORDER BY routine_name;

-- ================================================================
-- 7. 检查当前用户的基本数据
-- ================================================================

-- 注意：此部分需要在登录后使用 auth.uid() 获取用户ID
-- 这里只显示所有用户的汇总统计

SELECT
    'User Summary' as check_type,
    COUNT(DISTINCT user_id) as total_users,
    COUNT(DISTINCT CASE WHEN deleted = false OR deleted IS NULL THEN user_id END) as active_users
FROM public.words;

SELECT
    'Words per User' as check_type,
    user_id,
    COUNT(*) FILTER (WHERE deleted = false OR deleted IS NULL) as active_words,
    COUNT(*) FILTER (WHERE tested = true AND (deleted = false OR deleted IS NULL)) as tested_words,
    COUNT(*) FILTER (WHERE last_tested IS NOT NULL AND (deleted = false OR deleted IS NULL)) as words_with_last_tested
FROM public.words
GROUP BY user_id
LIMIT 5;

SELECT
    'Stats per User' as check_type,
    user_id,
    COUNT(*) as total_days,
    SUM(total) as total_tests,
    SUM(correct) as total_correct,
    SUM(points) as total_points
FROM public.daily_stats
GROUP BY user_id
LIMIT 5;
