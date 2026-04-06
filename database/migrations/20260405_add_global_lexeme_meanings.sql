-- ================================================================
-- Global Lexeme Meanings (Incremental, Backward Compatible)
-- Date: 2026-04-05
-- Purpose:
--   1) Introduce a shared lexeme dictionary across all users
--   2) Support multiple Chinese meanings per word
--   3) Preserve existing words.definition_cn for backward compatibility
--   4) Allow each user word to keep its own preferred meaning
-- ================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.normalize_word_key(input_text TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
	SELECT lower(regexp_replace(trim(coalesce(input_text, '')), '\s+', ' ', 'g'))
$$;

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
	NEW.updated_at = now();
	RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.lexeme_entries (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	normalized_text TEXT NOT NULL,
	display_text TEXT NOT NULL,
	language VARCHAR(10) NOT NULL DEFAULT 'en',
	phonetic TEXT,
	definition_en TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT lexeme_entries_normalized_language_uniq UNIQUE (normalized_text, language)
);

CREATE INDEX IF NOT EXISTS lexeme_entries_normalized_language_idx
	ON public.lexeme_entries(normalized_text, language);

CREATE TABLE IF NOT EXISTS public.lexeme_meanings (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	lexeme_id UUID NOT NULL REFERENCES public.lexeme_entries(id) ON DELETE CASCADE,
	meaning_zh TEXT NOT NULL,
	part_of_speech VARCHAR(32),
	source_type TEXT NOT NULL DEFAULT 'user_word'
		CHECK (source_type IN ('dictionary', 'machine', 'user_word', 'user_custom', 'admin')),
	source_provider TEXT,
	confidence NUMERIC(5,4) NOT NULL DEFAULT 0.5000
		CHECK (confidence >= 0 AND confidence <= 1),
	is_verified BOOLEAN NOT NULL DEFAULT false,
	created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT lexeme_meanings_uniq UNIQUE (lexeme_id, meaning_zh)
);

CREATE INDEX IF NOT EXISTS lexeme_meanings_lexeme_idx
	ON public.lexeme_meanings(lexeme_id);

CREATE INDEX IF NOT EXISTS lexeme_meanings_lookup_idx
	ON public.lexeme_meanings(lexeme_id, is_verified DESC, confidence DESC, created_at ASC);

CREATE TABLE IF NOT EXISTS public.user_word_meaning_preferences (
	id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
	word_id UUID NOT NULL REFERENCES public.words(id) ON DELETE CASCADE,
	lexeme_meaning_id UUID NOT NULL REFERENCES public.lexeme_meanings(id) ON DELETE CASCADE,
	is_primary BOOLEAN NOT NULL DEFAULT true,
	note TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT user_word_meaning_preferences_word_meaning_uniq UNIQUE (word_id, lexeme_meaning_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS user_word_meaning_preferences_primary_idx
	ON public.user_word_meaning_preferences(word_id)
	WHERE is_primary = true;

CREATE INDEX IF NOT EXISTS user_word_meaning_preferences_user_idx
	ON public.user_word_meaning_preferences(user_id, word_id);

ALTER TABLE public.words
	ADD COLUMN IF NOT EXISTS lexeme_id UUID;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'words_lexeme_id_fkey'
			AND conrelid = 'public.words'::regclass
	) THEN
		ALTER TABLE public.words
			ADD CONSTRAINT words_lexeme_id_fkey
			FOREIGN KEY (lexeme_id)
			REFERENCES public.lexeme_entries(id)
			ON DELETE SET NULL;
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS words_lexeme_id_idx
	ON public.words(lexeme_id);

DROP TRIGGER IF EXISTS trg_lexeme_entries_updated_at ON public.lexeme_entries;
CREATE TRIGGER trg_lexeme_entries_updated_at
BEFORE UPDATE ON public.lexeme_entries
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_lexeme_meanings_updated_at ON public.lexeme_meanings;
CREATE TRIGGER trg_lexeme_meanings_updated_at
BEFORE UPDATE ON public.lexeme_meanings
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_user_word_meaning_preferences_updated_at ON public.user_word_meaning_preferences;
CREATE TRIGGER trg_user_word_meaning_preferences_updated_at
BEFORE UPDATE ON public.user_word_meaning_preferences
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE OR REPLACE FUNCTION public.ensure_lexeme_entry(
	p_text TEXT,
	p_language VARCHAR(10),
	p_phonetic TEXT DEFAULT NULL,
	p_definition_en TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
	v_normalized TEXT;
	v_display TEXT;
	v_lexeme_id UUID;
BEGIN
	v_display := nullif(trim(coalesce(p_text, '')), '');
	IF v_display IS NULL THEN
		RETURN NULL;
	END IF;

	v_normalized := public.normalize_word_key(v_display);

	INSERT INTO public.lexeme_entries (
		normalized_text,
		display_text,
		language,
		phonetic,
		definition_en
	)
	VALUES (
		v_normalized,
		v_display,
		coalesce(nullif(trim(coalesce(p_language, '')), ''), 'en'),
		nullif(trim(coalesce(p_phonetic, '')), ''),
		nullif(trim(coalesce(p_definition_en, '')), '')
	)
	ON CONFLICT (normalized_text, language)
	DO UPDATE SET
		display_text = CASE
			WHEN lexeme_entries.display_text IS NULL OR btrim(lexeme_entries.display_text) = '' THEN EXCLUDED.display_text
			ELSE lexeme_entries.display_text
		END,
		phonetic = COALESCE(lexeme_entries.phonetic, EXCLUDED.phonetic),
		definition_en = COALESCE(lexeme_entries.definition_en, EXCLUDED.definition_en),
		updated_at = now()
	RETURNING id INTO v_lexeme_id;

	RETURN v_lexeme_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_word_lexeme_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
	IF NEW.text IS NULL OR btrim(NEW.text) = '' THEN
		RETURN NEW;
	END IF;

	NEW.language := coalesce(nullif(trim(coalesce(NEW.language, '')), ''), 'en');
	NEW.lexeme_id := public.ensure_lexeme_entry(NEW.text, NEW.language, NEW.phonetic, NEW.definition_en);
	RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_word_meaning_after_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
	v_meaning TEXT;
	v_meaning_id UUID;
BEGIN
	v_meaning := nullif(btrim(coalesce(NEW.definition_cn, '')), '');

	IF NEW.lexeme_id IS NULL OR v_meaning IS NULL THEN
		RETURN NEW;
	END IF;

	INSERT INTO public.lexeme_meanings (
		lexeme_id,
		meaning_zh,
		source_type,
		source_provider,
		confidence,
		created_by_user_id
	)
	VALUES (
		NEW.lexeme_id,
		v_meaning,
		'user_word',
		'words_trigger',
		0.7000,
		NEW.user_id
	)
	ON CONFLICT (lexeme_id, meaning_zh)
	DO UPDATE SET
		updated_at = now()
	RETURNING id INTO v_meaning_id;

	UPDATE public.user_word_meaning_preferences
	SET is_primary = false,
			updated_at = now()
	WHERE word_id = NEW.id
		AND is_primary = true
		AND lexeme_meaning_id <> v_meaning_id;

	INSERT INTO public.user_word_meaning_preferences (
		user_id,
		word_id,
		lexeme_meaning_id,
		is_primary
	)
	VALUES (
		NEW.user_id,
		NEW.id,
		v_meaning_id,
		true
	)
	ON CONFLICT (word_id, lexeme_meaning_id)
	DO UPDATE SET
		is_primary = true,
		user_id = EXCLUDED.user_id,
		updated_at = now();

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_words_sync_lexeme_before_write ON public.words;
CREATE TRIGGER trg_words_sync_lexeme_before_write
BEFORE INSERT OR UPDATE OF text, language, phonetic, definition_en
ON public.words
FOR EACH ROW
EXECUTE FUNCTION public.sync_word_lexeme_before_write();

DROP TRIGGER IF EXISTS trg_words_sync_meaning_after_write ON public.words;
CREATE TRIGGER trg_words_sync_meaning_after_write
AFTER INSERT OR UPDATE OF definition_cn, lexeme_id
ON public.words
FOR EACH ROW
EXECUTE FUNCTION public.sync_word_meaning_after_write();

INSERT INTO public.lexeme_entries (
	normalized_text,
	display_text,
	language,
	phonetic,
	definition_en
)
SELECT DISTINCT ON (
	public.normalize_word_key(w.text),
	coalesce(nullif(trim(coalesce(w.language, '')), ''), 'en')
)
	public.normalize_word_key(w.text) AS normalized_text,
	trim(w.text) AS display_text,
	coalesce(nullif(trim(coalesce(w.language, '')), ''), 'en') AS language,
	nullif(trim(coalesce(w.phonetic, '')), '') AS phonetic,
	nullif(trim(coalesce(w.definition_en, '')), '') AS definition_en
FROM public.words w
WHERE (w.deleted = false OR w.deleted IS NULL)
	AND nullif(trim(coalesce(w.text, '')), '') IS NOT NULL
ORDER BY
	public.normalize_word_key(w.text),
	coalesce(nullif(trim(coalesce(w.language, '')), ''), 'en'),
	CASE WHEN nullif(trim(coalesce(w.phonetic, '')), '') IS NOT NULL THEN 0 ELSE 1 END,
	CASE WHEN nullif(trim(coalesce(w.definition_en, '')), '') IS NOT NULL THEN 0 ELSE 1 END,
	w.created_at ASC
ON CONFLICT (normalized_text, language)
DO UPDATE SET
	phonetic = COALESCE(public.lexeme_entries.phonetic, EXCLUDED.phonetic),
	definition_en = COALESCE(public.lexeme_entries.definition_en, EXCLUDED.definition_en),
	updated_at = now();

UPDATE public.words w
SET lexeme_id = le.id
FROM public.lexeme_entries le
WHERE w.lexeme_id IS DISTINCT FROM le.id
	AND (w.deleted = false OR w.deleted IS NULL)
	AND le.normalized_text = public.normalize_word_key(w.text)
	AND le.language = coalesce(nullif(trim(coalesce(w.language, '')), ''), 'en');

INSERT INTO public.lexeme_meanings (
	lexeme_id,
	meaning_zh,
	source_type,
	source_provider,
	confidence,
	created_by_user_id
)
SELECT DISTINCT ON (w.lexeme_id, btrim(w.definition_cn))
	w.lexeme_id,
	btrim(w.definition_cn) AS meaning_zh,
	'user_word' AS source_type,
	'legacy_words_backfill' AS source_provider,
	0.7000 AS confidence,
	w.user_id
FROM public.words w
WHERE (w.deleted = false OR w.deleted IS NULL)
	AND w.lexeme_id IS NOT NULL
	AND nullif(btrim(coalesce(w.definition_cn, '')), '') IS NOT NULL
ON CONFLICT (lexeme_id, meaning_zh)
DO NOTHING;

INSERT INTO public.user_word_meaning_preferences (
	user_id,
	word_id,
	lexeme_meaning_id,
	is_primary
)
SELECT
	w.user_id,
	w.id,
	lm.id,
	true
FROM public.words w
JOIN public.lexeme_meanings lm
	ON lm.lexeme_id = w.lexeme_id
 AND lm.meaning_zh = btrim(w.definition_cn)
WHERE (w.deleted = false OR w.deleted IS NULL)
	AND w.lexeme_id IS NOT NULL
	AND nullif(btrim(coalesce(w.definition_cn, '')), '') IS NOT NULL
ON CONFLICT (word_id, lexeme_meaning_id)
DO UPDATE SET
	is_primary = true,
	user_id = EXCLUDED.user_id,
	updated_at = now();

ALTER TABLE public.lexeme_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lexeme_meanings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_word_meaning_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lexeme_entries_authenticated_read ON public.lexeme_entries;
CREATE POLICY lexeme_entries_authenticated_read
	ON public.lexeme_entries
	FOR SELECT
	USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS lexeme_entries_service_all ON public.lexeme_entries;
CREATE POLICY lexeme_entries_service_all
	ON public.lexeme_entries
	FOR ALL
	USING (auth.role() = 'service_role')
	WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS lexeme_meanings_authenticated_read ON public.lexeme_meanings;
CREATE POLICY lexeme_meanings_authenticated_read
	ON public.lexeme_meanings
	FOR SELECT
	USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS lexeme_meanings_service_all ON public.lexeme_meanings;
CREATE POLICY lexeme_meanings_service_all
	ON public.lexeme_meanings
	FOR ALL
	USING (auth.role() = 'service_role')
	WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS user_word_meanings_own_select ON public.user_word_meaning_preferences;
CREATE POLICY user_word_meanings_own_select
	ON public.user_word_meaning_preferences
	FOR SELECT
	USING (auth.uid() = user_id);

DROP POLICY IF EXISTS user_word_meanings_own_insert ON public.user_word_meaning_preferences;
CREATE POLICY user_word_meanings_own_insert
	ON public.user_word_meaning_preferences
	FOR INSERT
	WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS user_word_meanings_own_update ON public.user_word_meaning_preferences;
CREATE POLICY user_word_meanings_own_update
	ON public.user_word_meaning_preferences
	FOR UPDATE
	USING (auth.uid() = user_id)
	WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS user_word_meanings_service_all ON public.user_word_meaning_preferences;
CREATE POLICY user_word_meanings_service_all
	ON public.user_word_meaning_preferences
	FOR ALL
	USING (auth.role() = 'service_role')
	WITH CHECK (auth.role() = 'service_role');

COMMIT;
