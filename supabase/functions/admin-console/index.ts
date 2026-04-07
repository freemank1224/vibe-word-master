import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

const normalizeWord = (text: string): string => text.toLowerCase().trim().replace(/\s+/g, ' ');

const countActiveUsers = async (): Promise<number> => {
  const pageSize = 1000;
  const userIds = new Set<string>();

  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('words')
      .select('user_id,deleted')
      .or('deleted.eq.false,deleted.is.null')
      .range(from, to);

    if (error) {
      throw new Error(`Failed loading users from words page ${page}: ${error.message}`);
    }

    if (!data || data.length === 0) {
      hasMore = false;
      break;
    }

    for (const row of data as Array<{ user_id?: string | null }>) {
      const userId = (row.user_id || '').trim();
      if (userId) {
        userIds.add(userId);
      }
    }

    hasMore = data.length === pageSize;
    page += 1;
  }

  if (userIds.size > 0) {
    return userIds.size;
  }

  page = 0;
  hasMore = true;

  while (hasMore) {
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('sessions')
      .select('user_id,deleted')
      .or('deleted.eq.false,deleted.is.null')
      .range(from, to);

    if (error) {
      throw new Error(`Failed loading users from sessions page ${page}: ${error.message}`);
    }

    if (!data || data.length === 0) {
      hasMore = false;
      break;
    }

    for (const row of data as Array<{ user_id?: string | null }>) {
      const userId = (row.user_id || '').trim();
      if (userId) {
        userIds.add(userId);
      }
    }

    hasMore = data.length === pageSize;
    page += 1;
  }

  return userIds.size;
};

const countUsers = async (): Promise<number> => {
  try {
    const { count, error } = await supabase
      .schema('auth')
      .from('users')
      .select('id', { count: 'exact', head: true });

    if (error) {
      throw new Error(error.message);
    }

    return Number(count || 0);
  } catch (error) {
    console.warn('[admin-console] countUsers fallback to active users:', error instanceof Error ? error.message : error);
    return await countActiveUsers();
  }
};

const getGlobalStats = async () => {
  const pageSize = 1000;
  const uniqueWords = new Map<string, { hasImage: boolean }>();

  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('words')
      .select('text,language,image_path,deleted')
      .or('deleted.eq.false,deleted.is.null')
      .range(from, to);

    if (error) {
      throw new Error(`Failed loading words page ${page}: ${error.message}`);
    }

    if (!data || data.length === 0) {
      hasMore = false;
      break;
    }

    for (const row of data as Array<{ text: string; language?: string | null; image_path?: string | null }>) {
      const text = (row.text || '').trim();
      if (!text) continue;

      const language = (row.language || 'en').trim();
      const key = `${normalizeWord(text)}::${language}`;
      const hasImage = !!row.image_path;
      const existing = uniqueWords.get(key);

      if (!existing) {
        uniqueWords.set(key, { hasImage });
      } else if (hasImage && !existing.hasImage) {
        existing.hasImage = true;
      }
    }

    hasMore = data.length === pageSize;
    page += 1;
  }

  const totalWords = uniqueWords.size;
  const wordsWithImages = Array.from(uniqueWords.values()).filter((entry) => entry.hasImage).length;

  const readyPronunciations = new Set<string>();
  page = 0;
  hasMore = true;

  while (hasMore) {
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('pronunciation_assets')
      .select('normalized_word,language')
      .eq('status', 'ready')
      .range(from, to);

    if (error) {
      throw new Error(`Failed loading pronunciation assets page ${page}: ${error.message}`);
    }

    if (!data || data.length === 0) {
      hasMore = false;
      break;
    }

    for (const row of data as Array<{ normalized_word?: string | null; language?: string | null }>) {
      const normalizedWord = (row.normalized_word || '').trim();
      if (!normalizedWord) continue;

      const language = (row.language || 'en').trim();
      const key = `${normalizedWord}::${language}`;

      if (uniqueWords.has(key)) {
        readyPronunciations.add(key);
      }
    }

    hasMore = data.length === pageSize;
    page += 1;
  }

  const totalUsers = await countUsers();

  return {
    totalWords,
    wordsWithImages,
    imageCoverageRate: totalWords > 0 ? (wordsWithImages / totalWords) * 100 : 0,
    wordsWithPronunciations: readyPronunciations.size,
    pronunciationCoverageRate: totalWords > 0 ? (readyPronunciations.size / totalWords) * 100 : 0,
    totalUsers,
  };
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase service env vars' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const authHeader = req.headers.get('Authorization') || req.headers.get('authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();

    if (!token) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing bearer token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid auth token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const email = (userData.user.email || '').toLowerCase().trim();
    if (email !== superAdminEmail) {
      return new Response(JSON.stringify({ ok: false, error: `Permission denied for ${email}` }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const payload = await req.json().catch(() => ({}));
    const action = typeof payload?.action === 'string' ? payload.action : 'stats';

    if (action !== 'stats') {
      return new Response(JSON.stringify({ ok: false, error: `Unsupported action: ${action}` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const stats = await getGlobalStats();

    return new Response(JSON.stringify({ ok: true, stats }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
