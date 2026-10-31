-- Minimal isolated queue used to test the rate gate and user-completion race.
CREATE TABLE public.lexeme_meaning_backfill_jobs (
  id uuid PRIMARY KEY,
  lexeme_id uuid,
  normalized_text text,
  display_text text,
  language varchar(10) DEFAULT 'en',
  status text NOT NULL,
  attempts integer NOT NULL,
  max_attempts integer NOT NULL DEFAULT 5,
  priority integer NOT NULL DEFAULT 5,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  last_processed_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.lexeme_meanings (lexeme_id uuid, meaning_zh text);
CREATE TABLE public.lexeme_entries (id uuid PRIMARY KEY, phonetic text, definition_en text);
CREATE FUNCTION public.requeue_stale_lexeme_meaning_backfill_jobs(integer) RETURNS integer
LANGUAGE sql AS $$ SELECT 0 $$;
CREATE FUNCTION public.is_valid_chinese_meaning(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce(value COLLATE "C" ~ '[㐀-䶿一-鿿豈-﫿𠀀-𱍏]' AND value <> '暂无中文释义', false) $$;
