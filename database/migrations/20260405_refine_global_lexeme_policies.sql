-- ================================================================
-- Refine Global Lexeme Policies and Indexes
-- Date: 2026-04-05
-- Purpose:
--   1) Reduce policy overlap for new lexeme tables
--   2) Add missing FK indexes
--   3) Harden helper functions with explicit search_path
-- ================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS lexeme_meanings_created_by_user_id_idx
  ON public.lexeme_meanings(created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS user_word_meaning_preferences_lexeme_meaning_idx
  ON public.user_word_meaning_preferences(lexeme_meaning_id);

CREATE OR REPLACE FUNCTION public.normalize_word_key(input_text TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
SET search_path = public
AS $$
  SELECT lower(regexp_replace(trim(coalesce(input_text, '')), '\s+', ' ', 'g'))
$$;

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP POLICY IF EXISTS lexeme_entries_authenticated_read ON public.lexeme_entries;
CREATE POLICY lexeme_entries_authenticated_read
  ON public.lexeme_entries
  FOR SELECT
  TO authenticated
  USING ((select auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS lexeme_entries_service_all ON public.lexeme_entries;
CREATE POLICY lexeme_entries_service_all
  ON public.lexeme_entries
  FOR ALL
  TO service_role
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

DROP POLICY IF EXISTS lexeme_meanings_authenticated_read ON public.lexeme_meanings;
CREATE POLICY lexeme_meanings_authenticated_read
  ON public.lexeme_meanings
  FOR SELECT
  TO authenticated
  USING ((select auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS lexeme_meanings_service_all ON public.lexeme_meanings;
CREATE POLICY lexeme_meanings_service_all
  ON public.lexeme_meanings
  FOR ALL
  TO service_role
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

DROP POLICY IF EXISTS user_word_meanings_own_select ON public.user_word_meaning_preferences;
CREATE POLICY user_word_meanings_own_select
  ON public.user_word_meaning_preferences
  FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS user_word_meanings_own_insert ON public.user_word_meaning_preferences;
CREATE POLICY user_word_meanings_own_insert
  ON public.user_word_meaning_preferences
  FOR INSERT
  TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS user_word_meanings_own_update ON public.user_word_meaning_preferences;
CREATE POLICY user_word_meanings_own_update
  ON public.user_word_meaning_preferences
  FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS user_word_meanings_service_all ON public.user_word_meaning_preferences;
CREATE POLICY user_word_meanings_service_all
  ON public.user_word_meaning_preferences
  FOR ALL
  TO service_role
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

COMMIT;
