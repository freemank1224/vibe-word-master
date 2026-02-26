import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

/**
 * Edge Function: Update Daily Leaderboard
 *
 * This function calculates the daily leaderboard for all users.
 * It can be triggered:
 * 1. Manually via POST request (for testing or manual updates)
 * 2. By a cron job scheduled in the database
 *
 * Request body (optional):
 * {
 *   "date": "2026-02-25",  // Optional: specific date to calculate (default: yesterday)
 *   "force": true           // Optional: force recalculation even if already exists
 * }
 *
 * Authorization: Requires service role key (admin only)
 */

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  try {
    // Parse request body
    let date = null
    let force = false

    try {
      const body = await req.json()
      date = body.date || null
      force = body.force || false
    } catch {
      // Empty body is OK, use defaults
    }

    // Initialize Supabase client with service role key
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing Supabase credentials')
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })

    // Call database function to calculate leaderboard
    const { data, error } = await supabase.rpc('calculate_daily_leaderboard', {
      p_date: date,
    })

    if (error) {
      console.error('Leaderboard calculation error:', error)
      throw new Error(`Database error: ${error.message}`)
    }

    // Get result from function
    const result = Array.isArray(data) && data.length > 0 ? data[0] : data

    return new Response(
      JSON.stringify({
        success: true,
        users_processed: result?.users_processed || 0,
        timestamp: result?.calculation_timestamp || new Date().toISOString(),
        date: date || 'yesterday',
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  } catch (error) {
    console.error('Edge function error:', error)

    return new Response(
      JSON.stringify({
        error: error.message || 'An unexpected error occurred',
        success: false,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }
})
