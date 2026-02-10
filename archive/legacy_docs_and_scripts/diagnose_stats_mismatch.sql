-- 诊断统计数据不匹配问题
-- 用于查找为什么显示 20 个单词而不是 10 个的原因

-- =====================================================
-- 1. 检查今天的统计数据（daily_stats 表）
-- =====================================================
SELECT
    '=== DAILY_STATS 表中今天的数据 ===' as section,
    date,
    total as total_words,
    correct as correct_words,
    points,
    updated_at
FROM public.daily_stats
WHERE date = CURRENT_DATE
ORDER BY date DESC
LIMIT 10;

-- =====================================================
-- 2. 检查今天实际测试的单词数量（words 表）
-- =====================================================
SELECT
    '=== WORDS 表中 last_tested 是今天的单词 ===' as section,
    date(last_tested AT TIME ZONE 'Asia/Shanghai') as test_date,
    COUNT(*) as word_count,
    COUNT(CASE WHEN correct THEN 1 END) as correct_count,
    COUNT(CASE WHEN correct THEN 1 END)::float / COUNT(*) * 100 as accuracy_percentage
FROM public.words
WHERE date(last_tested AT TIME ZONE 'Asia/Shanghai') = CURRENT_DATE
GROUP BY date(last_tested AT TIME ZONE 'Asia/Shanghai');

-- =====================================================
-- 3. 列出今天测试的所有单词（详细信息）
-- =====================================================
SELECT
    '=== 今天测试的单词详情 ===' as section,
    id,
    text,
    correct,
    score,
    last_tested,
    date(last_tested AT TIME ZONE 'Asia/Shanghai') as test_date,
    deleted
FROM public.words
WHERE date(last_tested AT TIME ZONE 'Asia/Shanghai') = CURRENT_DATE
ORDER BY last_tested DESC;

-- =====================================================
-- 4. 检查是否有重复的单词（相同文本）
-- =====================================================
SELECT
    '=== 可能的重复单词（相同文本在今天被测试多次）===' as section,
    text,
    COUNT(*) as count,
    string_agg(id::text, ', ') as word_ids,
    string_agg(CASE WHEN correct THEN 'Y' ELSE 'N' END, ', ') as correct_flags
FROM public.words
WHERE date(last_tested AT TIME ZONE 'Asia/Shanghai') = CURRENT_DATE
GROUP BY text
HAVING COUNT(*) > 1;

-- =====================================================
-- 5. 检查 Session 和单词的关联
-- =====================================================
SELECT
    '=== 按 Session 分组的今天测试的单词 ===' as section,
    s.id as session_id,
    s.created_at::date as session_date,
    COUNT(w.id) as word_count_in_session,
    COUNT(CASE WHEN w.last_tested::date = CURRENT_DATE THEN 1 END) as tested_today
FROM public.sessions s
LEFT JOIN public.words w ON w.session_id = s.id
WHERE s.user_id = auth.uid()
GROUP BY s.id, s.created_at
ORDER BY s.created_at DESC
LIMIT 20;

-- =====================================================
-- 6. 检查时区转换是否正确
-- =====================================================
SELECT
    '=== 时区转换检查 ===' as section,
    id,
    text,
    last_tested as last_tested_utc,
    last_tested AT TIME ZONE 'Asia/Shanghai' as last_tested_china,
    date(last_tested) as date_utc,
    date(last_tested AT TIME ZONE 'Asia/Shanghai') as date_china,
    CURRENT_DATE as current_date_utc,
    CURRENT_DATE AT TIME ZONE 'Asia/Shanghai' as current_date_china
FROM public.words
WHERE last_tested IS NOT NULL
ORDER BY last_tested DESC
LIMIT 10;

-- =====================================================
-- 7. 计算实际应该显示的统计
-- =====================================================
SELECT
    '=== 手动计算的正确统计（客户端时区） ===' as section,
    COUNT(*) as expected_total,
    COUNT(CASE WHEN correct THEN 1 END) as expected_correct,
    SUM(CASE WHEN score IS NOT NULL THEN score ELSE CASE WHEN correct THEN 3 ELSE 0 END END) as expected_points
FROM public.words
WHERE date(last_tested AT TIME ZONE 'Asia/Shanghai') = date(now() AT TIME ZONE 'Asia/Shanghai');
