
import { createClient } from '@supabase/supabase-js';

// ------------------------------------------------------------------
// CONFIGURATION INSTRUCTIONS
// ------------------------------------------------------------------
// Environment variables are now used for configuration.
// Check .env for SUPABASE_URL and SUPABASE_ANON_KEY
// ------------------------------------------------------------------


// ------------------------------------------------------------------

// Use environment variables first, fallback to hardcoded values
const supabaseUrl: string = process.env.SUPABASE_URL || '';
const supabaseAnonKey: string = process.env.SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured = 
  supabaseUrl.length > 0 && 
  supabaseAnonKey.length > 20 &&
  !supabaseAnonKey.includes('placeholder');

if (!isSupabaseConfigured) {
  console.warn("Supabase Environment Variables Missing or Invalid!");
  console.warn("Please make sure SUPABASE_URL and SUPABASE_ANON_KEY are set in your .env file");
}

// Validate Key Format (Supabase keys are usually JWTs starting with eyJ)
if (isSupabaseConfigured && !supabaseAnonKey.startsWith('eyJ')) {
    console.error("CRITICAL CONFIGURATION ERROR: The Supabase Anon Key seems invalid.");
    console.error("It should start with 'eyJ...' (JWT format).");
    console.error("Current key starts with:", supabaseAnonKey.substring(0, 15) + "...");
    console.error("Please check your Supabase Project Settings -> API.");
}

// Fallback to prevent crash on initialization, but requests will fail if config is invalid
const url = isSupabaseConfigured ? supabaseUrl : 'https://placeholder.supabase.co';
const key = isSupabaseConfigured ? supabaseAnonKey : 'placeholder';

export const supabase = createClient(url, key);
