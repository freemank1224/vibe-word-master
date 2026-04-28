// @ts-nocheck
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// 观猹OAuth配置
const WATCHA_CONFIG = {
  clientId: Deno.env.get('WATCHA_CLIENT_ID') || 'cXz3npcXTL0595ZS',
  clientSecret: Deno.env.get('WATCHA_CLIENT_SECRET') || 'Y7I5gj7rTzsqXsNaWQiWDzZzoelB9tLk',
  tokenUrl: 'https://watcha.cn/oauth/api/token',
  userInfoUrl: 'https://watcha.cn/oauth/api/userinfo',
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// 生成随机密码
function generatePassword(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

serve(async (req) => {
  // 处理CORS预检请求
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const { code, redirectUri, codeVerifier } = await req.json();

    if (!code) {
      return new Response(
        JSON.stringify({ error: '缺少授权码' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!codeVerifier) {
      return new Response(
        JSON.stringify({ error: '缺少code_verifier' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 1. 使用授权码和code_verifier换取access_token
    const tokenResponse = await fetch(WATCHA_CONFIG.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri || `${new URL(req.url).origin}/auth/watcha/callback`,
        client_id: WATCHA_CONFIG.clientId,
        client_secret: WATCHA_CONFIG.clientSecret,
        code_verifier: codeVerifier,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Token请求失败:', errorText);
      return new Response(
        JSON.stringify({ error: '获取Token失败', details: errorText }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const tokenData = await tokenResponse.json();
    console.log('Token获取成功:', { access_token: tokenData.access_token?.substring(0, 10) + '...' });

    // 2. 使用access_token获取用户信息
    const userInfoResponse = await fetch(
      `${WATCHA_CONFIG.userInfoUrl}?access_token=${tokenData.access_token}`
    );

    if (!userInfoResponse.ok) {
      return new Response(
        JSON.stringify({ error: '获取用户信息失败' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userInfoResult = await userInfoResponse.json();

    if (userInfoResult.statusCode !== 200) {
      return new Response(
        JSON.stringify({ error: userInfoResult.message || '获取用户信息失败' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userInfo = userInfoResult.data;
    console.log('获取用户信息成功:', { user_id: userInfo.user_id, nickname: userInfo.nickname });

    // 3. 在Supabase中创建或登录用户
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 检查是否已存在观猹用户映射
    const { data: existingMapping, error: mappingError } = await supabase
      .from('watcha_user_mappings')
      .select('*')
      .eq('watcha_user_id', userInfo.user_id)
      .maybeSingle();

    if (mappingError && mappingError.code !== 'PGRST116') {
      console.error('查询观猹用户映射失败:', mappingError);
      return new Response(
        JSON.stringify({ error: '查询用户失败' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let supabaseUserId: string;
    let watchaEmail: string;
    let watchaPassword: string;

    if (existingMapping) {
      // 用户已存在，生成新密码并更新
      supabaseUserId = existingMapping.supabase_user_id;
      watchaEmail = `watcha_${userInfo.user_id}@watcha.local`;
      watchaPassword = generatePassword();

      // 更新用户密码
      const { error: updateError } = await supabase.auth.admin.updateUserById(
        supabaseUserId,
        { password: watchaPassword }
      );

      if (updateError) {
        console.error('更新用户密码失败:', updateError);
        return new Response(
          JSON.stringify({ error: '更新用户密码失败' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // 更新映射信息
      await supabase
        .from('watcha_user_mappings')
        .update({
          watcha_nickname: userInfo.nickname,
          watcha_avatar_url: userInfo.avatar_url,
          watcha_email: userInfo.email,
          watcha_phone: userInfo.phone,
        })
        .eq('watcha_user_id', userInfo.user_id);

      console.log('已存在用户登录:', { id: supabaseUserId });
    } else {
      // 新用户：创建Supabase账户
      watchaEmail = `watcha_${userInfo.user_id}@watcha.local`;
      watchaPassword = generatePassword();

      // 创建用户
      const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
        email: watchaEmail,
        password: watchaPassword,
        email_confirm: true,
        user_metadata: {
          watcha_user_id: userInfo.user_id,
          watcha_nickname: userInfo.nickname,
          watcha_avatar_url: userInfo.avatar_url,
          auth_provider: 'watcha',
        },
      });

      if (createError || !newUser.user) {
        console.error('创建用户失败:', createError);
        return new Response(
          JSON.stringify({ error: '创建用户失败' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      supabaseUserId = newUser.user.id;

      // 创建观猹用户映射
      const { error: insertMappingError } = await supabase
        .from('watcha_user_mappings')
        .insert({
          supabase_user_id: supabaseUserId,
          watcha_user_id: userInfo.user_id,
          watcha_nickname: userInfo.nickname,
          watcha_avatar_url: userInfo.avatar_url,
          watcha_email: userInfo.email,
          watcha_phone: userInfo.phone,
        });

      if (insertMappingError) {
        console.error('创建观猹用户映射失败:', insertMappingError);
      }

      console.log('新用户创建成功:', { id: supabaseUserId });
    }

    // 4. 使用密码登录获取session
    // 使用service_role key的客户端直接调用signInWithPassword
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email: watchaEmail,
      password: watchaPassword,
    });

    if (signInError || !signInData.user || !signInData.session) {
      console.error('登录失败:', signInError);
      return new Response(
        JSON.stringify({ error: '登录失败', details: signInError?.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('登录成功:', { user_id: signInData.user.id, session_id: signInData.session.id });

    // 5. 返回session信息给前端
    return new Response(
      JSON.stringify({
        success: true,
        user: {
          id: signInData.user.id,
          email: signInData.user.email,
          user_metadata: signInData.user.user_metadata,
        },
        session: {
          access_token: signInData.session.access_token,
          refresh_token: signInData.session.refresh_token,
          expires_in: signInData.session.expires_in,
        },
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('OAuth回调处理错误:', error);
    return new Response(
      JSON.stringify({
        error: error.message || '内部服务器错误',
        details: error.stack,
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
