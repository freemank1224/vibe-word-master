-- Identify and delete duplicate words, keeping the best version.
-- "Best" is defined as:
-- 1. Has an image (image_path is not null)
-- 2. Is the oldest record (created_at asc)

DELETE FROM words
WHERE id IN (
  SELECT id FROM (
    SELECT 
      id,
      ROW_NUMBER() OVER (
        PARTITION BY user_id, lower(text) 
        ORDER BY 
          CASE WHEN image_path IS NOT NULL THEN 0 ELSE 1 END ASC, -- Prioritize records with images
          created_at ASC -- Then prioritize older records (stable IDs)
      ) as rn
    FROM words
    WHERE deleted IS NOT TRUE OR deleted IS NULL
  ) t
  WHERE t.rn > 1
);
