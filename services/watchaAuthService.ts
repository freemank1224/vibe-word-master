/**
 * 观猹 OAuth2 认证服务
 * 文档参考: docs/watcha_oauth2.md
 */

// 观猹OAuth2配置
const WATCHA_CONFIG = {
  // 测试环境配置（生产环境需替换为正式client_id）
  clientId: import.meta.env.VITE_WATCHA_CLIENT_ID || '1p9Mcr+CNLPAMFC0',
  clientSecret: import.meta.env.VITE_WATCHA_CLIENT_SECRET || 'aqkUs+5ZGLSVG6A/L/I0ib9uownWxH+w',
  // OAuth2 端点
  authorizeUrl: 'https://watcha.cn/oauth/authorize',
  tokenUrl: 'https://watcha.cn/oauth/api/token',
  userInfoUrl: 'https://watcha.cn/oauth/api/userinfo',
  // 回调地址（使用当前页面URL作为回调）
  get redirectUri() {
    return `${window.location.origin}/auth/watcha/callback`;
  },
  // 请求的权限范围
  scope: 'read email phone',
};

// PKCE 工具函数
const base64UrlEncode = (buffer: ArrayBuffer | Uint8Array): string => {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
};

const generateCodeVerifier = (): string => {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
};

const generateCodeChallenge = async (verifier: string): Promise<string> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
};

// 生成随机state参数
const generateState = (): string => {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
};

// 存储PKCE verifier和state
const storeOAuthParams = (codeVerifier: string, state: string): void => {
  sessionStorage.setItem('watcha_code_verifier', codeVerifier);
  sessionStorage.setItem('watcha_oauth_state', state);
};

// 获取并清除存储的参数
const getAndClearOAuthParams = (): { codeVerifier: string | null; state: string | null } => {
  const codeVerifier = sessionStorage.getItem('watcha_code_verifier');
  const state = sessionStorage.getItem('watcha_oauth_state');
  sessionStorage.removeItem('watcha_code_verifier');
  sessionStorage.removeItem('watcha_oauth_state');
  return { codeVerifier, state };
};

/**
 * 观猹用户信息类型
 */
export interface WatchaUserInfo {
  user_id: number;
  nickname: string;
  avatar_url?: string;
  email?: string;
  phone?: string;
}

/**
 * Token响应类型
 */
interface WatchaTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/**
 * 启动观猹OAuth2登录流程
 */
export const startWatchaOAuth = (): void => {
  // 生成PKCE参数
  const codeVerifier = generateCodeVerifier();
  const state = generateState();

  // 存储参数供回调使用
  storeOAuthParams(codeVerifier, state);

  // 生成code_challenge（异步）
  generateCodeChallenge(codeVerifier).then(codeChallenge => {
    // 构建授权URL
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: WATCHA_CONFIG.clientId,
      redirect_uri: WATCHA_CONFIG.redirectUri,
      scope: WATCHA_CONFIG.scope,
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    // 跳转到观猹授权页面
    window.location.href = `${WATCHA_CONFIG.authorizeUrl}?${params.toString()}`;
  });
};

/**
 * 处理OAuth2回调，交换授权码获取token
 */
export const handleWatchaCallback = async (
  searchParams: URLSearchParams
): Promise<{ success: boolean; userInfo?: WatchaUserInfo; error?: string }> => {
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  // 检查是否有错误
  if (error) {
    const errorDescription = searchParams.get('error_description') || error;
    return { success: false, error: errorDescription };
  }

  if (!code) {
    return { success: false, error: '缺少授权码' };
  }

  // 验证state
  const { codeVerifier, state: storedState } = getAndClearOAuthParams();
  if (!state || state !== storedState) {
    return { success: false, error: 'State验证失败，可能存在CSRF攻击' };
  }

  if (!codeVerifier) {
    return { success: false, error: '缺少PKCE verifier' };
  }

  try {
    // 交换授权码获取token
    const tokenResponse = await fetch(WATCHA_CONFIG.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: WATCHA_CONFIG.redirectUri,
        client_id: WATCHA_CONFIG.clientId,
        client_secret: WATCHA_CONFIG.clientSecret,
        code_verifier: codeVerifier,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      return { success: false, error: `获取Token失败: ${errorText}` };
    }

    const tokenData: WatchaTokenResponse = await tokenResponse.json();

    // 获取用户信息
    const userInfoResponse = await fetch(
      `${WATCHA_CONFIG.userInfoUrl}?access_token=${tokenData.access_token}`
    );

    if (!userInfoResponse.ok) {
      return { success: false, error: '获取用户信息失败' };
    }

    const userInfoResult = await userInfoResponse.json();

    if (userInfoResult.statusCode !== 200) {
      return { success: false, error: userInfoResult.message || '获取用户信息失败' };
    }

    return { success: true, userInfo: userInfoResult.data as WatchaUserInfo };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : '未知错误',
    };
  }
};

/**
 * 使用观猹用户信息在Supabase中创建/登录用户
 */
export const signInWithWatcha = async (userInfo: WatchaUserInfo) => {
  const { supabase } = await import('../lib/supabaseClient');

  try {
    // 首先检查是否已存在观猹用户映射
    const { data: existingMapping, error: mappingError } = await supabase
      .from('watcha_user_mappings')
      .select('*')
      .eq('watcha_user_id', userInfo.user_id)
      .maybeSingle();

    if (mappingError && mappingError.code !== 'PGRST116') {
      console.error('查询观猹用户映射失败:', mappingError);
      return { user: null, error: mappingError };
    }

    if (existingMapping) {
      // 用户已存在，更新映射信息并登录
      await supabase
        .from('watcha_user_mappings')
        .update({
          watcha_nickname: userInfo.nickname,
          watcha_avatar_url: userInfo.avatar_url,
          watcha_email: userInfo.email,
          watcha_phone: userInfo.phone,
        })
        .eq('watcha_user_id', userInfo.user_id);

      // 获取用户会话
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        return { user: session.user, error: null };
      }

      // 如果没有会话，尝试通过用户ID获取
      const { data: { user } } = await supabase.auth.getUser();
      return { user, error: null };
    }

    // 新用户：创建Supabase账户
    // 生成唯一邮箱（基于观猹user_id）
    const watchaEmail = `watcha_${userInfo.user_id}@watcha.local`;

    // 生成安全随机密码
    const tempPassword = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // 注册用户
    const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
      email: watchaEmail,
      password: tempPassword,
      options: {
        data: {
          watcha_user_id: userInfo.user_id,
          watcha_nickname: userInfo.nickname,
          watcha_avatar_url: userInfo.avatar_url,
          auth_provider: 'watcha',
        },
      },
    });

    if (signUpError) {
      console.error('Supabase注册失败:', signUpError);
      return { user: null, error: signUpError };
    }

    if (!signUpData.user) {
      return { user: null, error: new Error('创建用户失败') };
    }

    // 创建观猹用户映射
    const { error: insertMappingError } = await supabase
      .from('watcha_user_mappings')
      .insert({
        supabase_user_id: signUpData.user.id,
        watcha_user_id: userInfo.user_id,
        watcha_nickname: userInfo.nickname,
        watcha_avatar_url: userInfo.avatar_url,
        watcha_email: userInfo.email,
        watcha_phone: userInfo.phone,
      });

    if (insertMappingError) {
      console.error('创建观猹用户映射失败:', insertMappingError);
      // 不中断登录流程，只记录错误
    }

    return { user: signUpData.user, error: null };
  } catch (err) {
    console.error('观猹登录异常:', err);
    return { user: null, error: err instanceof Error ? err : new Error('未知错误') };
  }
};
