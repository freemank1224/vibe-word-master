-- Add language column to words table for multi-language support
ALTER TABLE words ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';

-- You can also run this to clear existing low-quality audio URLs if you want to force re-fetch
-- UPDATE words SET audio_url = NULL WHERE audio_url NOT LIKE '%dictvoice%';