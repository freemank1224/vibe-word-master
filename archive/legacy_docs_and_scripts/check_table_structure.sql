-- ================================================================
-- 表结构检查脚本
-- ================================================================
-- 此脚本用于检查当前数据库的实际情况

-- 1. 检查 daily_stats 表是否存在以及它的列
SELECT
    'daily_stats Table Check' as check_type,
    table_name,
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_name = 'daily_stats'
AND table_schema = 'public'
ORDER BY ordinal_position;

-- 2. 检查 daily_stats 表的实际数据
SELECT * FROM public.daily_stats LIMIT 5;

-- 3. 检查 words 表的实际列
SELECT
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_name = 'words'
AND table_schema = 'public'
ORDER BY ordinal_position;
