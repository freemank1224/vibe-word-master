-- Soft Delete Support
-- 为了保留用户的学习历史统计（Activity Log），我们采用软删除机制。
-- 删除 Session 或 Word 时，不再从数据库物理移除，而是标记为已删除。

-- 1. 为 words 表添加 deleted 字段
ALTER TABLE public.words 
ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE;

-- 2. 为 sessions 表添加 deleted 字段
ALTER TABLE public.sessions 
ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE;

-- 3. 刷新 Schema
NOTIFY pgrst, 'reload schema';
