# Duplicate Email Signup Policy (Current)

Last updated: 2026-02-12

## Source of truth

Duplicate-email detection must rely on Supabase Auth `auth.signUp` response handling only.

Do not call `check_user_exists` before signup.

## Required frontend behavior

When user attempts signup with an existing email, UI must show:

- This email is already registered.
- Please switch to Login mode and sign in.

This applies to both Supabase response shapes:

1. Explicit error: `User already registered` / similar.
2. Anti-enumeration shape: `signUp` returns user but `identities` is empty.

## Deprecation status

- Edge Function `supabase/functions/check_user_exists/index.ts`: Deprecated and disabled (returns HTTP 410).
- SQL helper `check_user_email_exists`: Deprecated legacy helper.

## Security rationale

Direct pre-query of auth users is avoided to reduce account enumeration risk and remove dependency on an unstable pre-check endpoint.
