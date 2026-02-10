# 🚀 快速修复指南

## 问题
Supabase MCP 没有访问项目 `mkdxdlsjisqazermmfoe` 的权限

## 解决方案：手动执行 SQL（5分钟完成）

### 步骤 1: 打开 Supabase SQL Editor

1. 复制这个链接到浏览器：
   ```
   https://app.supabase.com/project/mkdxdlsjisqazermmfoe/sql
   ```

2. 如果提示登录，请登录你的 Supabase 账户

### 步骤 2: 执行验证脚本

在 SQL Editor 中新建查询，复制以下内容：

```sql
-- 检查 daily_stats 表的列
SELECT
    column_name,
    data_type,
    CASE
        WHEN column_name = 'points' THEN '🔴 关键字段'
        ELSE '普通字段'
    END as importance
FROM information_schema.columns
WHERE table_name = 'daily_stats'
AND table_schema = 'public'
ORDER BY ordinal_position;
```

点击 "Run" 执行，查看结果中是否有 `points` 列。

### 步骤 3: 执行修复脚本

如果 `points` 列不存在，复制以下 SQL 并执行：

```sql
-- ===============================================
-- 安全修复：添加缺失的列
-- ===============================================

-- 1. 添加 daily_stats.points
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'daily_stats'
        AND column_name = 'points'
    ) THEN
        ALTER TABLE public.daily_stats ADD COLUMN points NUMERIC DEFAULT 0;
        RAISE NOTICE '✓ Added points column to daily_stats';
    ELSE
        RAISE NOTICE '○ points column already exists';
    END IF;
END $$;

-- 2. 添加 words 表缺失字段
DO $$
BEGIN
    -- V2 测试字段
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'last_tested') THEN
        ALTER TABLE public.words ADD COLUMN last_tested TIMESTAMPTZ DEFAULT NULL;
        RAISE NOTICE '✓ Added last_tested to words';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'error_count') THEN
        ALTER TABLE public.words ADD COLUMN error_count INTEGER DEFAULT 0;
        RAISE NOTICE '✓ Added error_count to words';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'best_time_ms') THEN
        ALTER TABLE public.words ADD COLUMN best_time_ms INTEGER DEFAULT NULL;
        RAISE NOTICE '✓ Added best_time_ms to words';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'score') THEN
        ALTER TABLE public.words ADD COLUMN score NUMERIC DEFAULT NULL;
        RAISE NOTICE '✓ Added score to words';
    END IF;

    -- 词典字段
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'phonetic') THEN
        ALTER TABLE public.words ADD COLUMN phonetic TEXT DEFAULT NULL;
        RAISE NOTICE '✓ Added phonetic to words';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'audio_url') THEN
        ALTER TABLE public.words ADD COLUMN audio_url TEXT DEFAULT NULL;
        RAISE NOTICE '✓ Added audio_url to words';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'definition_en') THEN
        ALTER TABLE public.words ADD COLUMN definition_en TEXT DEFAULT NULL;
        RAISE NOTICE '✓ Added definition_en to words';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'definition_cn') THEN
        ALTER TABLE public.words ADD COLUMN definition_cn TEXT DEFAULT NULL;
        RAISE NOTICE '✓ Added definition_cn to words';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'language') THEN
        ALTER TABLE public.words ADD COLUMN language TEXT DEFAULT 'en';
        RAISE NOTICE '✓ Added language to words';
    END IF;

    -- 软删除和标签
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'deleted') THEN
        ALTER TABLE public.words ADD COLUMN deleted BOOLEAN DEFAULT false;
        RAISE NOTICE '✓ Added deleted to words';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'deleted_at') THEN
        ALTER TABLE public.words ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;
        RAISE NOTICE '✓ Added deleted_at to words';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'tags') THEN
        ALTER TABLE public.words ADD COLUMN tags TEXT[] DEFAULT ARRAY['Custom'];
        RAISE NOTICE '✓ Added tags to words';
    END IF;
END $$;

-- 3. 添加 sessions 表缺失字段
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sessions' AND column_name = 'deleted') THEN
        ALTER TABLE public.sessions ADD COLUMN deleted BOOLEAN DEFAULT false;
        RAISE NOTICE '✓ Added deleted to sessions';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sessions' AND column_name = 'deleted_at') THEN
        ALTER TABLE public.sessions ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;
        RAISE NOTICE '✓ Added deleted_at to sessions';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sessions' AND column_name = 'library_tag') THEN
        ALTER TABLE public.sessions ADD COLUMN library_tag TEXT DEFAULT 'Custom';
        RAISE NOTICE '✓ Added library_tag to sessions';
    END IF;
END $$;

-- 4. 回填历史数据
UPDATE public.daily_stats
SET points = correct * 3
WHERE points = 0 AND correct > 0;

RAISE NOTICE '✓ Backfilled points for % records', ROW_COUNT;

-- 5. 刷新 Schema 缓存
NOTIFY pgrst, 'reload schema';

RAISE NOTICE '✓ Schema cache reload requested';
RAISE NOTICE '';
RAISE NOTICE '═══════════════════════════════════════';
RAISE NOTICE '修复完成！请检查底部的 NOTICE 消息';
RAISE NOTICE '═══════════════════════════════════════';
```

### 步骤 4: 验证修复结果

执行以下 SQL 验证：

```sql
-- 验证所有关键字段是否存在
SELECT
    table_name,
    column_name,
    '✓' as status
FROM information_schema.columns
WHERE table_schema = 'public'
AND table_name IN ('daily_stats', 'words', 'sessions')
AND column_name IN (
    'points', 'last_tested', 'error_count', 'best_time_ms',
    'score', 'deleted', 'tags', 'library_tag'
)
ORDER BY table_name, column_name;
```

### 步骤 5: 测试前端功能

1. 清除浏览器缓存：
   - **Mac**: `Cmd + Shift + R`
   - **Windows**: `Ctrl + Shift + R`

2. 验证功能：
   - [ ] 日历颜色多样化（不是全绿）
   - [ ] 悬停日期显示 Activity Log
   - [ ] Activity Log 显示准确率百分比
   - [ ] 可以删除 Session
   - [ ] 库功能正常

---

## 需要帮助？

执行完成后，告诉我：
1. 是否看到底部的 NOTICE 消息？
2. 显示了哪些 "✓ Added" 消息？
3. 前端功能是否恢复正常？

如果还有问题，我会帮你进一步诊断！
