alter table public.words
  add column if not exists meaning_options jsonb not null default '[]'::jsonb;

alter table public.words
  add column if not exists selected_meaning_key text;

comment on column public.words.meaning_options is 'Common meaning options shown to the user when adding a word';
comment on column public.words.selected_meaning_key is 'The meaning option key selected by the user for this word entry';
