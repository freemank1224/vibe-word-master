-- ================================================================
-- Migration: Add consecutive_correct field for error decay mechanism
-- Purpose: Track consecutive correct answers without hints to reduce error_count
-- Date: 2026-02-20
-- Author: System (Error Decay Mechanism)
-- ================================================================

-- 1. Add consecutive_correct column to words table
ALTER TABLE public.words
ADD COLUMN IF NOT EXISTS consecutive_correct INTEGER DEFAULT 0;

-- 2. Add comment for documentation
COMMENT ON COLUMN public.words.consecutive_correct IS
'Number of consecutive correct answers without hints. Used for error decay mechanism.';

-- 3. Create index for performance (optional but recommended)
CREATE INDEX IF NOT EXISTS words_consecutive_correct_idx
ON public.words(consecutive_correct)
WHERE consecutive_correct > 0;

-- ================================================================
-- Error Decay Mechanism Logic:
-- - When user answers correctly WITHOUT hints:
--   1. Increment consecutive_correct
--   2. If consecutive_correct reaches threshold (default: 3):
--      - Decrement error_count by 1
--      - Reset consecutive_correct to 0
--      - If error_count becomes 0, remove 'Mistake' tag
-- - When user answers incorrectly OR uses hints:
--   - Reset consecutive_correct to 0
-- ================================================================

-- Testing checklist:
-- [ ] Verify consecutive_correct column exists
-- [ ] Test increment logic on correct answer (no hint)
-- [ ] Test reset logic on incorrect answer or hint usage
-- [ ] Verify error_count decreases after threshold
-- [ ] Verify 'Mistake' tag is removed when error_count reaches 0
-- [ ] Confirm existing data is not affected (defaults to 0)
-- ================================================================
