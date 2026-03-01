import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    const runtimeEnv = process.env as Record<string, string | undefined>;

    const getEnv = (key: string, fallback = ''): string => {
      return runtimeEnv[key] || env[key] || fallback;
    };

  const supabaseUrl = getEnv('VITE_SUPABASE_URL') || getEnv('SUPABASE_URL');
  const supabaseAnonKey = getEnv('VITE_SUPABASE_ANON_KEY') || getEnv('SUPABASE_ANON_KEY');

    const isProdBuild = mode === 'production';
    if (isProdBuild) {
      const missing: string[] = [];
      if (!supabaseUrl) missing.push('VITE_SUPABASE_URL or SUPABASE_URL');
      if (!supabaseAnonKey) missing.push('VITE_SUPABASE_ANON_KEY or SUPABASE_ANON_KEY');

      if (missing.length > 0) {
        throw new Error(
          `[build-config] Missing required Supabase env vars for production build: ${missing.join(', ')}. ` +
          `Please configure them in Vercel Project Settings -> Environment Variables (Production), then redeploy.`
        );
      }
    }

    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      define: {
        // Server-side environment variables (for Node.js scripts)
        'process.env.API_KEY': JSON.stringify(getEnv('API_KEY') || getEnv('GEMINI_API_KEY')),
        'process.env.GEMINI_API_KEY': JSON.stringify(getEnv('GEMINI_API_KEY')),
        'process.env.OPENAI_API_KEY': JSON.stringify(getEnv('OPENAI_API_KEY')),
        'process.env.IMAGE_GEN_PROVIDER': JSON.stringify(getEnv('IMAGE_GEN_PROVIDER', 'gemini')),
        'process.env.TTS_PROVIDER': JSON.stringify(getEnv('TTS_PROVIDER', 'gemini')),
        'process.env.OCR_PROVIDER': JSON.stringify(getEnv('OCR_PROVIDER', 'gemini')),
        'process.env.SPELLING_CHECK_PROVIDER': JSON.stringify(getEnv('SPELLING_CHECK_PROVIDER', 'gemini')),
        'process.env.STT_PROVIDER': JSON.stringify(getEnv('STT_PROVIDER', 'gemini')),
        'process.env.IMAGE_GEN_API_KEY': JSON.stringify(getEnv('IMAGE_GEN_API_KEY')),
        'process.env.IMAGE_GEN_ENDPOINT': JSON.stringify(getEnv('IMAGE_GEN_ENDPOINT')),
        'process.env.TTS_API_KEY': JSON.stringify(getEnv('TTS_API_KEY')),
        'process.env.TTS_ENDPOINT': JSON.stringify(getEnv('TTS_ENDPOINT')),
        'process.env.OCR_API_KEY': JSON.stringify(getEnv('OCR_API_KEY')),
        'process.env.OCR_ENDPOINT': JSON.stringify(getEnv('OCR_ENDPOINT')),
        'process.env.SPELLING_CHECK_API_KEY': JSON.stringify(getEnv('SPELLING_CHECK_API_KEY')),
        'process.env.SPELLING_CHECK_ENDPOINT': JSON.stringify(getEnv('SPELLING_CHECK_ENDPOINT')),
        'process.env.STT_API_KEY': JSON.stringify(getEnv('STT_API_KEY')),
        'process.env.STT_ENDPOINT': JSON.stringify(getEnv('STT_ENDPOINT')),
        'process.env.GEMINI_ENDPOINT': JSON.stringify(getEnv('GEMINI_ENDPOINT', 'https://generativelanguage.googleapis.com')),
        'process.env.OPENAI_ENDPOINT': JSON.stringify(getEnv('OPENAI_ENDPOINT', 'https://api.openai.com/v1')),
        'process.env.SUPABASE_URL': JSON.stringify(supabaseUrl),
        'process.env.SUPABASE_ANON_KEY': JSON.stringify(supabaseAnonKey),

        // Client-side environment variables (expose VITE_* to import.meta.env)
        'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(supabaseUrl),
        'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(supabaseAnonKey),
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
