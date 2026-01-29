-- Add columns to track background image generation status
ALTER TABLE words ADD COLUMN IF NOT EXISTS image_gen_status text DEFAULT 'pending';
ALTER TABLE words ADD COLUMN IF NOT EXISTS image_gen_error text;
ALTER TABLE words ADD COLUMN IF NOT EXISTS image_gen_retries int DEFAULT 0;

-- Create an index to quickly find pending words
CREATE INDEX IF NOT EXISTS idx_words_image_gen_status ON words(image_gen_status);

-- Comments for documentation
COMMENT ON COLUMN words.image_gen_status IS 'status of background image generation: pending, processing, completed, failed, skipped';
COMMENT ON COLUMN words.image_gen_retries IS 'number of failed attempts to generate image';
