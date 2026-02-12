import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';

export const PasswordReset: React.FC<{ accessToken: string; onClose: () => void }> = ({ accessToken, onClose }) => {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [sessionSet, setSessionSet] = useState(false);

  // Ensure recovery session is available before allowing password update.
  useEffect(() => {
    let isMounted = true;
    let sessionCheckTimer: number | undefined;

    const markSessionReady = () => {
      if (!isMounted) return;
      setSessionSet(true);
      setError('');
    };

    const checkCurrentSession = async (): Promise<boolean> => {
      const { data: { session }, error: checkError } = await supabase.auth.getSession();

      if (checkError) {
        throw checkError;
      }

      if (session) {
        markSessionReady();
        return true;
      }

      return false;
    };

    const trySetSessionFromUrlTokens = async (): Promise<void> => {
      const hash = window.location.hash.startsWith('#')
        ? window.location.hash.substring(1)
        : window.location.hash;
      const params = new URLSearchParams(hash);
      const accessTokenFromHash = params.get('access_token');
      const refreshTokenFromHash = params.get('refresh_token');

      if (!accessTokenFromHash || !refreshTokenFromHash) {
        return;
      }

      const { error: setSessionError } = await supabase.auth.setSession({
        access_token: accessTokenFromHash,
        refresh_token: refreshTokenFromHash,
      });

      if (setSessionError) {
        throw setSessionError;
      }
    };

    const checkSession = async () => {
      try {
        if (await checkCurrentSession()) {
          return;
        }

        // Fallback for edge cases where the SDK hasn't parsed hash yet.
        await trySetSessionFromUrlTokens();

        if (await checkCurrentSession()) {
          return;
        }

        sessionCheckTimer = window.setTimeout(async () => {
          try {
            const hasSession = await checkCurrentSession();
            if (!hasSession && isMounted) {
              console.error('No session found');
              setError('No valid session found. The reset link may be expired.');
            }
          } catch (timerError: unknown) {
            console.error('Delayed session check error:', timerError);
            const errorMessage = timerError instanceof Error ? timerError.message : 'Failed to check session';
            if (isMounted) {
              setError(errorMessage);
            }
          }
        }, 1200);
      } catch (err: unknown) {
        console.error('Check session error:', err);
        const errorMessage = err instanceof Error ? err.message : 'Failed to check session';
        if (isMounted) {
          setError(errorMessage);
        }
      }
    };

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!isMounted) return;
      if (session && (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')) {
        markSessionReady();
      }
    });

    checkSession();

    return () => {
      isMounted = false;
      if (sessionCheckTimer) {
        window.clearTimeout(sessionCheckTimer);
      }
      subscription.unsubscribe();
    };
  }, [accessToken]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const { error } = await supabase.auth.updateUser({
        password: password,
      });

      if (error) throw error;

      setPassword('');
      setConfirmPassword('');
      setSuccess(true);
      setTimeout(() => {
        onClose();
      }, 3000);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to reset password';
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  if (success) {
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
            <div className="w-20 h-20 mx-auto mb-4 bg-electric-green/20 rounded-full flex items-center justify-center">
              <span className="material-symbols-outlined text-5xl text-electric-green">check</span>
            </div>
            <h1 className="font-headline text-4xl text-white tracking-tight mb-2">Password Reset Successful</h1>
            <p className="font-mono text-xs text-text-dark uppercase tracking-widest">Your password has been updated</p>
          </div>

          <div className="text-center">
            <button
              onClick={onClose}
              className="w-full py-4 bg-electric-blue text-charcoal font-headline text-xl rounded-xl hover:bg-white transition-colors"
            >
              Continue to Login
            </button>
          </div>
        </div>
      </div>
    );
  }

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
            <span className="material-symbols-outlined text-5xl text-electric-blue">lock_reset</span>
          </div>
          <h1 className="font-headline text-4xl text-white tracking-tight mb-2">RESET PASSWORD</h1>
          <p className="font-mono text-xs text-text-dark uppercase tracking-widest">Enter your new password below</p>
        </div>

        {!sessionSet && !error && (
          <div className="bg-electric-blue/10 text-electric-blue text-xs p-3 rounded-lg border border-electric-blue/30 mb-4">
            🔐 Setting up secure session...
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-xs font-mono text-text-dark mb-2 uppercase">New Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className="w-full bg-dark-charcoal border border-mid-charcoal rounded-xl p-4 text-white focus:border-electric-blue focus:ring-1 focus:ring-electric-blue outline-none transition-all"
              placeholder="Enter new password (min 6 characters)"
              minLength={6}
            />
          </div>

          <div>
            <label className="block text-xs font-mono text-text-dark mb-2 uppercase">Confirm Password</label>
            <input
              type="password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              className="w-full bg-dark-charcoal border border-mid-charcoal rounded-xl p-4 text-white focus:border-electric-blue focus:ring-1 focus:ring-electric-blue outline-none transition-all"
              placeholder="Confirm new password"
              minLength={6}
            />
          </div>

          {error && (
            <div className="bg-red-500/10 text-red-400 text-xs p-3 rounded-lg border border-red-500/30">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !sessionSet}
            className="w-full py-4 bg-electric-blue text-charcoal font-headline text-xl rounded-xl hover:bg-white transition-colors disabled:opacity-50"
          >
            {loading ? 'PROCESSING...' : !sessionSet ? 'SETTING UP SESSION...' : 'UPDATE PASSWORD'}
          </button>

          <div className="mt-4 text-center">
            <button
              type="button"
              onClick={onClose}
              className="text-xs font-mono text-text-dark hover:text-electric-blue underline uppercase"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default PasswordReset;
