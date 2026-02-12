-- ================================================================
-- Migration: 修改 error_count 字段类型为 NUMERIC
-- Date: 2025-02-12
-- Author: Claude Code
-- Purpose: 支持 hint 模式下的精细错误追踪（0.3, 0.5, 0.8, 1.0 增量）
-- ================================================================

-- ================================================================
-- Rationale
-- ================================================================
--
-- 当前问题：
--   1. Hint 模式下用户错误次数不被记录
--   2. error_count 为 INTEGER 类型，无法存储小数增量
--   3. 导致 AI 算法无法精确识别单词掌握程度
--
-- 解决方案：
--   将 error_count 从 INTEGER 改为 NUMERIC 类型
--   支持精细的小数增量：0.3, 0.5, 0.8, 1.0
--   与 score 字段保持一致（都是 NUMERIC）
--
-- ================================================================

-- ================================================================
-- Migration Steps
-- ================================================================

-- Step 1: 创建备份列（保持原数据）
ALTER TABLE public.words ADD COLUMN IF NOT EXISTS error_count_backup NUMERIC;

COMMENT ON COLUMN public.words.error_count_backup IS '临时备份列，用于迁移 error_count 字段类型';

-- Step 2: 迁移数据（将 INTEGER 转换为 NUMERIC）
UPDATE public.words
SET error_count_backup = error_count::NUMERIC
WHERE error_count_backup IS NULL;

-- Step 3: 删除旧列
ALTER TABLE public.words DROP COLUMN error_count;

-- Step 4: 重命名新列为 error_count
ALTER TABLE public.words RENAME COLUMN error_count_backup TO error_count;

-- Step 5: 设置默认值
ALTER TABLE public.words ALTER COLUMN error_count SET DEFAULT 0;

-- Step 6: 添加注释
COMMENT ON COLUMN public.words.error_count IS '错误次数（支持小数，hint 模式下精细追踪）';

-- ================================================================
-- Verification Query (执行后运行此查询验证)
-- ================================================================
--
-- 检查字段类型
-- SELECT column_name, data_type, numeric_precision, numeric_scale
-- FROM information_schema.columns
-- WHERE table_name = 'words' AND column_name = 'error_count';
--
-- 预期结果：
--   data_type = 'numeric'
--   numeric_precision = NULL (无限制精度)
--   numeric_scale = NULL (无限制小数位)
--
-- 验证数据完整性
-- SELECT id, text, error_count, score
-- FROM words
-- WHERE user_id = 'your_test_user_id'
-- LIMIT 5;
--
-- ================================================================

-- ================================================================
-- Rollback Script (如果需要回滚)
-- ================================================================
-- /*
-- ALTER TABLE public.words DROP COLUMN error_count;
-- ALTER TABLE public.words RENAME COLUMN error_count_backup TO error_count;
-- COMMENT ON COLUMN public.words.error_count IS '错误次数';
-- */
-- ================================================================
