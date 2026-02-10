-- Identify and delete duplicate words, keeping the best version.
-- This script partitions words by user and text (case-insensitive).
-- logic:
-- 1. Keeps the record that has an image (image_path IS NOT NULL).
-- 2. If both have/don't have images, keeps the oldest one (created_at ASC).
-- 3. Deletes all others (rn > 1).

DELETE FROM words
WHERE id IN (
  SELECT id FROM (
    SELECT 
      id,
      ROW_NUMBER() OVER (
        PARTITION BY user_id, lower(text) 
        ORDER BY 
          CASE WHEN image_path IS NOT NULL THEN 0 ELSE 1 END ASC, -- Priority 1: Keep ones with images
          created_at ASC                                          -- Priority 2: Keep oldest
      ) as rn
    FROM words
    WHERE deleted IS NOT TRUE OR deleted IS NULL
  ) t
  WHERE t.rn > 1
);
