
import { createClient } from '@supabase/supabase-js';

// ------------------------------------------------------------------
// CONFIGURATION INSTRUCTIONS
// ------------------------------------------------------------------
// Since you are running in a sandbox and cannot set environment variables easily,
// please paste your Supabase credentials directly into the quotes below.
// ------------------------------------------------------------------

const HARDCODED_SUPABASE_URL = "https://mkdxdlsjisqazermmfoe.supabase.co"; 

// SECURITY WARNING:
// Please use the "anon" (public) key here. It usually starts with "eyJ...".
// DO NOT use the "service_role" (secret) key or any key starting with "sb_secret".
// The "anon" key is safe for the browser; the "secret" key is NOT.
const HARDCODED_SUPABASE_ANON_KEY = "sb_publishable_dLT6xiqswq3OtUxfoLD9zA_YkL4kcIb";

// ------------------------------------------------------------------

// Use environment variables first, fallback to hardcoded values
const supabaseUrl: string = process.env.SUPABASE_URL || HARDCODED_SUPABASE_URL || '';
const supabaseAnonKey: string = process.env.SUPABASE_ANON_KEY || HARDCODED_SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured = 
  supabaseUrl.length > 0 && 
  supabaseAnonKey.length > 20 &&
  !supabaseAnonKey.includes('placeholder');

if (!isSupabaseConfigured) {
  console.warn("Supabase Environment Variables Missing or Invalid!");
  console.warn("Please open lib/supabaseClient.ts and fill in HARDCODED_SUPABASE_URL and HARDCODED_SUPABASE_ANON_KEY");
}

// Fallback to prevent crash on initialization, but requests will fail if config is invalid
const url = isSupabaseConfigured ? supabaseUrl : 'https://placeholder.supabase.co';
const key = isSupabaseConfigured ? supabaseAnonKey : 'placeholder';

export const supabase = createClient(url, key);
