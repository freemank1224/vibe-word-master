-- =============================================================================
-- VIBE WORD MASTER — 数据库完整快照
-- 快照时间: 2026-03-02
-- 数据库: Supabase (mkdxdlsjisqazermmfoe)
-- 用途: 从零恢复当前数据库结构（Schema、函数、触发器、RLS、Storage）
-- 注意: 本文件不含用户数据，仅含结构定义（DDL）
-- =============================================================================
-- 恢复步骤:
--   1. 在 Supabase SQL Editor 中运行本文件
--   2. 确保 auth schema 已由 Supabase 自动创建
--   3. 按章节顺序执行（扩展 → 函数 → 表 → 索引 → 触发器 → RLS → Storage）
-- =============================================================================


-- =============================================================================
-- 第一章: 扩展
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- =============================================================================
-- 第二章: 基础工具函数（触发器依赖）
-- =============================================================================

-- updated_at 自动更新触发器函数（通用版）
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

-- updated_at 自动更新触发器函数（pronunciation 专用，带 search_path）
CREATE OR REPLACE FUNCTION public.set_row_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- 单词 key 标准化函数（lowercase + trim + 去多余空格，IMMUTABLE）
CREATE OR REPLACE FUNCTION public.normalize_word_key(input_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT lower(regexp_replace(trim(coalesce(input_text, '')), '\s+', ' ', 'g'))
$$;


-- =============================================================================
-- 第三章: 核心业务表
-- =============================================================================

-- -----------------------------------------------------------------------------
-- sessions — 学习会话（单词库）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sessions (
    id             uuid         NOT NULL DEFAULT gen_random_uuid(),
    user_id        uuid         NOT NULL,
    name           varchar(255) DEFAULT NULL,
    library_tag    varchar(100) DEFAULT 'Custom',
    target_count   integer      DEFAULT 0,
    deleted        boolean      DEFAULT false,
    created_at     timestamptz  DEFAULT now(),
    updated_at     timestamptz  DEFAULT now(),
    deleted_at     timestamptz  DEFAULT NULL,
    word_count     integer      DEFAULT 0,
    CONSTRAINT sessions_new_pkey PRIMARY KEY (id)
);

-- -----------------------------------------------------------------------------
-- words — 单词（独立存储，通过 session_id 关联会话）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.words (
    id                   uuid         NOT NULL DEFAULT gen_random_uuid(),
    user_id              uuid         NOT NULL,
    text                 varchar(255) NOT NULL,
    correct              boolean      DEFAULT false,
    tested               boolean      DEFAULT false,
    last_tested          timestamptz,
    best_time_ms         integer,
    score                numeric      DEFAULT 0,
    phonetic             text,
    audio_url            text,
    definition_en        text,
    definition_cn        text,
    image_path           text,
    language             varchar(10)  DEFAULT 'en',
    tags                 text[]       DEFAULT '{}',
    deleted_at           timestamptz,
    created_at           timestamptz  DEFAULT now(),
    updated_at           timestamptz  DEFAULT now(),
    deleted              boolean      DEFAULT false,
    session_id           uuid,
    error_count          numeric      DEFAULT 0,
    consecutive_correct  integer      DEFAULT 0,
    pronunciation_asset_id uuid,
    CONSTRAINT words_unique_pkey PRIMARY KEY (id),
    CONSTRAINT unique_user_word UNIQUE (user_id, text),
    CONSTRAINT words_session_id_fkey1 FOREIGN KEY (session_id)
        REFERENCES public.sessions(id) ON DELETE CASCADE,
    CONSTRAINT words_pronunciation_asset_id_fkey FOREIGN KEY (pronunciation_asset_id)
        REFERENCES public.pronunciation_assets(id) ON DELETE SET NULL
);

-- -----------------------------------------------------------------------------
-- session_words — 会话与单词的多对多关联表
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.session_words (
    id          uuid        NOT NULL DEFAULT gen_random_uuid(),
    session_id  uuid        NOT NULL,
    word_id     uuid        NOT NULL,
    position    integer     DEFAULT 0,
    added_at    timestamptz DEFAULT now(),
    CONSTRAINT session_words_pkey PRIMARY KEY (id),
    CONSTRAINT unique_session_word UNIQUE (session_id, word_id),
    CONSTRAINT session_words_session_id_fkey FOREIGN KEY (session_id)
        REFERENCES public.sessions(id) ON DELETE CASCADE,
    CONSTRAINT session_words_word_id_fkey FOREIGN KEY (word_id)
        REFERENCES public.words(id) ON DELETE CASCADE
);

-- -----------------------------------------------------------------------------
-- daily_stats — 每日统计汇总（可冻结）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_stats (
    id            uuid        NOT NULL DEFAULT gen_random_uuid(),
    user_id       uuid        NOT NULL,
    date          date        NOT NULL,
    total_count   integer     DEFAULT 0,
    correct_count integer     DEFAULT 0,
    total_points  numeric     DEFAULT 0,
    is_frozen     boolean     DEFAULT false,
    created_at    timestamptz DEFAULT now(),
    updated_at    timestamptz DEFAULT now(),
    points        numeric     DEFAULT 0,
    version       bigint      DEFAULT 1,
    CONSTRAINT daily_stats_pkey PRIMARY KEY (id),
    CONSTRAINT unique_user_date UNIQUE (user_id, date)
);

-- -----------------------------------------------------------------------------
-- daily_test_records — 每日测试明细记录（每次 session 结束后写入）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_test_records (
    id               uuid        NOT NULL DEFAULT gen_random_uuid(),
    user_id          uuid        NOT NULL,
    test_date        date        NOT NULL,
    test_count       integer     NOT NULL,
    correct_count    integer     NOT NULL,
    points           numeric     NOT NULL,
    timezone_offset  integer,
    created_at       timestamptz DEFAULT now(),
    CONSTRAINT daily_test_records_pkey PRIMARY KEY (id)
);

-- -----------------------------------------------------------------------------
-- user_settings — 用户设置（时区等）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_settings (
    id               uuid         NOT NULL DEFAULT gen_random_uuid(),
    user_id          uuid         NOT NULL,
    timezone_offset  integer      NOT NULL,
    timezone_name    varchar(100),
    created_at       timestamptz  DEFAULT now(),
    CONSTRAINT user_settings_pkey PRIMARY KEY (id),
    CONSTRAINT unique_user_settings UNIQUE (user_id)
);

-- -----------------------------------------------------------------------------
-- user_achievements — 用户成就
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_achievements (
    id             uuid        NOT NULL DEFAULT gen_random_uuid(),
    user_id        uuid        NOT NULL,
    achievement_id text        NOT NULL,
    unlocked_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_achievements_pkey PRIMARY KEY (id),
    CONSTRAINT user_achievements_user_id_achievement_id_key UNIQUE (user_id, achievement_id)
);

-- -----------------------------------------------------------------------------
-- leaderboards — 每日排行榜快照
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.leaderboards (
    id               uuid        NOT NULL DEFAULT gen_random_uuid(),
    user_id          uuid        NOT NULL,
    rank_date        date        NOT NULL,
    total_score      numeric     NOT NULL,
    test_count_score numeric     NOT NULL,
    new_words_score  numeric     NOT NULL,
    accuracy_score   numeric     NOT NULL,
    difficulty_score numeric     NOT NULL,
    tests_completed  integer     NOT NULL,
    new_words_added  integer     NOT NULL,
    accuracy_rate    numeric     NOT NULL,
    avg_difficulty   numeric     NOT NULL,
    rank_position    integer,
    created_at       timestamptz DEFAULT now(),
    updated_at       timestamptz DEFAULT now(),
    CONSTRAINT leaderboards_pkey PRIMARY KEY (id),
    CONSTRAINT leaderboards_user_id_rank_date_key UNIQUE (user_id, rank_date)
);


-- =============================================================================
-- 第四章: 发音相关表
-- =============================================================================

-- -----------------------------------------------------------------------------
-- pronunciation_assets — 发音音频资产（全局共享，非用户级别）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pronunciation_assets (
    id               uuid         NOT NULL DEFAULT gen_random_uuid(),
    normalized_word  text         NOT NULL,
    display_word     text         NOT NULL,
    language         varchar(10)  NOT NULL DEFAULT 'en',
    accent           varchar(16)  NOT NULL DEFAULT 'en-US',
    voice            text         NOT NULL DEFAULT 'default',
    model_provider   text         NOT NULL DEFAULT 'unknown',
    model_name       text         NOT NULL DEFAULT 'unknown',
    model_version    text         NOT NULL DEFAULT 'v1',
    codec            varchar(16)  NOT NULL DEFAULT 'opus',
    sample_rate_hz   integer      NOT NULL DEFAULT 16000,
    bitrate_kbps     integer,
    duration_ms      integer,
    file_size_bytes  bigint,
    storage_bucket   text         NOT NULL DEFAULT 'word-audio',
    storage_path     text         NOT NULL,
    public_url       text,
    sha256           text,
    source_type      text         NOT NULL DEFAULT 'tts',
    status           text         NOT NULL DEFAULT 'pending',
    error_message    text,
    created_at       timestamptz  NOT NULL DEFAULT now(),
    updated_at       timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT pronunciation_assets_pkey PRIMARY KEY (id),
    CONSTRAINT pronunciation_assets_variant_uniq UNIQUE (
        normalized_word, language, accent, voice, codec, sample_rate_hz,
        model_provider, model_name, model_version
    )
);

-- -----------------------------------------------------------------------------
-- pronunciation_generation_jobs — 发音生成任务队列
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pronunciation_generation_jobs (
    id           uuid       NOT NULL DEFAULT gen_random_uuid(),
    asset_id     uuid       NOT NULL,
    status       text       NOT NULL DEFAULT 'pending',
    priority     smallint   NOT NULL DEFAULT 5,
    retry_count  integer    NOT NULL DEFAULT 0,
    max_retries  integer    NOT NULL DEFAULT 3,
    scheduled_at timestamptz NOT NULL DEFAULT now(),
    started_at   timestamptz,
    finished_at  timestamptz,
    last_error   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pronunciation_generation_jobs_pkey PRIMARY KEY (id),
    CONSTRAINT pronunciation_generation_jobs_asset_uniq UNIQUE (asset_id),
    CONSTRAINT pronunciation_generation_jobs_asset_id_fkey FOREIGN KEY (asset_id)
        REFERENCES public.pronunciation_assets(id) ON DELETE CASCADE
);

-- -----------------------------------------------------------------------------
-- pronunciation_rebuild_runs — 发音重建任务运行记录（Admin 管理）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pronunciation_rebuild_runs (
    run_id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
    requested_by           uuid,
    requested_email        text,
    status                 text        NOT NULL DEFAULT 'running',
    total                  integer     NOT NULL DEFAULT 0,
    done                   integer     NOT NULL DEFAULT 0,
    generated              integer     NOT NULL DEFAULT 0,
    skipped                integer     NOT NULL DEFAULT 0,
    failed                 integer     NOT NULL DEFAULT 0,
    uniqueness_mode        text        NOT NULL DEFAULT 'strict',
    concurrency            integer     NOT NULL DEFAULT 3,
    message                text,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    finished_at            timestamptz,
    max_requests_per_minute integer    NOT NULL DEFAULT 20,
    CONSTRAINT pronunciation_rebuild_runs_pkey PRIMARY KEY (run_id)
);


-- =============================================================================
-- 第五章: 辅助日志表
-- =============================================================================

-- timezone_mismatch_log — 时区不一致日志（调试用）
CREATE TABLE IF NOT EXISTS public.timezone_mismatch_log (
    id          uuid        NOT NULL DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL,
    client_date date        NOT NULL,
    server_date date        NOT NULL,
    test_count  integer,
    created_at  timestamptz DEFAULT now(),
    CONSTRAINT timezone_mismatch_log_pkey PRIMARY KEY (id)
);

-- version_conflict_log — 版本冲突日志（乐观锁冲突记录）
CREATE TABLE IF NOT EXISTS public.version_conflict_log (
    id               uuid        NOT NULL DEFAULT gen_random_uuid(),
    user_id          uuid        NOT NULL,
    date             date        NOT NULL,
    expected_version bigint      NOT NULL,
    actual_version   bigint      NOT NULL,
    client_data      jsonb,
    created_at       timestamptz DEFAULT now(),
    CONSTRAINT version_conflict_log_pkey PRIMARY KEY (id)
);


-- =============================================================================
-- 第六章: 历史备份表（迁移过程保留，生产中仅只读）
-- =============================================================================

-- 注意: 以下表是开发过程中的备份，不由应用代码写入，可视情况保留或清理

CREATE TABLE IF NOT EXISTS public.daily_stats_current_backup (
    id            uuid,
    user_id       uuid,
    date          date,
    total_count   integer,
    correct_count integer,
    total_points  numeric,
    is_frozen     boolean,
    created_at    timestamptz,
    updated_at    timestamptz
);

CREATE TABLE IF NOT EXISTS public.daily_stats_old_backup (
    id            uuid,
    user_id       uuid,
    date          date,
    total         integer,
    correct       integer,
    created_at    timestamptz,
    updated_at    timestamptz,
    points        numeric
);

CREATE TABLE IF NOT EXISTS public.sessions_backup (
    id           uuid,
    user_id      uuid,
    created_at   timestamptz,
    word_count   integer,
    target_count integer,
    deleted      boolean,
    deleted_at   timestamptz,
    library_tag  text
);

CREATE TABLE IF NOT EXISTS public.sessions_old (
    id           uuid        NOT NULL DEFAULT gen_random_uuid(),
    user_id      uuid        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT timezone('utc', now()),
    word_count   integer     DEFAULT 0,
    target_count integer     DEFAULT 5,
    deleted      boolean     DEFAULT false,
    deleted_at   timestamptz,
    library_tag  text        DEFAULT 'Custom',
    CONSTRAINT sessions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.words_backup (
    id                uuid,
    user_id           uuid,
    session_id        uuid,
    text              text,
    created_at        timestamptz,
    correct           boolean,
    tested            boolean,
    image_path        text,
    last_tested       timestamptz,
    error_count       integer,
    best_time_ms      integer,
    phonetic          text,
    audio_url         text,
    definition_en     text,
    definition_cn     text,
    deleted           boolean,
    deleted_at        timestamptz,
    tags              text[],
    language          text,
    score             numeric,
    image_gen_status  text,
    image_gen_error   text,
    image_gen_retries integer
);

CREATE TABLE IF NOT EXISTS public.words_old (
    id               uuid        NOT NULL DEFAULT gen_random_uuid(),
    user_id          uuid        NOT NULL,
    session_id       uuid        NOT NULL,
    text             text        NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT timezone('utc', now()),
    correct          boolean     DEFAULT false,
    tested           boolean     DEFAULT false,
    image_path       text,
    last_tested      timestamptz,
    error_count      integer     DEFAULT 0,
    best_time_ms     integer,
    phonetic         text,
    audio_url        text,
    definition_en    text,
    definition_cn    text,
    deleted          boolean     DEFAULT false,
    deleted_at       timestamptz,
    tags             text[]      DEFAULT ARRAY['Custom'],
    language         text        DEFAULT 'en',
    score            numeric,
    image_gen_status text        DEFAULT 'pending',
    image_gen_error  text,
    image_gen_retries integer    DEFAULT 0,
    CONSTRAINT words_pkey PRIMARY KEY (id),
    CONSTRAINT words_session_id_fkey FOREIGN KEY (session_id)
        REFERENCES public.sessions_old(id) ON DELETE CASCADE
);


-- =============================================================================
-- 第七章: 索引
-- =============================================================================

-- daily_stats
CREATE INDEX IF NOT EXISTS daily_stats_user_date_version_idx ON public.daily_stats USING btree (user_id, date, version);
CREATE INDEX IF NOT EXISTS idx_daily_stats_frozen         ON public.daily_stats USING btree (user_id, is_frozen);
CREATE INDEX IF NOT EXISTS idx_daily_stats_user_date      ON public.daily_stats USING btree (user_id, date);

-- daily_test_records
CREATE INDEX IF NOT EXISTS daily_test_records_test_date_idx  ON public.daily_test_records USING btree (test_date);
CREATE INDEX IF NOT EXISTS daily_test_records_user_date_idx  ON public.daily_test_records USING btree (user_id, test_date);
CREATE INDEX IF NOT EXISTS daily_test_records_user_id_idx    ON public.daily_test_records USING btree (user_id);

-- leaderboards
CREATE INDEX IF NOT EXISTS leaderboards_rank_date_idx        ON public.leaderboards USING btree (rank_date);
CREATE INDEX IF NOT EXISTS leaderboards_rank_position_idx    ON public.leaderboards USING btree (rank_date, rank_position);
CREATE INDEX IF NOT EXISTS leaderboards_total_score_idx      ON public.leaderboards USING btree (rank_date, total_score DESC);
CREATE INDEX IF NOT EXISTS leaderboards_user_id_idx          ON public.leaderboards USING btree (user_id);

-- pronunciation_assets
CREATE INDEX IF NOT EXISTS pronunciation_assets_sha256_idx     ON public.pronunciation_assets USING btree (sha256) WHERE (sha256 IS NOT NULL);
CREATE INDEX IF NOT EXISTS pronunciation_assets_status_idx     ON public.pronunciation_assets USING btree (status);
CREATE INDEX IF NOT EXISTS pronunciation_assets_word_lang_idx  ON public.pronunciation_assets USING btree (normalized_word, language);

-- pronunciation_generation_jobs
CREATE INDEX IF NOT EXISTS pronunciation_generation_jobs_pick_idx
    ON public.pronunciation_generation_jobs USING btree (status, priority, scheduled_at)
    WHERE (status = ANY (ARRAY['pending'::text, 'processing'::text]));

-- pronunciation_rebuild_runs
CREATE INDEX IF NOT EXISTS pronunciation_rebuild_runs_created_idx ON public.pronunciation_rebuild_runs USING btree (created_at DESC);

-- session_words
CREATE INDEX IF NOT EXISTS idx_session_words_session ON public.session_words USING btree (session_id);
CREATE INDEX IF NOT EXISTS idx_session_words_word    ON public.session_words USING btree (word_id);

-- sessions_old
CREATE INDEX IF NOT EXISTS idx_sessions_library_tag ON public.sessions_old USING btree (library_tag);

-- timezone_mismatch_log
CREATE INDEX IF NOT EXISTS timezone_mismatch_log_user_id_idx ON public.timezone_mismatch_log USING btree (user_id, created_at DESC);

-- version_conflict_log
CREATE INDEX IF NOT EXISTS version_conflict_log_user_date_idx ON public.version_conflict_log USING btree (user_id, date DESC);

-- words
CREATE INDEX IF NOT EXISTS idx_words_unique_tags              ON public.words USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_words_unique_user              ON public.words USING btree (user_id) WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS words_consecutive_correct_idx      ON public.words USING btree (consecutive_correct) WHERE (consecutive_correct > 0);
CREATE INDEX IF NOT EXISTS words_normalized_lookup_idx        ON public.words USING btree (normalize_word_key((text)::text), language) WHERE ((deleted = false) OR (deleted IS NULL));
CREATE INDEX IF NOT EXISTS words_pronunciation_asset_id_idx   ON public.words USING btree (pronunciation_asset_id);

-- words_old
CREATE INDEX IF NOT EXISTS idx_words_image_gen_status ON public.words_old USING btree (image_gen_status);
CREATE INDEX IF NOT EXISTS idx_words_tags             ON public.words_old USING gin (tags);


-- =============================================================================
-- 第八章: 触发器
-- =============================================================================

-- daily_stats: 自动更新 updated_at
CREATE TRIGGER trigger_daily_stats_updated_at
    BEFORE UPDATE ON public.daily_stats
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- pronunciation_assets: 自动更新 updated_at
CREATE TRIGGER trg_pronunciation_assets_updated_at
    BEFORE UPDATE ON public.pronunciation_assets
    FOR EACH ROW EXECUTE FUNCTION public.set_row_updated_at();

-- pronunciation_generation_jobs: 自动更新 updated_at
CREATE TRIGGER trg_pronunciation_jobs_updated_at
    BEFORE UPDATE ON public.pronunciation_generation_jobs
    FOR EACH ROW EXECUTE FUNCTION public.set_row_updated_at();

-- session_words: 删除关联后清理孤儿单词（软删除）
CREATE OR REPLACE FUNCTION public.cleanup_orphaned_words()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM session_words WHERE word_id = OLD.word_id
    ) THEN
        UPDATE words
        SET deleted_at = now()
        WHERE id = OLD.word_id AND deleted_at IS NULL;
        RAISE NOTICE '软删除孤儿单词: %', OLD.word_id;
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER trigger_cleanup_orphaned_words
    AFTER DELETE ON public.session_words
    FOR EACH ROW EXECUTE FUNCTION public.cleanup_orphaned_words();

-- words: 自动更新 updated_at
CREATE TRIGGER trigger_words_unique_updated_at
    BEFORE UPDATE ON public.words
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- =============================================================================
-- 第九章: 存储过程与 RPC 函数
-- =============================================================================

-- ---------------------------------------------------------------------------
-- check_user_email_exists — 检查 email 是否存在（用于注册前校验）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_user_email_exists(user_email text)
RETURNS TABLE(user_id uuid, email character varying, email_confirmed_at timestamptz, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'auth'
AS $$
BEGIN
  RETURN QUERY
  SELECT u.id, u.email, u.email_confirmed_at, u.created_at
  FROM auth.users u
  WHERE u.email = LOWER(user_email)
  LIMIT 1;
END;
$$;

-- ---------------------------------------------------------------------------
-- init_user_timezone (两个重载)
-- ---------------------------------------------------------------------------
-- 旧重载（带 user_id 参数，兼容旧版调用）
CREATE OR REPLACE FUNCTION public.init_user_timezone(
    current_user_id uuid,
    offset_minutes integer DEFAULT 480,
    tz_name text DEFAULT 'Asia/Shanghai'
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO user_settings (user_id, timezone_offset, timezone_name)
    VALUES (current_user_id, offset_minutes, tz_name)
    ON CONFLICT (user_id) DO NOTHING;
    RAISE NOTICE '用户 % 时区已初始化: % (%)', current_user_id, tz_name, offset_minutes;
END;
$$;

-- 新重载（无参数，使用 auth.uid()）
CREATE OR REPLACE FUNCTION public.init_user_timezone(p_timezone_offset_hours integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  v_user_id := auth.uid();
  INSERT INTO public.user_settings (user_id, timezone_offset)
  VALUES (v_user_id, p_timezone_offset_hours)
  ON CONFLICT (user_id) DO NOTHING;
END;
$$;

-- ---------------------------------------------------------------------------
-- get_user_timezone / get_user_timezone_offset
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_user_timezone(current_user_id uuid)
RETURNS TABLE(timezone_offset integer, timezone_name text)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT us.timezone_offset, us.timezone_name
    FROM user_settings us
    WHERE us.user_id = current_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_user_timezone_offset()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id uuid;
  v_offset int;
BEGIN
  v_user_id := auth.uid();
  SELECT timezone_offset INTO v_offset
  FROM public.user_settings
  WHERE user_id = v_user_id;
  RETURN v_offset;
END;
$$;

-- ---------------------------------------------------------------------------
-- freeze_previous_days — 冻结昨天及以前的统计（按上海时间）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.freeze_previous_days()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE public.daily_stats
    SET is_frozen = true, updated_at = now()
    WHERE date < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::DATE
      AND COALESCE(is_frozen, false) = false;
END;
$$;

-- ---------------------------------------------------------------------------
-- freeze_historical_stats — 按用户时区冻结历史统计
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.freeze_historical_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id uuid;
  v_offset int;
  v_client_today date;
  v_interval interval;
BEGIN
  v_user_id := auth.uid();
  SELECT timezone_offset INTO v_offset
  FROM public.user_settings WHERE user_id = v_user_id;
  IF v_offset IS NULL THEN RETURN; END IF;
  v_interval := (v_offset || ' hours')::interval;
  v_client_today := date(now() + v_interval);
  UPDATE public.daily_stats
  SET is_frozen = true
  WHERE user_id = v_user_id AND date < v_client_today AND is_frozen = false;
END;
$$;

-- ---------------------------------------------------------------------------
-- get_daily_stats — 查询用户历史每日统计
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_daily_stats(current_user_id uuid)
RETURNS TABLE(date date, total_count bigint, correct_count bigint, total_points numeric, is_frozen boolean)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT ds.date, ds.total_count::BIGINT, ds.correct_count::BIGINT, ds.total_points, ds.is_frozen
    FROM daily_stats ds
    WHERE ds.user_id = current_user_id
    ORDER BY ds.date DESC;
END;
$$;

-- ---------------------------------------------------------------------------
-- get_todays_stats — 查询今日实时统计（北京时间）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_todays_stats(p_timezone_offset_hours integer DEFAULT NULL)
RETURNS TABLE(test_date date, total_tests bigint, correct_tests bigint, total_points numeric, unique_words bigint)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_today DATE;
BEGIN
    v_user_id := auth.uid();
    v_today := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE;
    SELECT
        v_today,
        COALESCE(SUM(r.test_count), 0)::BIGINT,
        COALESCE(SUM(r.correct_count), 0)::BIGINT,
        COALESCE(SUM(r.points), 0)::NUMERIC,
        (SELECT COUNT(DISTINCT w.text)
         FROM public.words w
         WHERE w.user_id = v_user_id
            AND (w.last_tested AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE = v_today
            AND (w.deleted = false OR w.deleted IS NULL)
        )::BIGINT
    INTO test_date, total_tests, correct_tests, total_points, unique_words
    FROM public.daily_test_records r
    WHERE r.user_id = v_user_id AND r.test_date = v_today;
    RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- record_test_and_sync_stats — 核心 RPC：写入测试记录并更新统计（含乐观锁）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_test_and_sync_stats(
    p_test_date date DEFAULT NULL,
    p_client_date date DEFAULT NULL,
    p_test_count integer DEFAULT NULL,
    p_correct_count integer DEFAULT NULL,
    p_points numeric DEFAULT NULL,
    p_timezone_offset_hours integer DEFAULT NULL,
    p_expected_version bigint DEFAULT NULL
)
RETURNS TABLE(synced_date date, total_tests bigint, correct_tests bigint, total_points numeric, unique_words bigint, version bigint, conflict_detected boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id UUID;
    v_today DATE;
    v_test_date DATE;
    v_test_count_val INTEGER;
    v_correct_count_val INTEGER;
    v_points_val NUMERIC;
    v_current_version BIGINT;
    v_is_frozen BOOLEAN;
    v_conflict_detected BOOLEAN;
BEGIN
    v_user_id := auth.uid();
    v_today := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::DATE;

    PERFORM freeze_previous_days();

    v_test_date := COALESCE(p_test_date, v_today);

    IF v_test_date < v_today THEN
        RAISE EXCEPTION 'Cannot modify historical stats for date %', v_test_date
            USING HINT = 'Historical data is frozen. Only today''s stats are writable.';
    END IF;
    IF v_test_date > v_today THEN
        RAISE EXCEPTION 'Cannot modify future stats for date %', v_test_date
            USING HINT = 'Only today''s stats are writable.';
    END IF;

    v_test_count_val    := COALESCE(p_test_count, 0);
    v_correct_count_val := COALESCE(p_correct_count, 0);
    v_points_val        := COALESCE(p_points, 0);
    v_conflict_detected := FALSE;

    SELECT daily_stats.is_frozen, daily_stats.version
    INTO v_is_frozen, v_current_version
    FROM public.daily_stats
    WHERE user_id = v_user_id AND date = v_test_date;

    IF v_is_frozen = true THEN
        RAISE EXCEPTION 'Cannot modify frozen stats for date %', v_test_date
            USING HINT = 'This day has ended and its statistics are now frozen.';
    END IF;

    -- 乐观锁冲突处理
    IF v_current_version IS NOT NULL AND p_expected_version IS NOT NULL THEN
        IF v_current_version != p_expected_version THEN
            v_conflict_detected := TRUE;
            INSERT INTO public.version_conflict_log (user_id, date, expected_version, actual_version, client_data)
            VALUES (v_user_id, v_test_date, p_expected_version, v_current_version,
                jsonb_build_object('test_count', v_test_count_val, 'correct_count', v_correct_count_val,
                                   'points', v_points_val, 'client_date', p_client_date));
            UPDATE public.daily_stats
            SET total_count   = daily_stats.total_count + v_test_count_val,
                correct_count = daily_stats.correct_count + v_correct_count_val,
                total_points  = daily_stats.total_points + v_points_val,
                version       = daily_stats.version + 1,
                updated_at    = now()
            WHERE user_id = v_user_id AND date = v_test_date;
            SELECT ds.date, ds.total_count::BIGINT, ds.correct_count::BIGINT, ds.total_points::NUMERIC,
                (SELECT COUNT(DISTINCT text) FROM public.words
                 WHERE user_id = v_user_id AND (last_tested AT TIME ZONE 'Asia/Shanghai')::DATE = v_test_date
                   AND (deleted = false OR deleted IS NULL))::BIGINT,
                ds.version::BIGINT, v_conflict_detected
            INTO synced_date, total_tests, correct_tests, total_points, unique_words, version, conflict_detected
            FROM public.daily_stats ds WHERE user_id = v_user_id AND date = v_test_date;
            PERFORM calculate_daily_leaderboard(v_test_date);
            RETURN NEXT;
        END IF;
    END IF;

    -- 写入测试记录
    INSERT INTO public.daily_test_records (user_id, test_date, test_count, correct_count, points, timezone_offset)
    VALUES (v_user_id, v_test_date, v_test_count_val, v_correct_count_val, v_points_val, p_timezone_offset_hours);

    -- 汇总更新 daily_stats
    INSERT INTO public.daily_stats (user_id, date, total_count, correct_count, total_points)
    SELECT v_user_id, v_test_date, SUM(test_count), SUM(correct_count), SUM(points)
    FROM public.daily_test_records
    WHERE user_id = v_user_id AND test_date = v_test_date
    ON CONFLICT (user_id, date) DO UPDATE SET
        total_count   = EXCLUDED.total_count,
        correct_count = EXCLUDED.correct_count,
        total_points  = EXCLUDED.total_points,
        version       = daily_stats.version + 1,
        updated_at    = now()
    RETURNING daily_stats.date, daily_stats.total_count, daily_stats.correct_count,
              daily_stats.total_points, daily_stats.version
    INTO synced_date, total_tests, correct_tests, total_points, version;

    SELECT COUNT(DISTINCT text) INTO unique_words
    FROM public.words
    WHERE user_id = v_user_id
      AND (last_tested AT TIME ZONE 'Asia/Shanghai')::DATE = v_test_date
      AND (deleted = false OR deleted IS NULL);

    conflict_detected := FALSE;
    PERFORM freeze_previous_days();
    PERFORM calculate_daily_leaderboard(v_test_date);
    RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- sync_todays_stats — 从 words 表重算今日统计（上海时区）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_todays_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id uuid;
  v_today date;
  v_total int;
  v_correct int;
  v_points numeric;
BEGIN
  v_user_id := auth.uid();
  v_today := date(now() AT TIME ZONE 'Asia/Shanghai');
  WITH latest_tests AS (
    SELECT DISTINCT ON (text) text, correct, score, last_tested, deleted
    FROM public.words
    WHERE user_id = v_user_id AND date(last_tested AT TIME ZONE 'Asia/Shanghai') = v_today
    ORDER BY text, last_tested DESC
  )
  SELECT count(*), count(CASE WHEN correct THEN 1 END),
    sum(CASE WHEN score IS NOT NULL THEN score WHEN correct THEN 3 ELSE 0 END)
  INTO v_total, v_correct, v_points
  FROM latest_tests WHERE (deleted = false OR deleted IS NULL);
  INSERT INTO public.daily_stats (user_id, date, total_count, correct_count, points)
  VALUES (v_user_id, v_today, coalesce(v_total, 0), coalesce(v_correct, 0), coalesce(v_points, 0))
  ON CONFLICT (user_id, date) DO UPDATE SET
    total_count = excluded.total_count, correct_count = excluded.correct_count,
    points = excluded.points, updated_at = now();
END;
$$;

-- ---------------------------------------------------------------------------
-- sync_todays_stats_with_timezone — 带时区参数的统计同步
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_todays_stats_with_timezone(p_timezone_offset_hours integer DEFAULT 8)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id uuid;
  v_client_today date;
  v_total int;
  v_correct int;
  v_points numeric;
  v_interval interval;
BEGIN
  v_user_id := auth.uid();
  v_interval := (p_timezone_offset_hours || ' hours')::interval;
  v_client_today := date(now() + v_interval);
  WITH latest_tests AS (
    SELECT DISTINCT ON (text) text, correct, score, last_tested, deleted
    FROM public.words
    WHERE user_id = v_user_id AND date(last_tested + v_interval) = v_client_today
    ORDER BY text, last_tested DESC
  )
  SELECT count(*), count(CASE WHEN correct THEN 1 END),
    sum(CASE WHEN score IS NOT NULL THEN score WHEN correct THEN 3 ELSE 0 END)
  INTO v_total, v_correct, v_points
  FROM latest_tests WHERE (deleted = false OR deleted IS NULL);
  INSERT INTO public.daily_stats (user_id, date, total_count, correct_count, points)
  VALUES (v_user_id, v_client_today, coalesce(v_total, 0), coalesce(v_correct, 0), coalesce(v_points, 0))
  ON CONFLICT (user_id, date) DO UPDATE SET
    total_count = excluded.total_count, correct_count = excluded.correct_count,
    points = excluded.points, updated_at = now();
END;
$$;

-- ---------------------------------------------------------------------------
-- consolidate_daily_stats — 从 words 批量重算所有历史统计
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consolidate_daily_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.daily_stats (user_id, date, total_count, correct_count, points)
  SELECT user_id, date, count(*) as total_count,
    count(CASE WHEN correct THEN 1 END) as correct_count,
    sum(coalesce(score, CASE WHEN correct THEN 3 ELSE 0 END)) as points
  FROM (
    SELECT DISTINCT ON (user_id, text, date)
      user_id, text, correct, score,
      date(last_tested AT TIME ZONE 'Asia/Shanghai') as date
    FROM public.words
    WHERE last_tested IS NOT NULL AND (deleted = false OR deleted IS NULL)
    ORDER BY user_id, text, date, last_tested DESC
  ) deduplicated_words
  GROUP BY user_id, date
  ON CONFLICT (user_id, date) DO UPDATE SET
    total_count = EXCLUDED.total_count, correct_count = EXCLUDED.correct_count,
    points = EXCLUDED.points, updated_at = now();
END;
$$;

-- ---------------------------------------------------------------------------
-- cleanup_buffer — 清理已删除的临时单词和会话
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cleanup_buffer()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM public.words
  WHERE user_id = auth.uid() AND deleted = true
    AND (last_tested IS NULL OR date(last_tested) < current_date);
  DELETE FROM public.sessions
  WHERE user_id = auth.uid() AND deleted = true
    AND date(created_at) < current_date;
END;
$$;

-- ---------------------------------------------------------------------------
-- backfill_daily_stats_from_words — 从 words 反向填充历史统计（Admin 工具）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backfill_daily_stats_from_words(
    p_start_date date DEFAULT NULL,
    p_end_date date DEFAULT NULL
)
RETURNS TABLE(processed_date date, records_processed bigint)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_date DATE;
    v_start_date DATE;
    v_end_date DATE;
    v_word_count INTEGER;
    v_correct_count INTEGER;
    v_points NUMERIC;
BEGIN
    v_user_id := auth.uid();
    v_start_date := COALESCE(p_start_date, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE - INTERVAL '30 days');
    v_end_date   := COALESCE(p_end_date,   (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE);
    FOR v_date IN SELECT generate_series(v_start_date, v_end_date, INTERVAL '1 day')::DATE LOOP
        SELECT COUNT(*), COUNT(*) FILTER (WHERE correct = true), COALESCE(SUM(score), 0)
        INTO v_word_count, v_correct_count, v_points
        FROM public.words
        WHERE user_id = v_user_id
          AND (last_tested AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE = v_date
          AND (deleted = false OR deleted IS NULL);
        IF v_word_count > 0 THEN
            IF NOT EXISTS (SELECT 1 FROM public.daily_test_records WHERE user_id = v_user_id AND test_date = v_date) THEN
                INSERT INTO public.daily_test_records (user_id, test_date, test_count, correct_count, points, timezone_offset)
                VALUES (v_user_id, v_date, v_word_count, v_correct_count, v_points, 8);
                INSERT INTO public.daily_stats (user_id, date, total_count, correct_count, total_points)
                VALUES (v_user_id, v_date, v_word_count, v_correct_count, v_points)
                ON CONFLICT (user_id, date) DO NOTHING;
                processed_date := v_date;
                records_processed := 1;
                RETURN NEXT;
            END IF;
        END IF;
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- calculate_daily_leaderboard — 计算指定日期的排行榜（插入/更新）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calculate_daily_leaderboard(p_date date DEFAULT NULL)
RETURNS TABLE(users_processed bigint, calculation_timestamp timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_calc_date DATE;
    v_today DATE;
    v_users_count BIGINT;
BEGIN
    v_today     := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::DATE;
    v_calc_date := COALESCE(p_date, v_today);
    IF v_calc_date > v_today THEN v_calc_date := v_today; END IF;

    INSERT INTO public.leaderboards (
        user_id, rank_date, total_score, test_count_score, new_words_score,
        accuracy_score, difficulty_score, tests_completed, new_words_added,
        accuracy_rate, avg_difficulty
    )
    SELECT
        d.user_id, v_calc_date,
        (LEAST(d.total_count::NUMERIC / 100, 1.0) * 250) +
        (LEAST(COALESCE(n.new_words, 0)::NUMERIC / 20, 1.0) * 200) +
        (CASE WHEN d.total_count > 0 THEN (d.correct_count::NUMERIC / d.total_count) * 300 ELSE 0 END) +
        (LEAST(COALESCE(w.avg_error, 0)::NUMERIC / 3, 1.0) * 250) AS total_score,
        LEAST(d.total_count::NUMERIC / 100, 1.0) * 250 AS test_count_score,
        LEAST(COALESCE(n.new_words, 0)::NUMERIC / 20, 1.0) * 200 AS new_words_score,
        CASE WHEN d.total_count > 0 THEN (d.correct_count::NUMERIC / d.total_count) * 300 ELSE 0 END AS accuracy_score,
        LEAST(COALESCE(w.avg_error, 0)::NUMERIC / 3, 1.0) * 250 AS difficulty_score,
        d.total_count AS tests_completed,
        COALESCE(n.new_words, 0) AS new_words_added,
        CASE WHEN d.total_count > 0 THEN ROUND((d.correct_count::NUMERIC / d.total_count)::NUMERIC, 4) ELSE 0 END AS accuracy_rate,
        COALESCE(w.avg_error, 0) AS avg_difficulty
    FROM public.daily_stats d
    LEFT JOIN (
        SELECT user_id, COUNT(*) as new_words FROM public.words
        WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::DATE = v_calc_date AND (deleted = false OR deleted IS NULL)
        GROUP BY user_id
    ) n ON d.user_id = n.user_id
    LEFT JOIN (
        SELECT user_id, AVG(error_count::NUMERIC) as avg_error FROM public.words
        WHERE (last_tested AT TIME ZONE 'Asia/Shanghai')::DATE = v_calc_date
          AND (deleted = false OR deleted IS NULL) AND tested = true
        GROUP BY user_id
    ) w ON d.user_id = w.user_id
    WHERE d.date = v_calc_date AND d.total_count >= 10
    ON CONFLICT (user_id, rank_date) DO UPDATE SET
        total_score = EXCLUDED.total_score, test_count_score = EXCLUDED.test_count_score,
        new_words_score = EXCLUDED.new_words_score, accuracy_score = EXCLUDED.accuracy_score,
        difficulty_score = EXCLUDED.difficulty_score, tests_completed = EXCLUDED.tests_completed,
        new_words_added = EXCLUDED.new_words_added, accuracy_rate = EXCLUDED.accuracy_rate,
        avg_difficulty = EXCLUDED.avg_difficulty, updated_at = now();

    GET DIAGNOSTICS v_users_count = ROW_COUNT;

    UPDATE public.leaderboards l1
    SET rank_position = subquery.row_num
    FROM (
        SELECT user_id, ROW_NUMBER() OVER (ORDER BY total_score DESC, user_id) as row_num
        FROM public.leaderboards WHERE rank_date = v_calc_date
    ) subquery
    WHERE l1.user_id = subquery.user_id AND l1.rank_date = v_calc_date;

    calculation_timestamp := now();
    users_processed := v_users_count;
    RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- initialize_leaderboard_history — 初始化历史排行榜（一次性工具）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.initialize_leaderboard_history()
RETURNS TABLE(start_date date, end_date date, days_processed bigint, total_users_processed bigint, processing_time interval)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_start_date DATE;
    v_end_date DATE;
    v_current_date DATE;
    v_days_count BIGINT;
    v_total_users BIGINT;
    v_start_time TIMESTAMP WITH TIME ZONE;
BEGIN
    v_end_date   := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::DATE - INTERVAL '1 day';
    SELECT MIN(date) INTO v_start_date FROM public.daily_stats WHERE total_count > 0;
    IF v_start_date IS NULL THEN
        RETURN QUERY SELECT NULL::DATE, NULL::DATE, 0::BIGINT, 0::BIGINT, INTERVAL '0';
        RETURN;
    END IF;
    v_start_time := now();
    v_days_count := 0;
    v_total_users := 0;
    v_current_date := v_start_date;
    WHILE v_current_date <= v_end_date LOOP
        INSERT INTO public.leaderboards (
            user_id, rank_date, total_score, test_count_score, new_words_score,
            accuracy_score, difficulty_score, tests_completed, new_words_added, accuracy_rate, avg_difficulty
        )
        SELECT d.user_id, v_current_date,
            (LEAST(d.total_count::NUMERIC / 100, 1.0) * 250) +
            (LEAST(COALESCE(n.new_words, 0)::NUMERIC / 20, 1.0) * 200) +
            (CASE WHEN d.total_count > 0 THEN (d.correct_count::NUMERIC / d.total_count) * 300 ELSE 0 END) +
            (LEAST(COALESCE(w.avg_error, 0)::NUMERIC / 3, 1.0) * 250) AS total_score,
            LEAST(d.total_count::NUMERIC / 100, 1.0) * 250,
            LEAST(COALESCE(n.new_words, 0)::NUMERIC / 20, 1.0) * 200,
            CASE WHEN d.total_count > 0 THEN (d.correct_count::NUMERIC / d.total_count) * 300 ELSE 0 END,
            LEAST(COALESCE(w.avg_error, 0)::NUMERIC / 3, 1.0) * 250,
            d.total_count, COALESCE(n.new_words, 0),
            CASE WHEN d.total_count > 0 THEN ROUND((d.correct_count::NUMERIC / d.total_count)::NUMERIC, 4) ELSE 0 END,
            COALESCE(w.avg_error, 0)
        FROM public.daily_stats d
        LEFT JOIN (SELECT user_id, COUNT(*) as new_words FROM public.words
            WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::DATE = v_current_date AND (deleted = false OR deleted IS NULL)
            GROUP BY user_id) n ON d.user_id = n.user_id
        LEFT JOIN (SELECT user_id, AVG(error_count::NUMERIC) as avg_error FROM public.words
            WHERE (last_tested AT TIME ZONE 'Asia/Shanghai')::DATE = v_current_date
              AND (deleted = false OR deleted IS NULL) AND tested = true
            GROUP BY user_id) w ON d.user_id = w.user_id
        WHERE d.date = v_current_date AND d.total_count >= 10
        ON CONFLICT (user_id, rank_date) DO UPDATE SET
            total_score = EXCLUDED.total_score, test_count_score = EXCLUDED.test_count_score,
            new_words_score = EXCLUDED.new_words_score, accuracy_score = EXCLUDED.accuracy_score,
            difficulty_score = EXCLUDED.difficulty_score, tests_completed = EXCLUDED.tests_completed,
            new_words_added = EXCLUDED.new_words_added, accuracy_rate = EXCLUDED.accuracy_rate,
            avg_difficulty = EXCLUDED.avg_difficulty, updated_at = now();
        GET DIAGNOSTICS v_total_users = ROW_COUNT;
        v_days_count := v_days_count + 1;
        UPDATE public.leaderboards l1
        SET rank_position = subquery.row_num
        FROM (SELECT user_id, ROW_NUMBER() OVER (ORDER BY total_score DESC, user_id) as row_num
              FROM public.leaderboards WHERE rank_date = v_current_date) subquery
        WHERE l1.user_id = subquery.user_id AND l1.rank_date = v_current_date;
        v_current_date := v_current_date + INTERVAL '1 day';
    END LOOP;
    RETURN QUERY SELECT v_start_date, v_end_date, v_days_count, v_total_users, now() - v_start_time;
END;
$$;

-- ---------------------------------------------------------------------------
-- get_leaderboard — 查询指定日期排行榜（含当前用户脱敏显示名）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_leaderboard(
    p_date date DEFAULT NULL,
    p_limit integer DEFAULT 100,
    p_include_current_user boolean DEFAULT true
)
RETURNS TABLE(user_id uuid, rank_position integer, total_score numeric, tests_completed integer,
              new_words_added integer, accuracy_rate numeric, avg_difficulty numeric,
              is_current_user boolean, display_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_query_date DATE;
    v_today DATE;
BEGIN
    v_today := (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::DATE;
    v_query_date := COALESCE(p_date, v_today);
    IF v_query_date > v_today THEN v_query_date := v_today; END IF;
    RETURN QUERY
    SELECT l.user_id, l.rank_position, l.total_score, l.tests_completed, l.new_words_added,
        l.accuracy_rate, l.avg_difficulty,
        (l.user_id = auth.uid())::BOOLEAN as is_current_user,
        CASE
            WHEN POSITION('@' IN u.email) > 0 THEN
                SUBSTRING(u.email FROM 1 FOR 3) || '****' || SUBSTRING(u.email FROM POSITION('@' IN u.email))
            ELSE LEFT(u.email, 3) || '****'
        END as display_name
    FROM public.leaderboards l
    JOIN auth.users u ON l.user_id = u.id
    WHERE l.rank_date = v_query_date
        AND (p_include_current_user = false OR l.rank_position <= p_limit OR l.user_id = auth.uid())
    ORDER BY l.rank_position
    LIMIT p_limit + 1000;
END;
$$;

-- ---------------------------------------------------------------------------
-- get_current_user_ranking — 查询当前用户排名详情
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_current_user_ranking(p_date date DEFAULT NULL)
RETURNS TABLE(rank_date date, rank_position integer, total_score numeric, percentile integer,
              tests_completed integer, new_words_added integer, accuracy_rate numeric, avg_difficulty numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_query_date DATE;
    v_today DATE;
BEGIN
    v_today      := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE;
    v_query_date := COALESCE(p_date, v_today);
    IF v_query_date > v_today THEN v_query_date := v_today; END IF;
    RETURN QUERY
    SELECT l.rank_date, l.rank_position, l.total_score,
        CASE WHEN (SELECT COUNT(*) FROM public.leaderboards WHERE rank_date = l.rank_date) > 0
            THEN ROUND(((SELECT COUNT(*) FROM public.leaderboards WHERE rank_date = l.rank_date AND total_score < l.total_score)::NUMERIC /
                        (SELECT COUNT(*) FROM public.leaderboards WHERE rank_date = l.rank_date)::NUMERIC) * 100
                )::INTEGER
            ELSE NULL END as percentile,
        l.tests_completed, l.new_words_added, l.accuracy_rate, l.avg_difficulty
    FROM public.leaderboards l
    WHERE l.user_id = auth.uid() AND l.rank_date = v_query_date;
END;
$$;

-- ---------------------------------------------------------------------------
-- get_user_rank_history — 查询用户排名历史
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_user_rank_history(p_user_id uuid DEFAULT NULL, p_days integer DEFAULT 30)
RETURNS TABLE(rank_date date, rank_position integer, total_score numeric, percentile integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_target_user UUID;
BEGIN
    v_target_user := COALESCE(p_user_id, auth.uid());
    RETURN QUERY
    SELECT l.rank_date, l.rank_position, l.total_score,
        CASE WHEN (SELECT COUNT(*) FROM public.leaderboards WHERE rank_date = l.rank_date) > 0
            THEN ROUND(((SELECT COUNT(*) FROM public.leaderboards WHERE rank_date = l.rank_date AND total_score < l.total_score)::NUMERIC /
                        (SELECT COUNT(*) FROM public.leaderboards WHERE rank_date = l.rank_date)::NUMERIC) * 100
                )::INTEGER
            ELSE 0 END as percentile
    FROM public.leaderboards l
    WHERE l.user_id = v_target_user
        AND l.rank_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::DATE - (p_days || ' days')::INTERVAL
    ORDER BY l.rank_date DESC;
END;
$$;


-- =============================================================================
-- 第十章: 启用行级安全策略 (RLS)
-- =============================================================================

ALTER TABLE public.daily_stats              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_test_records       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leaderboards             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pronunciation_assets     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pronunciation_generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pronunciation_rebuild_runs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_words            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions_old             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_achievements        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_settings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.words                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.words_old                ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- 第十一章: 行级安全策略 (RLS Policies)
-- =============================================================================

-- daily_stats
CREATE POLICY "Users can manage their own stats"  ON public.daily_stats FOR ALL    USING (auth.uid() = user_id);
CREATE POLICY "Users can view their own stats"    ON public.daily_stats FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own stats"  ON public.daily_stats FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own unfrozen stats" ON public.daily_stats FOR UPDATE
    USING ((auth.uid() = user_id) AND (is_frozen = false)) WITH CHECK (auth.uid() = user_id);

-- daily_test_records
CREATE POLICY "Users can view their own test records"   ON public.daily_test_records FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own test records" ON public.daily_test_records FOR INSERT WITH CHECK (auth.uid() = user_id);

-- leaderboards
CREATE POLICY "Users can view leaderboards" ON public.leaderboards FOR SELECT USING (true);

-- pronunciation_assets
CREATE POLICY "pronunciation_assets_read_ready"    ON public.pronunciation_assets FOR SELECT USING (status = 'ready');
CREATE POLICY "pronunciation_assets_service_all"   ON public.pronunciation_assets FOR ALL
    USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- pronunciation_generation_jobs
CREATE POLICY "pronunciation_jobs_service_all" ON public.pronunciation_generation_jobs FOR ALL
    USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- pronunciation_rebuild_runs
CREATE POLICY "pronunciation_rebuild_runs_service_all" ON public.pronunciation_rebuild_runs FOR ALL
    USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "pronunciation_rebuild_runs_admin_select" ON public.pronunciation_rebuild_runs FOR SELECT
    USING (lower(COALESCE((auth.jwt() ->> 'email'), '')) = 'dysonfreeman@outlook.com');

-- session_words
CREATE POLICY "Users can view their session words"   ON public.session_words FOR SELECT
    USING (EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_words.session_id AND s.user_id = auth.uid()));
CREATE POLICY "Users can insert their session words" ON public.session_words FOR INSERT
    WITH CHECK (EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_words.session_id AND s.user_id = auth.uid()));
CREATE POLICY "Users can delete their session words" ON public.session_words FOR DELETE
    USING (EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_words.session_id AND s.user_id = auth.uid()));

-- sessions
CREATE POLICY "Users can view their own sessions"   ON public.sessions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own sessions" ON public.sessions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own sessions" ON public.sessions FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete their own sessions" ON public.sessions FOR DELETE USING (auth.uid() = user_id);

-- sessions_old
CREATE POLICY "Users can view their own sessions"   ON public.sessions_old FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own sessions" ON public.sessions_old FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own sessions" ON public.sessions_old FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- user_achievements
CREATE POLICY "Users can manage their own achievements" ON public.user_achievements FOR ALL    USING (auth.uid() = user_id);
CREATE POLICY "Users can view their own achievements"   ON public.user_achievements FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own achievements" ON public.user_achievements FOR INSERT WITH CHECK (auth.uid() = user_id);

-- user_settings
CREATE POLICY "Users can manage their own settings" ON public.user_settings FOR ALL    USING (auth.uid() = user_id);
CREATE POLICY "Users can view their own settings"   ON public.user_settings FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own settings" ON public.user_settings FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own settings" ON public.user_settings FOR UPDATE USING (auth.uid() = user_id);

-- words
CREATE POLICY "Users can view their own words"   ON public.words FOR SELECT USING ((auth.uid() = user_id) AND (deleted_at IS NULL));
CREATE POLICY "Users can insert their own words" ON public.words FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own words" ON public.words FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete their own words" ON public.words FOR DELETE USING (auth.uid() = user_id);

-- words_old
CREATE POLICY "Users can view their own words"   ON public.words_old FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own words" ON public.words_old FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own words" ON public.words_old FOR UPDATE USING (auth.uid() = user_id);


-- =============================================================================
-- 第十二章: Storage Buckets & 访问策略
-- =============================================================================

-- vocab-images: 用户词汇图片（公开可读，用户只能操作自己目录下的文件）
INSERT INTO storage.buckets (id, name, public)
VALUES ('vocab-images', 'vocab-images', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Public images" ON storage.objects FOR SELECT
    USING (bucket_id = 'vocab-images');

CREATE POLICY "Users can upload images" ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'vocab-images' AND auth.uid() = (storage.foldername(name))[1]::uuid);

CREATE POLICY "Give users access to own folder" ON storage.objects FOR ALL
    USING (bucket_id = 'vocab-images' AND (auth.uid())::text = (storage.foldername(name))[1]);

-- word-audio: 发音音频（公开可读，service_role 写入）
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('word-audio', 'word-audio', true, 5242880,
        ARRAY['audio/mpeg', 'audio/wav', 'audio/flac', 'application/octet-stream']::text[])
ON CONFLICT (id) DO NOTHING;


-- =============================================================================
-- 完毕
-- =============================================================================
-- 执行完本文件后，数据库将具备完整的 Schema 结构。
-- 注: word-audio bucket 的 storage policies 由 service_role 的 Edge Function 直接操作，
--     无需额外 auth 级别策略。
-- =============================================================================
