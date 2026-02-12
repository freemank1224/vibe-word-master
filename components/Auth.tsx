
import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';

interface AuthProps {
  onForgotPassword?: () => void;
}

export const Auth: React.FC<AuthProps> = ({ onForgotPassword }) => {
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'LOGIN' | 'SIGNUP'>('LOGIN');
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState<'success' | 'error' | 'info'>('info');
  const [failedAttempts, setFailedAttempts] = useState(0);

  // Mascot logic
  const getMascotTheme = () => {
    const day = new Date().getDay();
    const themes = [
        { src: '/monsterImages/M0.webp' },
        { src: '/monsterImages/M1.webp' },
        { src: '/monsterImages/M2.webp' },
        { src: '/monsterImages/M3.webp' },
        { src: '/monsterImages/M4.webp' },
        { src: '/monsterImages/M5.webp' },
        { src: '/monsterImages/M6.webp' },
        { src: '/monsterImages/M7.webp' },
    ];
    return themes[day] || themes[0];
  };

  const currentTheme = getMascotTheme();

  // Reset failed attempts when email or mode changes
  useEffect(() => {
    setFailedAttempts(0);
  }, [email, mode]);

  // Check if user already exists before signup
  const checkUserExists = async (email: string): Promise<{ exists: boolean; email_confirmed: string | null } | null> => {
    try {
      const supabaseUrl = process.env.SUPABASE_URL || '';
      const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

      if (!supabaseUrl) {
        console.error('SUPABASE_URL not configured');
        return null;
      }

      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(
        `${supabaseUrl}/functions/v1/check_user_exists`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token || supabaseAnonKey}`,
          },
          body: JSON.stringify({ email }),
        }
      );

      if (!response.ok) {
        console.error('check_user_exists failed:', response.status, response.statusText);
        return null;
      }

      const result = await response.json();
      return result;
    } catch (error) {
      console.error('Error checking user exists:', error);
      return null;
    }
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMsg('');
    setMsgType('info');

    try {
      if (mode === 'SIGNUP') {
        // First check if user already exists
        const checkResult = await checkUserExists(email);

        if (checkResult?.exists) {
          // User already exists
          if (checkResult.email_confirmed) {
            setMsgType('info');
            setMsg("This email is already registered. Please switch to \"Login\" mode to sign in. If you've forgotten your password, use \"Forgot Password\" option below.");
          } else {
            setMsgType('info');
            setMsg("Your account exists but email hasn't been confirmed yet. Please check your inbox (including spam folder) or click \"Resend Email\" below.");
          }
          setLoading(false);
          return;
        }

        // Proceed with signup
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: window.location.origin,
          },
        });

        if (error) {
          // Handle various error scenarios
          if (error.message.includes('User already registered') || error.message.includes('already been registered')) {
            setMsgType('info');
            setMsg("This email is already registered. Please switch to \"Login\" mode to sign in. If you've forgotten your password, use \"Forgot Password\" option below.");
          } else if (error.message.includes('Email not confirmed') || error.message.includes('not confirmed')) {
            setMsgType('info');
            setMsg("Your account exists but email hasn't been confirmed yet. Please check your inbox (including spam folder) or click \"Resend Email\" below.");
          } else {
            setMsgType('error');
            setMsg(`Signup failed: ${error.message}`);
          }
        } else {
          // Check if email confirmation is required
          if (data.user && !data.user.email_confirmed_at) {
            setMsgType('success');
            setMsg('🎉 Account created! Please check your email to activate your account (including spam folder).');
            setPassword('');
          } else if (data.session) {
            setMsgType('success');
            setMsg('✅ Account created and logged in successfully!');
            setPassword('');
          }
        }
      } else {
        // LOGIN mode
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });

        if (error) {
          // Increment failed attempts for invalid credentials
          if (error.message.includes('Invalid login credentials')) {
            const newAttempts = failedAttempts + 1;
            setFailedAttempts(newAttempts);

            if (newAttempts >= 3) {
              setMsgType('error');
              setMsg(`❌ Invalid password (3 attempts). Forgot your password? Click "Forgot Password" below to reset it.`);
            } else {
              setMsgType('error');
              setMsg(`Invalid email or password (${newAttempts}/3 attempts). Please try again.`);
            }
          } else if (error.message.includes('Email not confirmed')) {
            setMsgType('error');
            setMsg('Please confirm your email address first. Check your inbox (including spam folder).');
          } else {
            setMsgType('error');
            setMsg(`Login failed: ${error.message}`);
          }
        } else {
          // Reset failed attempts on successful login
          setFailedAttempts(0);
          setMsgType('success');
          setMsg('Welcome back! 🎮 Loading your data...');
          setPassword('');
        }
      }
    } catch (error: unknown) {
      setMsgType('error');
      const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred. Please try again.';
      setMsg(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin,
        },
      });
      if (error) throw error;
    } catch (error: unknown) {
      setMsgType('error');
      const errorMessage = error instanceof Error ? error.message : 'Failed to login with Google';
      setMsg(errorMessage);
    }
  };

  const handleResendActivation = async (e: React.MouseEvent) => {
    e.preventDefault();
    try {
      await supabase.auth.resend({
        type: 'signup',
        email: email,
      });
      setMsgType('success');
      setMsg('📧 Activation email resent! Please check your inbox (including spam folder).');
    } catch (error: unknown) {
      setMsgType('error');
      const errorMessage = error instanceof Error ? error.message : 'Failed to resend activation email. Please try again later.';
      setMsg(errorMessage);
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

  const getButtonLabel = () => {
    if (mode === 'LOGIN') {
      return 'START';
    } else {
      return 'INITIATE ACCOUNT';
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

        {/* Background Decorations - Rotating Container */}
        <div className="absolute top-1/2 left-1/2 w-[150vw] h-[150vw] md:w-[120vmax] md:h-[120vmax] pointer-events-none animate-rotate-bg z-0">
            {/* Purple Blob - Top Left */}
            <div className="absolute top-[5%] left-[5%] w-[45%] h-[45%] bg-electric-purple/40 blur-[150px] rounded-full animate-breathe" />

            {/* Blue Blob - Bottom Right */}
            <div className="absolute bottom-[5%] right-[5%] w-[45%] h-[45%] bg-electric-blue/40 blur-[150px] rounded-full animate-breathe" style={{ animationDelay: '-4s' }} />
        </div>

        <div className="w-full max-w-md bg-light-charcoal/80 backdrop-blur-xl p-8 rounded-3xl border border-white/10 shadow-2xl animate-in fade-in zoom-in duration-500 relative z-10">
          <div className="text-center mb-8">
            <img
              src={currentTheme.src}
              alt="Mascot"
              className="w-[144px] h-[144px] mx-auto mb-2 object-contain"
            />
            <h1 className="font-headline text-4xl text-white tracking-tight">VOCAB MONSTER</h1>
            <p className="font-mono text-xs text-text-dark uppercase tracking-widest mt-2">Learn & practise like a monster</p>
          </div>

          <form onSubmit={handleAuth} className="space-y-6">
            <div>
              <label className="block text-xs font-mono text-text-dark mb-2 uppercase">Email</label>
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
            <div>
              <label className="block text-xs font-mono text-text-dark mb-2 uppercase">Password</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'LOGIN' ? 'current-password' : 'new-password'}
                className="w-full bg-dark-charcoal border border-mid-charcoal rounded-xl p-4 text-white focus:border-electric-blue focus:ring-1 focus:ring-electric-blue outline-none transition-all"
                placeholder="•••••••"
              />
            </div>

          {/* Enhanced Status Message */}
          {msg && (
            <div className={`text-xs p-3 rounded-lg border ${getMessageClass()}`}>
              <div className="mb-2">{msg}</div>

              {/* Show appropriate action buttons based on message */}
              <div className="flex flex-wrap gap-2 mt-2">
                {(msg.includes('already registered') || msg.includes('not confirmed') || msg.includes('Invalid password') || msg.includes('attempts')) && (
                  <>
                    <button
                      type="button"
                      onClick={handleResendActivation}
                      className="text-xs bg-electric-blue/20 text-electric-blue px-3 py-1.5 rounded-lg hover:bg-electric-blue/30 transition-colors"
                      title="Resend activation email"
                    >
                      📧 Resend Email
                    </button>

                    <button
                      type="button"
                      onClick={() => onForgotPassword?.()}
                      className="text-xs bg-white/10 text-white px-3 py-1.5 rounded-lg hover:bg-white/20 transition-colors"
                      title="Reset password"
                    >
                      🔑 Forgot Password
                    </button>
                  </>
                )}
                {msg.includes('Password reset email sent') && (
                  <button
                    type="button"
                    onClick={() => { setMode('LOGIN'); setMsg(''); setMsgType('info'); }}
                    className="text-xs bg-electric-blue/20 text-electric-blue px-3 py-1.5 rounded-lg hover:bg-electric-blue/30 transition-colors"
                  >
                    ← Back to Login
                  </button>
                )}
                {msg.includes('Activation email resent') && (
                  <button
                    type="button"
                    onClick={() => { setMsg(''); setMsgType('info'); }}
                    className="text-xs bg-white/10 text-white px-3 py-1.5 rounded-lg hover:bg-white/20 transition-colors"
                  >
                    Dismiss
                  </button>
                )}
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-4 bg-electric-blue text-charcoal font-headline text-xl rounded-xl hover:bg-white transition-colors disabled:opacity-50"
          >
            {loading ? 'PROCESSING...' : getButtonLabel()}
          </button>
        </form>

        <div className="mt-6 flex items-center gap-4">
          <div className="flex-1 h-[1px] bg-mid-charcoal" />
          <span className="text-[10px] font-mono text-text-dark uppercase">or</span>
          <div className="flex-1 h-[1px] bg-mid-charcoal" />
        </div>

        <button
          onClick={handleGoogleLogin}
          className="mt-6 w-full py-4 bg-white/5 border border-white/10 text-white font-headline text-lg rounded-xl hover:bg-white/10 transition-all flex items-center justify-center gap-3"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path
              d="M21.805 10.023h-9.18v3.955h5.277c-.228 1.252-.94 2.313-2.006 3.023v2.512h3.247c1.9-1.75 2.996-4.328 2.996-7.39 0-.7-.063-1.373-.334-2.1z"
              fill="#4285F4"
            />
            <path
              d="M12.625 22c2.7 0 4.965-.895 6.62-2.422l-3.247-2.512c-.902.605-2.06.965-3.373.965-2.59 0-4.78-1.74-5.56-4.085H3.71v2.577A10 10 0 0 0 12.625 22z"
              fill="#34A853"
            />
            <path
              d="M7.066 13.946a5.996 5.996 0 0 1 0-3.892V7.477H3.71a10 10 0 0 0 0 8.99l3.356-2.52z"
              fill="#FBBC05"
            />
            <path
              d="M12.625 5.969c1.467 0 2.786.505 3.823 1.496l2.865-2.864C17.585 2.984 15.325 2 12.625 2A10 10 0 0 0 3.71 7.477l3.356 2.577c.78-2.345 2.97-4.085 5.56-4.085z"
              fill="#EA4335"
            />
            </svg>
          CONTINUE WITH GOOGLE
        </button>

        <div className="mt-6 text-center">
          <button
            onClick={() => { setMode(mode === 'LOGIN' ? 'SIGNUP' : 'LOGIN'); setMsg(''); setMsgType('info'); }}
            className="text-xs font-mono text-text-dark hover:text-electric-blue underline uppercase"
          >
            {mode === 'LOGIN' ? "Need an account? Sign Up" : "Already have an account? Login"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Auth;
