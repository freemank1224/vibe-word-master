import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
  const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL || '';
  const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || '';
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      define: {
        // Server-side environment variables (for Node.js scripts)
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.OPENAI_API_KEY': JSON.stringify(env.OPENAI_API_KEY),
        'process.env.IMAGE_GEN_PROVIDER': JSON.stringify(env.IMAGE_GEN_PROVIDER || 'gemini'),
        'process.env.TTS_PROVIDER': JSON.stringify(env.TTS_PROVIDER || 'gemini'),
        'process.env.OCR_PROVIDER': JSON.stringify(env.OCR_PROVIDER || 'gemini'),
        'process.env.SPELLING_CHECK_PROVIDER': JSON.stringify(env.SPELLING_CHECK_PROVIDER || 'gemini'),
        'process.env.STT_PROVIDER': JSON.stringify(env.STT_PROVIDER || 'gemini'),
        'process.env.IMAGE_GEN_API_KEY': JSON.stringify(env.IMAGE_GEN_API_KEY),
        'process.env.IMAGE_GEN_ENDPOINT': JSON.stringify(env.IMAGE_GEN_ENDPOINT),
        'process.env.TTS_API_KEY': JSON.stringify(env.TTS_API_KEY),
        'process.env.TTS_ENDPOINT': JSON.stringify(env.TTS_ENDPOINT),
        'process.env.OCR_API_KEY': JSON.stringify(env.OCR_API_KEY),
        'process.env.OCR_ENDPOINT': JSON.stringify(env.OCR_ENDPOINT),
        'process.env.SPELLING_CHECK_API_KEY': JSON.stringify(env.SPELLING_CHECK_API_KEY),
        'process.env.SPELLING_CHECK_ENDPOINT': JSON.stringify(env.SPELLING_CHECK_ENDPOINT),
        'process.env.STT_API_KEY': JSON.stringify(env.STT_API_KEY),
        'process.env.STT_ENDPOINT': JSON.stringify(env.STT_ENDPOINT),
        'process.env.GEMINI_ENDPOINT': JSON.stringify(env.GEMINI_ENDPOINT || 'https://generativelanguage.googleapis.com'),
        'process.env.OPENAI_ENDPOINT': JSON.stringify(env.OPENAI_ENDPOINT || 'https://api.openai.com/v1'),
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
