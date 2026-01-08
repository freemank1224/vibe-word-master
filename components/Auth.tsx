
import React, { useState } from 'react';
import { supabase } from '../lib/supabaseClient';

export const Auth: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'LOGIN' | 'SIGNUP'>('LOGIN');
  const [msg, setMsg] = useState('');

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMsg('');

    try {
      if (mode === 'SIGNUP') {
        const { error } = await supabase.auth.signUp({
          email,
          password,
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
    <div className="min-h-screen flex items-center justify-center bg-dark-charcoal p-4">
      <div className="w-full max-w-md bg-light-charcoal p-8 rounded-3xl border border-mid-charcoal shadow-2xl animate-in fade-in zoom-in duration-500">
        <div className="text-center mb-8">
            <span className="material-symbols-outlined text-electric-blue text-5xl mb-2">bolt</span>
            <h1 className="font-headline text-4xl text-white tracking-tighter">VOCAB VIBE</h1>
            <p className="font-mono text-xs text-text-dark uppercase tracking-widest mt-2">Cloud Sync Edition</p>
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
            {loading ? 'PROCESSING...' : (mode === 'LOGIN' ? 'ENTER THE VOID' : 'INITIATE ACCOUNT')}
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
