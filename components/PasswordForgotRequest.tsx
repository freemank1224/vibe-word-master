import React, { useState } from 'react';
import { supabase } from '../lib/supabaseClient';

interface PasswordForgotRequestProps {
  onBackToLogin: () => void;
}

export const PasswordForgotRequest: React.FC<PasswordForgotRequestProps> = ({ onBackToLogin }) => {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState<'success' | 'error' | 'info'>('info');
  const [emailSent, setEmailSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMsg('');
    setMsgType('info');

    if (!email) {
      setMsgType('error');
      setMsg('Please enter your email address.');
      setLoading(false);
      return;
    }

    try {
      // 优先使用环境变量配置的 URL，否则使用当前域名
      // 注意：不要添加 hash，Supabase 会自动添加 #access_token=xxx&type=recovery
      const redirectUrl = import.meta.env.VITE_APP_URL || window.location.origin;
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: redirectUrl,
      });

      if (error) {
        setMsgType('error');
        setMsg(`Failed to send reset email: ${error.message}`);
      } else {
        setMsgType('success');
        setMsg('🔑 Password reset email sent! Please check your inbox (including spam folder) and click the link to reset your password.');
        setEmailSent(true);
      }
    } catch (error: unknown) {
      setMsgType('error');
      const errorMessage = error instanceof Error ? error.message : 'Failed to send password reset email. Please try again later.';
      setMsg(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const getMessageClass = () => {
    switch (msgType) {
      case 'success':
        return 'bg-electric-green/10 text-electric-green border-electric-green/30';
      case 'error':
        return 'bg-red-500/10 text-red-400 border-red-500/30';
      default:
        return 'bg-electric-blue/10 text-electric-blue border-electric-blue/30';
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-dark-charcoal p-4 relative overflow-hidden">
      <style>{`
        @keyframes breathe {
          0%, 100% { opacity: 0.3; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(1.2); }
        }
        @keyframes rotate-bg {
          0% { transform: translate(-50%, -50%) rotate(0deg); }
          100% { transform: translate(-50%, -50%) rotate(360deg); }
        }
        .animate-breathe {
          animation: breathe 8s ease-in-out infinite;
        }
        .animate-rotate-bg {
          animation: rotate-bg 30s linear infinite;
        }
      `}</style>

      {/* Background Decorations */}
      <div className="absolute top-1/2 left-1/2 w-[150vw] h-[150vw] md:w-[120vmax] md:h-[120vmax] pointer-events-none animate-rotate-bg z-0">
        <div className="absolute top-[5%] left-[5%] w-[45%] h-[45%] bg-electric-purple/40 blur-[150px] rounded-full animate-breathe" />
        <div className="absolute bottom-[5%] right-[5%] w-[45%] h-[45%] bg-electric-blue/40 blur-[150px] rounded-full animate-breathe" style={{ animationDelay: '-4s' }} />
      </div>

      <div className="w-full max-w-md bg-light-charcoal/80 backdrop-blur-xl p-8 rounded-3xl border border-white/10 shadow-2xl relative z-10">
        <div className="text-center mb-8">
          <div className="w-20 h-20 mx-auto mb-4 bg-electric-blue/20 rounded-full flex items-center justify-center">
            <span className="material-symbols-outlined text-5xl text-electric-blue">lock_open</span>
          </div>
          <h1 className="font-headline text-4xl text-white tracking-tight mb-2">FORGOT PASSWORD</h1>
          <p className="font-mono text-xs text-text-dark uppercase tracking-widest">Enter your email to reset password</p>
        </div>

        {!emailSent ? (
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-xs font-mono text-text-dark mb-2 uppercase">Email Address</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="w-full bg-dark-charcoal border border-mid-charcoal rounded-xl p-4 text-white focus:border-electric-blue focus:ring-1 focus:ring-electric-blue outline-none transition-all"
                placeholder="user@example.com"
              />
            </div>

            {msg && (
              <div className={`text-xs p-3 rounded-lg border ${getMessageClass()}`}>
                {msg}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-4 bg-electric-blue text-charcoal font-headline text-xl rounded-xl hover:bg-white transition-colors disabled:opacity-50"
            >
              {loading ? 'SENDING...' : 'SEND RESET EMAIL'}
            </button>

            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={onBackToLogin}
                className="text-xs font-mono text-text-dark hover:text-electric-blue underline uppercase"
              >
                ← Back to Login
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-6">
            <div className={`text-xs p-4 rounded-lg border ${getMessageClass()}`}>
              <div className="mb-2">{msg}</div>
              <div className="text-[10px] opacity-75">
                The email will contain a link to reset your password. The link will expire in 1 hour.
              </div>
            </div>

            <button
              onClick={onBackToLogin}
              className="w-full py-4 bg-electric-blue text-charcoal font-headline text-xl rounded-xl hover:bg-white transition-colors"
            >
              Back to Login
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default PasswordForgotRequest;
