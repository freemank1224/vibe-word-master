-- ================================================================
-- VocabularyVibe Database Schema Snapshot (ACTUAL)
-- ================================================================
-- Snapshot Date: 2025-02-10
-- Source: Exported from live database (mkdxdlsjisqazermmfoe)
-- Purpose: EXACT replica of current database structure
-- ================================================================
--
-- IMPORTANT: This file was generated from the actual database
-- to ensure 100% accuracy. Use this as the baseline.
--
-- ================================================================

-- ================================================================
-- Table: words
-- ================================================================
-- Main words table - ACTUAL structure from database
CREATE TABLE IF NOT EXISTS public.words (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL,
    session_id UUID,
    text CHARACTER VARYING(255) NOT NULL,
    correct BOOLEAN DEFAULT false,
    tested BOOLEAN DEFAULT false,
    last_tested TIMESTAMP WITH TIME ZONE,
    error_count INTEGER DEFAULT 0,
    best_time_ms INTEGER,
    score NUMERIC DEFAULT 0,
    phonetic TEXT,
    audio_url TEXT,
    definition_en TEXT,
    definition_cn TEXT,
    image_path TEXT,
    language CHARACTER VARYING(10) DEFAULT 'en'::character varying,
    tags TEXT[] DEFAULT '{}'::text[],
    deleted_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    deleted BOOLEAN DEFAULT false,

    -- Foreign Keys
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE SET NULL
);

-- Enable RLS
ALTER TABLE public.words ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DROP POLICY IF EXISTS "Users can view their own words" ON public.words;
CREATE POLICY "Users can view their own words"
    ON public.words FOR SELECT
    USING (auth.uid() = user_id AND (deleted = false OR deleted IS NULL));

DROP POLICY IF EXISTS "Users can insert their own words" ON public.words;
CREATE POLICY "Users can insert their own words"
    ON public.words FOR INSERT
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own words" ON public.words;
CREATE POLICY "Users can update their own words"
    ON public.words FOR UPDATE
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own words" ON public.words;
CREATE POLICY "Users can delete their own words"
    ON public.words FOR DELETE
    USING (auth.uid() = user_id);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS words_user_id_idx ON public.words(user_id);
CREATE INDEX IF NOT EXISTS words_session_id_idx ON public.words(session_id);
CREATE INDEX IF NOT EXISTS words_text_idx ON public.words(text);
CREATE INDEX IF NOT EXISTS words_deleted_idx ON public.words(deleted);
CREATE INDEX IF NOT EXISTS words_tags_idx ON public.words USING GIN(tags);

-- ================================================================
-- Table: sessions
-- ================================================================
-- Main sessions table - ACTUAL structure from database
CREATE TABLE IF NOT EXISTS public.sessions (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL,
    name CHARACTER VARYING(255) DEFAULT NULL::character varying,
    library_tag CHARACTER VARYING(100) DEFAULT 'Custom'::character varying,
    target_count INTEGER DEFAULT 0,
    deleted BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    deleted_at TIMESTAMP WITH TIME ZONE,
    word_count INTEGER DEFAULT 0,

    -- Foreign Keys
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- Enable RLS
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DROP POLICY IF EXISTS "Users can view their own sessions" ON public.sessions;
CREATE POLICY "Users can view their own sessions"
    ON public.sessions FOR SELECT
    USING (auth.uid() = user_id AND (deleted = false OR deleted IS NULL));

DROP POLICY IF EXISTS "Users can insert their own sessions" ON public.sessions;
CREATE POLICY "Users can insert their own sessions"
    ON public.sessions FOR INSERT
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own sessions" ON public.sessions;
CREATE POLICY "Users can update their own sessions"
    ON public.sessions FOR UPDATE
    USING (auth.uid() = user_id);

-- Indexes
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON public.sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_library_tag_idx ON public.sessions(library_tag);
CREATE INDEX IF NOT EXISTS sessions_deleted_idx ON public.sessions(deleted);

-- ================================================================
-- Table: session_words (Junction table)
-- ================================================================
-- Many-to-many relationship between sessions and words
CREATE TABLE IF NOT EXISTS public.session_words (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    session_id UUID NOT NULL,
    word_id UUID NOT NULL,
    position INTEGER DEFAULT 0,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE(session_id, word_id),

    -- Foreign Keys
    FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (word_id) REFERENCES public.words(id) ON DELETE CASCADE
);

-- Enable RLS
ALTER TABLE public.session_words ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DROP POLICY IF EXISTS "Users can view session_words for their sessions" ON public.session_words;
CREATE POLICY "Users can view session_words for their sessions"
    ON public.session_words FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM public.sessions
        WHERE sessions.id = session_words.session_id
        AND sessions.user_id = auth.uid()
    ));

DROP POLICY IF EXISTS "Users can insert session_words for their sessions" ON public.session_words;
CREATE POLICY "Users can insert session_words for their sessions"
    ON public.session_words FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.sessions
        WHERE sessions.id = session_words.session_id
        AND sessions.user_id = auth.uid()
    ));

DROP POLICY IF EXISTS "Users can delete session_words for their sessions" ON public.session_words;
CREATE POLICY "Users can delete session_words for their sessions"
    ON public.session_words FOR DELETE
    USING (EXISTS (
        SELECT 1 FROM public.sessions
        WHERE sessions.id = session_words.session_id
        AND sessions.user_id = auth.uid()
    ));

-- Indexes
CREATE INDEX IF NOT EXISTS session_words_session_id_idx ON public.session_words(session_id);
CREATE INDEX IF NOT EXISTS session_words_word_id_idx ON public.session_words(word_id);

-- ================================================================
-- Table: daily_stats
-- ================================================================
-- Daily statistics tracking - ACTUAL structure from database
CREATE TABLE IF NOT EXISTS public.daily_stats (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL,
    date DATE NOT NULL,
    total_count INTEGER DEFAULT 0,
    correct_count INTEGER DEFAULT 0,
    total_points NUMERIC DEFAULT 0,
    is_frozen BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    points NUMERIC DEFAULT 0,  -- Legacy field, kept for compatibility
    UNIQUE(user_id, date),

    -- Foreign Keys
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- Enable RLS
ALTER TABLE public.daily_stats ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DROP POLICY IF EXISTS "Users can view their own stats" ON public.daily_stats;
CREATE POLICY "Users can view their own stats"
    ON public.daily_stats FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own stats" ON public.daily_stats;
CREATE POLICY "Users can insert their own stats"
    ON public.daily_stats FOR INSERT
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own stats" ON public.daily_stats;
CREATE POLICY "Users can update their own stats"
    ON public.daily_stats FOR UPDATE
    USING (auth.uid() = user_id);

-- Indexes
CREATE INDEX IF NOT EXISTS daily_stats_user_id_idx ON public.daily_stats(user_id);
CREATE INDEX IF NOT EXISTS daily_stats_date_idx ON public.daily_stats(date);

-- ================================================================
-- Table: user_achievements
-- ================================================================
-- User achievement tracking - ACTUAL structure from database
CREATE TABLE IF NOT EXISTS public.user_achievements (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL,
    achievement_id TEXT NOT NULL,
    unlocked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE(user_id, achievement_id),

    -- Foreign Keys
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- Enable RLS
ALTER TABLE public.user_achievements ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DROP POLICY IF EXISTS "Users can view their own achievements" ON public.user_achievements;
CREATE POLICY "Users can view their own achievements"
    ON public.user_achievements FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own achievements" ON public.user_achievements;
CREATE POLICY "Users can insert their own achievements"
    ON public.user_achievements FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Indexes
CREATE INDEX IF NOT EXISTS user_achievements_user_id_idx ON public.user_achievements(user_id);
CREATE INDEX IF NOT EXISTS user_achievements_achievement_id_idx ON public.user_achievements(achievement_id);

-- ================================================================
-- Table: user_settings
-- ================================================================
-- User-specific settings - ACTUAL structure from database
CREATE TABLE IF NOT EXISTS public.user_settings (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL UNIQUE,
    timezone_offset INTEGER NOT NULL,
    timezone_name CHARACTER VARYING(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),

    -- Foreign Keys
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- Enable RLS
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DROP POLICY IF EXISTS "Users can view their own settings" ON public.user_settings;
CREATE POLICY "Users can view their own settings"
    ON public.user_settings FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own settings" ON public.user_settings;
CREATE POLICY "Users can insert their own settings"
    ON public.user_settings FOR INSERT
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own settings" ON public.user_settings;
CREATE POLICY "Users can update their own settings"
    ON public.user_settings FOR UPDATE
    USING (auth.uid() = user_id);

-- ================================================================
-- Functions: sync_todays_stats_with_timezone
-- ================================================================
-- Sync daily statistics with dynamic timezone support
CREATE OR REPLACE FUNCTION sync_todays_stats_with_timezone(p_timezone_offset_hours INTEGER DEFAULT NULL)
RETURNS TABLE(
    synced_date DATE,
    total_count BIGINT,
    correct_count BIGINT,
    total_points NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_today DATE;
    v_offset INTEGER;
BEGIN
    -- Get current user ID
    v_user_id := auth.uid();

    -- Determine timezone offset
    IF p_timezone_offset_hours IS NOT NULL THEN
        v_offset := p_timezone_offset_hours;
    ELSE
        -- Fallback: try to get from user_settings
        SELECT timezone_offset INTO v_offset
        FROM public.user_settings
        WHERE user_id = v_user_id
        LIMIT 1;

        -- If still null, default to UTC (0)
        IF v_offset IS NULL THEN
            v_offset := 0;
        END IF;
    END IF;

    -- Calculate today's date based on timezone
    v_today := CURRENT_DATE AT TIME ZONE INTERVAL '1 hour' * v_offset;

    -- Insert or update daily stats
    INSERT INTO public.daily_stats (
        user_id, date, total_count, correct_count, total_points
    )
    SELECT
        v_user_id,
        v_today,
        COUNT(*),
        COUNT(*) FILTER (WHERE correct = true),
        COALESCE(SUM(score), 0)
    FROM public.words
    WHERE user_id = v_user_id
        AND DATE(last_tested AT TIME ZONE INTERVAL '1 hour' * v_offset) = v_today
        AND (deleted = false OR deleted IS NULL)
    ON CONFLICT (user_id, date)
    DO UPDATE SET
        total_count = EXCLUDED.total_count,
        correct_count = EXCLUDED.correct_count,
        total_points = EXCLUDED.total_points,
        updated_at = now()
    RETURNING
        daily_stats.date,
        daily_stats.total_count,
        daily_stats.correct_count,
        daily_stats.total_points
    INTO synced_date, total_count, correct_count, total_points;

    RETURN NEXT;
END;
$$;

-- ================================================================
-- Storage Buckets
-- ================================================================
-- Note: Storage buckets are created via Supabase Dashboard or API
-- Bucket: vocab-images (for word images)

-- ================================================================
-- VERIFICATION NOTES
-- ================================================================
--
-- This file was generated from the ACTUAL database structure on 2025-02-10
--
-- Key field types (exact match):
-- - words.text: CHARACTER VARYING(255) NOT NULL
-- - words.language: CHARACTER VARYING(10) DEFAULT 'en'
-- - sessions.name: CHARACTER VARYING(255)
-- - sessions.library_tag: CHARACTER VARYING(100) DEFAULT 'Custom'
-- - user_settings.timezone_name: CHARACTER VARYING(100)
--
-- Legacy tables (not included, can be cleaned up):
-- - words_old, sessions_old, daily_stats_old
-- - words_backup, sessions_backup, daily_stats_old_backup, daily_stats_current_backup
--
-- ================================================================
