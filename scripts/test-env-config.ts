/**
 * 测试环境变量配置
 * 运行: npm run test-env (需要在 package.json 中添加)
 */

// 模拟客户端环境
console.log('=== 测试环境变量配置 ===\n');

// 1. 测试服务端变量（Node.js）
console.log('1️⃣ 服务端环境变量（Node.js）:');
console.log(`   process.env.SUPABASE_URL: ${process.env.SUPABASE_URL ? '✅ 已定义' : '❌ 未定义'}`);
console.log(`   值: ${process.env.SUPABASE_URL}\n`);

// 2. 测试客户端变量（浏览器）
console.log('2️⃣ 客户端环境变量（浏览器）:');
if (typeof import.meta !== 'undefined' && import.meta.env) {
  console.log(`   import.meta.env.VITE_SUPABASE_URL: ${import.meta.env.VITE_SUPABASE_URL ? '✅ 已定义' : '❌ 未定义'}`);
  console.log(`   值: ${import.meta.env.VITE_SUPABASE_URL}\n`);
} else {
  console.log('   ⚠️ 运行在 Node.js 环境，import.meta.env 不可用\n');
}

// 3. 验证配置一致性
console.log('3️⃣ 配置验证:');
const serverUrl = process.env.SUPABASE_URL;
const clientUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';

if (serverUrl && clientUrl && serverUrl === clientUrl) {
  console.log('   ✅ 服务端和客户端配置一致');
  console.log(`   URL: ${serverUrl}`);
} else if (serverUrl && !clientUrl) {
  console.log('   ⚠️ 仅服务端配置存在（Node.js 环境）');
} else if (serverUrl !== clientUrl) {
  console.log('   ❌ 服务端和客户端配置不一致！');
  console.log(`   服务端: ${serverUrl}`);
  console.log(`   客户端: ${clientUrl}`);
} else {
  console.log('   ❌ 配置缺失！');
}

console.log('\n=== 测试完成 ===');

export {};
