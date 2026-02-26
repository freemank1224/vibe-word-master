import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

/**
 * Edge Function: Initialize Historical Leaderboard Data
 *
 * This is a one-time initialization function that backfills
 * all historical leaderboard rankings from the beginning of
 * user activity to yesterday.
 *
 * Authorization: Requires service role key (admin only)
 *
 * Returns:
 * - start_date: First date with historical data
 * - end_date: Last date processed (yesterday)
 * - days_processed: Number of dates backfilled
 * - total_users_processed: Total user records created
 * - processing_time: Time taken for initialization
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

    console.log('Starting leaderboard history initialization...')

    // Call database function to initialize history
    const { data, error } = await supabase.rpc('initialize_leaderboard_history')

    if (error) {
      console.error('Initialization error:', error)
      throw new Error(`Database error: ${error.message}`)
    }

    // Get result from function
    const result = Array.isArray(data) && data.length > 0 ? data[0] : data

    console.log('Initialization complete:', result)

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Leaderboard history initialized successfully',
        data: {
          start_date: result?.start_date,
          end_date: result?.end_date,
          days_processed: result?.days_processed || 0,
          total_users_processed: result?.total_users_processed || 0,
          processing_time: result?.processing_time,
        }
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
