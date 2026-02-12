import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, content-type',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // DEPRECATED (2026-02-12):
  // Repeated signup detection now relies on Supabase Auth `signUp` response handling in frontend.
  // This function is intentionally disabled to avoid future accidental coupling.
  return new Response(
    JSON.stringify({
      error: 'check_user_exists endpoint is deprecated and disabled. Use auth.signUp result handling instead.'
    }),
    { status: 410, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
})
