
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
        { src: '/monsterImages/M0.png' },
        { src: '/monsterImages/M1.png' },
        { src: '/monsterImages/M2.png' },
        { src: '/monsterImages/M3.png' },
        { src: '/monsterImages/M4.png' },
        { src: '/monsterImages/M5.png' },
        { src: '/monsterImages/M6.png' },
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
