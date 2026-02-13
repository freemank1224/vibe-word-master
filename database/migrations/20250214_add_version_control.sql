-- ================================================================
-- Migration: Add version control to daily_stats
-- Purpose: Prevent data loss from concurrent updates
-- Date: 2025-02-14
-- Author: System (Phase B Implementation)
-- ================================================================

-- 1. Add version column to daily_stats
ALTER TABLE public.daily_stats
ADD COLUMN IF NOT EXISTS version BIGINT DEFAULT 1;

-- 2. Add updated_at timestamp for conflict detection
ALTER TABLE public.daily_stats
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT now();

-- 3. Add index for version-based queries
CREATE INDEX IF NOT EXISTS daily_stats_user_date_version_idx
ON public.daily_stats(user_id, date, version);

-- 4. Create version conflict log table
CREATE TABLE IF NOT EXISTS public.version_conflict_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    date DATE NOT NULL,
    expected_version BIGINT NOT NULL,
    actual_version BIGINT NOT NULL,
    client_data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS version_conflict_log_user_date_idx
ON public.version_conflict_log(user_id, date DESC);

-- ================================================================
-- Testing checklist:
-- [ ] Verify version column exists
-- [ ] Verify updated_at column exists
-- [ ] Test concurrent update scenario
-- [ ] Verify conflict logging works
-- [ ] Confirm data integrity with 2+ devices
-- ================================================================
