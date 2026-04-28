import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

/**
 * 观猹OAuth2回调处理组件
 * 处理从观猹授权服务器返回的回调
 * 通过Edge Function代理处理token交换，避免CORS问题
 */
export const WatchaCallback: React.FC = () => {
  const [status, setStatus] = useState<'processing' | 'success' | 'error'>('processing');
  const [message, setMessage] = useState('正在处理登录...');

  useEffect(() => {
    const processCallback = async () => {
      try {
        // 获取URL参数
        const searchParams = new URLSearchParams(window.location.search);
        const code = searchParams.get('code');
        const error = searchParams.get('error');

        // 检查是否有错误
        if (error) {
          const errorDescription = searchParams.get('error_description') || error;
          setStatus('error');
          setMessage(errorDescription);
          return;
        }

        if (!code) {
          setStatus('error');
          setMessage('缺少授权码');
          return;
        }

        setStatus('processing');
        setMessage('正在登录...');

        // 从sessionStorage获取PKCE code_verifier
        const codeVerifier = sessionStorage.getItem('watcha_code_verifier');
        const state = sessionStorage.getItem('watcha_oauth_state');

        // 验证state
        const urlState = searchParams.get('state');
        if (state && urlState !== state) {
          setStatus('error');
          setMessage('State验证失败，可能存在CSRF攻击');
          return;
        }

        if (!codeVerifier) {
          setStatus('error');
          setMessage('缺少PKCE verifier，请重新登录');
          return;
        }

        // 调用Edge Function处理OAuth回调
        const { data: { session: currentSession } } = await supabase.auth.getSession();
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || supabase.auth.url?.replace('/auth/v1', '');

        if (!supabaseUrl) {
          throw new Error('Supabase URL未配置');
        }

        const edgeFunctionUrl = `${supabaseUrl}/functions/v1/watcha-oauth-callback`;
        const redirectUri = `${window.location.origin}/auth/watcha/callback`;

        const response = await fetch(edgeFunctionUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            code,
            redirectUri,
            codeVerifier,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: '未知错误' }));
          setStatus('error');
          setMessage(errorData.error || '登录失败，请重试');
          console.error('Edge Function错误:', errorData);
          return;
        }

        const result = await response.json();

        if (!result.success) {
          setStatus('error');
          setMessage(result.error || '登录失败，请重试');
          return;
        }

        setStatus('processing');
        setMessage(`登录成功！正在设置会话...`);

        // 设置session
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: result.session.access_token,
          refresh_token: result.session.refresh_token,
        });

        if (sessionError) {
          console.error('设置session失败:', sessionError);
          setStatus('error');
          setMessage('设置登录会话失败');
          return;
        }

        setStatus('success');
        setMessage('登录成功！正在跳转...');

        // 跳转回首页
        setTimeout(() => {
          window.location.href = '/';
        }, 1000);
      } catch (err) {
        console.error('OAuth回调处理错误:', err);
        setStatus('error');
        setMessage(err instanceof Error ? err.message : '未知错误');
      }
    };

    processCallback();
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-dark-charcoal p-4">
      <div className="w-full max-w-md bg-light-charcoal/80 backdrop-blur-xl p-8 rounded-3xl border border-white/10 shadow-2xl text-center">
        {/* Status Icon */}
        <div className="mb-6">
          {status === 'processing' && (
            <div className="w-20 h-20 mx-auto flex items-center justify-center">
              <div className="w-16 h-16 border-4 border-electric-blue border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {status === 'success' && (
            <div className="w-20 h-20 mx-auto flex items-center justify-center">
              <div className="w-16 h-16 bg-electric-green/20 rounded-full flex items-center justify-center">
                <svg className="w-10 h-10 text-electric-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </div>
          )}
          {status === 'error' && (
            <div className="w-20 h-20 mx-auto flex items-center justify-center">
              <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center">
                <svg className="w-10 h-10 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
            </div>
          )}
        </div>

        {/* Message */}
        <h2 className="text-2xl font-headline text-white mb-2">
          {status === 'processing' && '登录中'}
          {status === 'success' && '登录成功'}
          {status === 'error' && '登录失败'}
        </h2>
        <p className="text-text-dark mb-6">{message}</p>

        {/* Error Action */}
        {status === 'error' && (
          <button
            onClick={() => (window.location.href = '/')}
            className="px-6 py-3 bg-electric-blue text-charcoal font-headline rounded-xl hover:bg-white transition-colors"
          >
            返回登录
          </button>
        )}
      </div>
    </div>
  );
};

export default WatchaCallback;
