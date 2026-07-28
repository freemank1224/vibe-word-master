// @ts-nocheck
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Admin Console ("~" panel) password gate.
//
// The panel is ALREADY gated client-side to the super-admin email (App.tsx).
// This function adds a second factor: the caller must ALSO supply a password
// matching the SCENE_ADMIN_PANEL_PASSWORD Edge Secret before the panel reveals
// its settings. The password lives only server-side — it is never committed to
// the repo and never sent back to the client.
//
// Defense-in-depth: requires a valid Supabase JWT AND the caller email must
// match the existing super-admin convention (same env override used by
// admin-console / pronunciation-rebuild). Anonymous callers can't probe it.
//
// POST { password: string } -> { ok: boolean }
//   - 401 if no/invalid JWT
//   - 403 if authenticated but not the super admin
//   - 500 if SCENE_ADMIN_PANEL_PASSWORD is unset (fail closed)
//   - 200 { ok: true }  on match
//   - 200 { ok: false } on mismatch (intentionally 200 so the client reads the
//     body cleanly via supabase.functions.invoke instead of an error path)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const superAdminEmail = (Deno.env.get('PRONUNCIATION_REBUILD_ADMIN_EMAIL') || 'dysonfreeman@outlook.com').toLowerCase();

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

// Constant-time string compare to avoid timing side-channels on the password.
// Walks the longer length so duration doesn't leak an early length match.
const timingSafeEqual = (a: string, b: string): boolean => {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length; // nonzero if lengths differ
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization') || req.headers.get('authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ ok: false, error: 'Missing bearer token' }, 401);

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user) return json({ ok: false, error: 'Invalid auth token' }, 401);

    const email = (userData.user.email || '').toLowerCase().trim();
    if (email !== superAdminEmail) return json({ ok: false, error: `Permission denied for ${email}` }, 403);

    const expected = Deno.env.get('SCENE_ADMIN_PANEL_PASSWORD');
    if (!expected || !expected.trim()) {
      // Fail closed: if the secret isn't set, the panel can never unlock.
      console.error('[admin-verify] SCENE_ADMIN_PANEL_PASSWORD not configured');
      return json({ ok: false, error: 'Panel password not configured on the server' }, 500);
    }

    const payload = await req.json().catch(() => ({}));
    const supplied = typeof payload?.password === 'string' ? payload.password : '';

    return json({ ok: timingSafeEqual(supplied, expected) });
  } catch (err) {
    console.error('[admin-verify] handler error:', err);
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
