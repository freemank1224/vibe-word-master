-- =============================================================================
-- Migration: Fix words (user_id, text) unique constraint → partial unique index
-- Date: 2026-06-29
-- Root cause: UNIQUE(user_id, text) included soft-deleted rows, so once a user
--   deleted a word they could never re-add the same spelling. Batch inserts
--   rolled back entirely whenever any single row collided with a zombie row.
-- Fix: enforce uniqueness ONLY on active (non-soft-deleted) rows.
--
-- Soft-delete marker is unified on `deleted_at IS NULL`, matching the existing
-- RLS SELECT policy, idx_words_unique_user index, and cleanup_orphaned_words
-- trigger. Application code (dataService.ts) now sets deleted_at alongside
-- deleted=true on every soft-delete.
-- =============================================================================

-- 1. Drop the legacy table-wide unique constraint
ALTER TABLE public.words DROP CONSTRAINT IF EXISTS unique_user_word;

-- 2. Create partial unique index: only active rows are unique per (user_id, text)
CREATE UNIQUE INDEX IF NOT EXISTS words_user_text_active_uniq
  ON public.words (user_id, text)
  WHERE deleted_at IS NULL;

-- 3. Backfill deleted_at for historical soft-deleted rows (idempotent)
--    This aligns existing zombie rows with the new semantics so the partial
--    index treats them as non-active immediately.
UPDATE public.words
SET deleted_at = COALESCE(updated_at, created_at, now())
WHERE deleted = true AND deleted_at IS NULL;
