-- ================================================================
-- Migration: [Description]
-- Date: YYYY-MM-DD
-- Author: [Your Name]
-- Related Issue: #[number]
-- ================================================================

-- Instructions:
-- 1. Replace [Description] with brief description
-- 2. Add your SQL below
-- 3. Use IF NOT EXISTS for backwards compatibility
-- 4. Test locally before committing
-- 5. Update checklist at bottom

-- ================================================================
-- Migration SQL
-- ================================================================

-- Example: Add new column
-- ALTER TABLE public.words
-- ADD COLUMN IF NOT EXISTS new_field TEXT;

-- Example: Create index
-- CREATE INDEX IF NOT EXISTS words_new_field_idx
-- ON public.words(new_field);

-- ================================================================
-- Rollback Instructions (commented out)
-- ================================================================
-- To rollback this migration:
-- ALTER TABLE public.words DROP COLUMN new_field;
-- DROP INDEX IF NOT EXISTS words_new_field_idx;

-- ================================================================
-- Testing checklist:
-- [ ] Migration tested locally
-- [ ] Frontend TypeScript interfaces updated
-- [ ] Backwards compatible with existing data
-- [ ] Rollback procedure tested
-- [ ] Documentation updated
-- ================================================================
