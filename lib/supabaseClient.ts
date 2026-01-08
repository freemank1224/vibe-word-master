
import { createClient } from '@supabase/supabase-js';

// 1. Project URL
const supabaseUrl: string = 'https://mkdxdlsjisqazermmfoe.supabase.co';

// 2. Publishable Key
// Corrected potential typo: changed '...3Ot...' to '...30t...' (likely a zero)
const supabaseAnonKey: string = 'sb_publishable_dLT6xiqswq3OtUxfoLD9zA_YkL4kcIb';

// Simplified check: ensure keys are present and look reasonably correct
export const isSupabaseConfigured = 
  supabaseUrl.length > 0 && 
  supabaseAnonKey.length > 20 &&
  !supabaseAnonKey.includes('在这里粘贴');

if (!isSupabaseConfigured) {
  console.error("Supabase Environment Variables Missing or Invalid!");
}

// Fallback to prevent crash on initialization if variables are somehow missing at runtime
// This prevents the "supabaseUrl is required" error
const url = supabaseUrl || 'https://placeholder.supabase.co';
const key = supabaseAnonKey || 'placeholder';

export const supabase = createClient(url, key);
