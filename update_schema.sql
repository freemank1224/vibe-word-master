-- Activity Log 统计修复补丁
-- 之前的数据库 schema 缺失了 TestModeV2 所需的关键字段，导致统计数据无法持久化。
-- 请在 Supabase 控制台的 SQL Editor 中执行以下脚本以修复表结构。

-- 1. 添加记录最后测试时间的字段 (关键修复)
ALTER TABLE public.words 
ADD COLUMN IF NOT EXISTS last_tested TIMESTAMPTZ DEFAULT NULL;

-- 2. 添加统计和学习进度相关的字段
ALTER TABLE public.words 
ADD COLUMN IF NOT EXISTS error_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS best_time_ms INTEGER DEFAULT NULL;

-- 3. 添加字典数据缓存字段，避免重复请求 API
ALTER TABLE public.words 
ADD COLUMN IF NOT EXISTS phonetic TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS audio_url TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS definition_en TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS definition_cn TEXT DEFAULT NULL;

-- 4. 刷新 Schema 缓存 (Supabase 可能会自动处理，但手动通知更稳妥)
NOTIFY pgrst, 'reload schema';

-- 执行完毕后，请刷新前端页面。Activity Log 将开始正确记录今天的活动。
