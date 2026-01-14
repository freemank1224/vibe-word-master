-- Fix Delete Permissions and Cleanup Zombie Sessions
-- 该脚本用于修复 Session 删除后仍然显示为空卡片的问题

-- 1. 确保 Sessions 表拥有正确的更新权限 (RLS)
-- 如果 Sessions 表启用了 RLS，必须有策略允许用户更新 deleted 字段
DROP POLICY IF EXISTS "Users can update their own sessions" ON public.sessions;
CREATE POLICY "Users can update their own sessions"
ON public.sessions
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- 2. 清理"僵尸" Session
-- 删除那些没有关联有效单词的 Session (即所有单词都已被标记删除或物理删除的 Session)
-- 这将清除目前界面上已经存在的"空"卡片
UPDATE public.sessions s
SET deleted = true
WHERE s.deleted = false 
AND NOT EXISTS (
    SELECT 1 FROM public.words w 
    WHERE w.session_id = s.id 
    AND (w.deleted = false OR w.deleted IS NULL)
);

-- 3. 再次强制刷新 Schema 缓存
NOTIFY pgrst, 'reload schema';
