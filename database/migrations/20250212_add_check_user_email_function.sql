-- Drop function if exists (to handle recreations)
DROP FUNCTION IF EXISTS check_user_email_exists(text) CASCADE;

-- DEPRECATED (2026-02-12)
-- Legacy helper for check_user_exists Edge Function.
-- Repeated-signup detection now uses Supabase auth.signUp response handling.
COMMENT ON FUNCTION check_user_email_exists IS 'DEPRECATED legacy helper for check_user_exists Edge Function. Current flow uses auth.signUp response handling.';
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
