-- Drop function if exists (to handle recreations)
DROP FUNCTION IF EXISTS check_user_email_exists(text) CASCADE;

-- Function to check if a user email already exists in auth.users
-- This function is used by the check_user_exists Edge Function
-- Security: Uses SECURITY DEFINER to allow access to auth schema
-- The function checks if the email exists and returns the user's confirmation status
CREATE OR REPLACE FUNCTION check_user_email_exists(user_email text)
RETURNS TABLE (
  user_id uuid,
  email character varying(255),
  email_confirmed_at timestamptz,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth
AS $$
BEGIN
  RETURN QUERY
  SELECT
    u.id,
    u.email,
    u.email_confirmed_at,
    u.created_at
  FROM auth.users u
  WHERE u.email = LOWER(user_email)
  LIMIT 1;
END;
$$;

-- Add comment for documentation
COMMENT ON FUNCTION check_user_email_exists IS 'Checks if a user email exists in auth.users. Used by check_user_exists Edge Function for pre-signup validation.';
