
import React, { useState } from 'react';
import { supabase } from '../lib/supabaseClient';

export const Auth: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'LOGIN' | 'SIGNUP'>('LOGIN');
  const [msg, setMsg] = useState('');

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
    ];
    return themes[day] || themes[0];
  };

  const currentTheme = getMascotTheme();

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMsg('');

    try {
      if (mode === 'SIGNUP') {
        // Explicitly tell Supabase to redirect back to the current URL (e.g., sandbox URL)
        // Note: This URL must also be added to "Redirect URLs" in Supabase Dashboard
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: window.location.origin,
          },
        });
        if (error) throw error;
        setMsg('Signup successful! Please check your email for verification (or login if auto-confirm is on).');
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
      }
    } catch (error: any) {
      setMsg(error.message);
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
    } catch (error: any) {
      setMsg(error.message);
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
              className="w-full bg-dark-charcoal border border-mid-charcoal rounded-xl p-4 text-white focus:border-electric-blue focus:ring-1 focus:ring-electric-blue outline-none transition-all"
              placeholder="••••••••"
            />
          </div>

          {msg && (
            <div className={`text-xs p-3 rounded-lg border ${msg.includes('success') ? 'bg-electric-green/10 text-electric-green border-electric-green/30' : 'bg-red-500/10 text-red-400 border-red-500/30'}`}>
                {msg}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-4 bg-electric-blue text-charcoal font-headline text-xl rounded-xl hover:bg-white transition-colors disabled:opacity-50"
          >
            {loading ? 'PROCESSING...' : (mode === 'LOGIN' ? 'START' : 'INITIATE ACCOUNT')}
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
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              fill="#4285F4"
            />
            <path
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              fill="#34A853"
            />
            <path
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              fill="#FBBC05"
            />
            <path
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              fill="#EA4335"
            />
          </svg>
          CONTINUE WITH GOOGLE
        </button>

        <div className="mt-6 text-center">
          <button
            onClick={() => { setMode(mode === 'LOGIN' ? 'SIGNUP' : 'LOGIN'); setMsg(''); }}
            className="text-xs font-mono text-text-dark hover:text-electric-blue underline uppercase"
          >
            {mode === 'LOGIN' ? "Need an account? Sign Up" : "Already have an account? Login"}
          </button>
        </div>
      </div>
    </div>
  );
};
