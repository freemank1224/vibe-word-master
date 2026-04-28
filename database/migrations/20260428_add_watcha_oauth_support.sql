-- ============================================
-- 观猹 OAuth2 用户映射表
-- ============================================
-- 用于关联观猹用户ID和Supabase auth用户
-- 创建时间: 2026-04-28

-- 创建观猹用户映射表
CREATE TABLE IF NOT EXISTS public.watcha_user_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supabase_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  watcha_user_id BIGINT NOT NULL,
  watcha_nickname TEXT,
  watcha_avatar_url TEXT,
  watcha_email TEXT,
  watcha_phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(watcha_user_id)
);

-- 创建索引以提高查询性能
CREATE INDEX IF NOT EXISTS idx_watcha_user_mappings_supabase_user_id ON public.watcha_user_mappings(supabase_user_id);
CREATE INDEX IF NOT EXISTS idx_watcha_user_mappings_watcha_user_id ON public.watcha_user_mappings(watcha_user_id);

-- 启用RLS
ALTER TABLE public.watcha_user_mappings ENABLE ROW LEVEL SECURITY;

-- RLS策略: 用户只能查看自己的映射
CREATE POLICY "Users can view own Watcha mapping"
  ON public.watcha_user_mappings
  FOR SELECT
  USING (supabase_user_id = auth.uid());

-- RLS策略: 用户可以插入自己的映射（通过触发器处理）
CREATE POLICY "Users can insert own Watcha mapping"
  ON public.watcha_user_mappings
  FOR INSERT
  WITH CHECK (supabase_user_id = auth.uid());

-- RLS策略: 用户可以更新自己的映射
CREATE POLICY "Users can update own Watcha mapping"
  ON public.watcha_user_mappings
  FOR UPDATE
  USING (supabase_user_id = auth.uid());

-- 创建更新时间戳触发器
CREATE OR REPLACE FUNCTION public.update_watcha_mapping_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER watcha_user_mappings_updated_at
  BEFORE UPDATE ON public.watcha_user_mappings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_watcha_mapping_updated_at();

-- 添加注释
COMMENT ON TABLE public.watcha_user_mappings IS '观猹OAuth用户映射表，关联观猹用户ID和Supabase auth用户';
COMMENT ON COLUMN public.watcha_user_mappings.supabase_user_id IS 'Supabase auth用户ID';
COMMENT ON COLUMN public.watcha_user_mappings.watcha_user_id IS '观猹平台用户ID';
COMMENT ON COLUMN public.watcha_user_mappings.watcha_nickname IS '观猹用户昵称';
COMMENT ON COLUMN public.watcha_user_mappings.watcha_avatar_url IS '观猹用户头像URL';
COMMENT ON COLUMN public.watcha_user_mappings.watcha_email IS '观猹用户邮箱（如果已授权）';
COMMENT ON COLUMN public.watcha_user_mappings.watcha_phone IS '观猹用户手机号（如果已授权）';
