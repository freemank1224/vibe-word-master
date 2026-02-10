-- Add tags column if it doesn't exist
ALTER TABLE public.words 
ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT ARRAY['Custom'];

-- Update existing records to have 'Custom' tag if they are null
UPDATE public.words 
SET tags = ARRAY['Custom'] 
WHERE tags IS NULL;

-- Create an index on tags for faster filtering (Gin index for array)
CREATE INDEX IF NOT EXISTS idx_words_tags ON public.words USING GIN (tags);
