
import { createClient } from '@supabase/supabase-js';

// ------------------------------------------------------------------
// CONFIGURATION INSTRUCTIONS
// ------------------------------------------------------------------
// Environment variables are now used for configuration.
// Check .env for SUPABASE_URL and SUPABASE_ANON_KEY
// ------------------------------------------------------------------


// ------------------------------------------------------------------

// Use Vite runtime env first, then process fallback for compatibility
const viteEnv = (import.meta as any)?.env || {};
const processEnv = typeof process !== 'undefined' ? (process as any)?.env || {} : {};

const supabaseUrl: string = viteEnv.VITE_SUPABASE_URL || processEnv.SUPABASE_URL || '';
const supabaseAnonKey: string = viteEnv.VITE_SUPABASE_ANON_KEY || processEnv.SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured = 
  supabaseUrl.length > 0 && 
  supabaseAnonKey.length > 20 &&
  !supabaseAnonKey.includes('placeholder');

if (!isSupabaseConfigured) {
  console.warn("Supabase Environment Variables Missing or Invalid!");
  console.warn("Please make sure VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (or SUPABASE_URL / SUPABASE_ANON_KEY) are configured");
}

// Validate Key Format (Supabase keys are usually JWTs starting with eyJ, but updated formats exist)
if (isSupabaseConfigured && !supabaseAnonKey) {
    console.error("CRITICAL CONFIGURATION ERROR: Supabase Anon Key is missing.");
}

// Fallback to prevent crash on initialization, but requests will fail if config is invalid
const url = isSupabaseConfigured ? supabaseUrl : 'https://placeholder.supabase.co';
const key = isSupabaseConfigured ? supabaseAnonKey : 'placeholder';

export const supabase = createClient(url, key);
