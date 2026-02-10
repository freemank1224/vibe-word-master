-- Add library_tag column to sessions table
-- This allows each session to be associated with a specific library (Custom, CET-4, CET-6, etc.)
-- This is crucial for library-specific deduplication logic

-- 1. Add library_tag column with default value 'Custom'
ALTER TABLE public.sessions 
ADD COLUMN IF NOT EXISTS library_tag TEXT DEFAULT 'Custom';

-- 2. Update existing sessions to have 'Custom' tag if they are null
UPDATE public.sessions 
SET library_tag = 'Custom' 
WHERE library_tag IS NULL;

-- 3. Clean up old 'Library-Imports' sessions
-- Option A: Delete old Library-Imports sessions and their words (recommended for fresh start)
-- Users will need to re-import their dictionaries, but this ensures clean data
DELETE FROM public.words 
WHERE session_id IN (
  SELECT id FROM public.sessions 
  WHERE library_tag = 'Library-Imports'
);

DELETE FROM public.sessions 
WHERE library_tag = 'Library-Imports';

-- 4. Create an index on library_tag for faster filtering
CREATE INDEX IF NOT EXISTS idx_sessions_library_tag ON public.sessions (library_tag);

-- 5. Refresh schema cache
NOTIFY pgrst, 'reload schema';
