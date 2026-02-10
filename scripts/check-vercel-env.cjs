#!/usr/bin/env node

/**
 * Vercel 部署前环境变量检查
 * 运行: node scripts/check-vercel-env.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🔍 Vercel 部署环境变量检查\n');

// 颜色输出
const green = (text) => `\x1b[32m${text}\x1b[0m`;
const red = (text) => `\x1b[31m${text}\x1b[0m`;
const yellow = (text) => `\x1b[33m${text}\x1b[0m`;
const blue = (text) => `\x1b[34m${text}\x1b[0m`;

// 检查本地 .env 文件
console.log(blue('1️⃣ 本地环境变量检查'));
const envPath = path.join(__dirname, '..', '.env');

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const hasSupabaseUrl = envContent.includes('SUPABASE_URL=');
  const hasAnonKey = envContent.includes('SUPABASE_ANON_KEY=');

  if (hasSupabaseUrl && hasAnonKey) {
    console.log(green('   ✅ .env 文件已配置'));
    const urlMatch = envContent.match(/SUPABASE_URL=(.+)/);
    if (urlMatch) {
      console.log(`   URL: ${urlMatch[1]}`);
    }
  } else {
    console.log(red('   ❌ .env 文件缺少必需变量'));
    if (!hasSupabaseUrl) console.log(red('   缺少: SUPABASE_URL'));
    if (!hasAnonKey) console.log(red('   缺少: SUPABASE_ANON_KEY'));
  }
} else {
  console.log(red('   ❌ .env 文件不存在'));
}

console.log('');

// 检查是否安装了 Vercel CLI
console.log(blue('2️⃣ Vercel CLI 检查'));
try {
  execSync('vercel --version', { stdio: 'pipe' });
  console.log(green('   ✅ Vercel CLI 已安装'));
} catch {
  console.log(yellow('   ⚠️ Vercel CLI 未安装'));
  console.log('   安装命令: npm i -g vercel');
}

console.log('');

// 检查是否已登录 Vercel
console.log(blue('3️⃣ Vercel 登录状态'));
try {
  execSync('vercel whoami', { stdio: 'pipe' });
  console.log(green('   ✅ 已登录 Vercel'));
} catch {
  console.log(yellow('   ⚠️ 未登录 Vercel'));
  console.log('   登录命令: vercel login');
}

console.log('');

// Vercel 环境变量配置指南
console.log(blue('4️⃣ Vercel 环境变量配置'));
console.log('');
console.log(yellow('   ⚠️ 重要：Vercel 不会自动读取 .env 文件！'));
console.log('');
console.log('   需要在 Vercel Dashboard 中手动配置：');
console.log('');
console.log('   步骤：');
console.log('   1. 访问 Vercel 项目');
console.log('   2. 进入 Settings → Environment Variables');
console.log('   3. 添加以下变量：');
console.log('');
console.log(green('      VITE_SUPABASE_URL'));
console.log('      值: https://mkdxdlsjisqazermmfoe.supabase.co');
console.log('');
console.log(green('      VITE_SUPABASE_ANON_KEY'));
console.log('      值: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...');
console.log('');
console.log('   4. 选择所有环境（Production, Preview, Development）');
console.log('   5. 重新部署应用');

console.log('');
console.log(blue('5️⃣ 部署前检查清单'));
console.log('');
const checks = [
  '✅ 本地 .env 文件已配置',
  '✅ 本地测试发音功能正常',
  '⏳ Vercel 环境变量已配置',
  '⏳ 重新部署完成',
  '⏳ Vercel 生产环境测试发音'
];

checks.forEach(check => console.log(`   ${check}`));

console.log('');
console.log(blue('📚 详细文档'));
console.log('   docs/vercel-env-setup.md - Vercel 环境变量完整指南');
console.log('   docs/pronunciation-deployment.md - Edge Function 部署指南');
console.log('');

// 快速部署命令
console.log(blue('🚀 快速部署命令'));
console.log('');
console.log('   # 部署到 Vercel');
console.log('   vercel --prod');
console.log('');
console.log('   # 或使用 Vercel Dashboard');
console.log('   https://vercel.com/your-account/vocabulary-vibe');
console.log('');
