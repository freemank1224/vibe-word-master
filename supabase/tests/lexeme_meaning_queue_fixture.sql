-- Isolated PostgreSQL fixture. Never execute against an existing project.
CREATE TABLE public.lexeme_entries (
  id uuid PRIMARY KEY, normalized_text text NOT NULL, display_text text NOT NULL,
  language varchar(10) NOT NULL DEFAULT 'en', phonetic text, definition_en text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.lexeme_meanings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lexeme_id uuid NOT NULL,
  meaning_zh text NOT NULL, source_type text, source_provider text,
  confidence numeric, created_by_user_id uuid, updated_at timestamptz DEFAULT now(),
  UNIQUE (lexeme_id, meaning_zh)
);
CREATE TABLE public.user_word_meaning_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  word_id uuid NOT NULL, lexeme_meaning_id uuid NOT NULL, is_primary boolean NOT NULL,
  updated_at timestamptz DEFAULT now(), UNIQUE (word_id, lexeme_meaning_id)
);
CREATE TABLE public.words (id uuid PRIMARY KEY, user_id uuid, lexeme_id uuid, definition_cn text);
CREATE TABLE public.lexeme_meaning_backfill_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lexeme_id uuid NOT NULL UNIQUE,
  normalized_text text NOT NULL, display_text text NOT NULL, language varchar(10) NOT NULL,
  status text NOT NULL, priority smallint NOT NULL DEFAULT 5, attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5, scheduled_at timestamptz NOT NULL DEFAULT now(),
  last_processed_at timestamptz, completed_at timestamptz, last_error text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
INSERT INTO public.lexeme_entries (id, normalized_text, display_text) VALUES
  ('00000000-0000-0000-0000-000000000001', 'sabertooth', 'sabertooth'),
  ('00000000-0000-0000-0000-000000000002', 'bank', 'bank'),
  ('00000000-0000-0000-0000-000000000003', 'newword', 'newword'),
  ('00000000-0000-0000-0000-000000000006', 'scanword', 'scanword');
INSERT INTO public.lexeme_meanings (lexeme_id, meaning_zh) VALUES
  ('00000000-0000-0000-0000-000000000001', 'sabertooth'),
  ('00000000-0000-0000-0000-000000000002', '银行'),
  ('00000000-0000-0000-0000-000000000006', '暂无中文释义');
INSERT INTO public.lexeme_meaning_backfill_jobs (lexeme_id, normalized_text, display_text, language, status, attempts) VALUES
  ('00000000-0000-0000-0000-000000000001', 'sabertooth', 'sabertooth', 'en', 'done', 4),
  ('00000000-0000-0000-0000-000000000002', 'bank', 'bank', 'en', 'done', 1);
INSERT INTO public.words VALUES ('10000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'sabertooth');
INSERT INTO public.user_word_meaning_preferences (user_id, word_id, lexeme_meaning_id, is_primary)
SELECT '20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', id, true
FROM public.lexeme_meanings WHERE lexeme_id = '00000000-0000-0000-0000-000000000001';
