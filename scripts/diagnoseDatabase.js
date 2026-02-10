#!/usr/bin/env node

/**
 * 前后端数据库不匹配诊断工具 (Node.js 版本)
 *
 * 使用方法:
 *   node scripts/diagnoseDatabase.js
 *
 * 功能:
 *   - 连接到 Supabase 数据库
 *   - 检查所有必需的表和字段
 *   - 生成详细的不匹配报告
 *   - 提供修复建议
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const log = {
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  warning: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  info: (msg) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  header: (msg) => {
    console.log('');
    console.log(`${colors.blue}════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.blue}${msg}${colors.reset}`);
    console.log(`${colors.blue}════════════════════════════════════════${colors.reset}`);
  },
};

// 定义所有必需的字段
const REQUIRED_FIELDS = {
  daily_stats: [
    'id',
    'user_id',
    'date',
    'total',
    'correct',
    'points', // 🔴 关键字段
  ],
  words: [
    'id',
    'user_id',
    'session_id',
    'text',
    'image_path',
    'tested',
    'correct',
    'created_at',
    // V2 测试字段
    'last_tested',
    'error_count',
    'best_time_ms',
    'score',
    // 词典字段
    'phonetic',
    'audio_url',
    'definition_en',
    'definition_cn',
    'language',
    // 软删除和标签
    'deleted',
    'deleted_at',
    'tags',
  ],
  sessions: [
    'id',
    'user_id',
    'word_count',
    'target_count',
    'created_at',
    'deleted',
    'deleted_at',
    'library_tag',
  ],
  user_achievements: [
    'id',
    'user_id',
    'achievement_id',
    'created_at',
  ],
};

// 定义数据库函数
const REQUIRED_FUNCTIONS = [
  'sync_todays_stats_with_timezone',
  'sync_todays_stats',
  'consolidate_daily_stats',
];

/**
 * 主诊断函数
 */
async function diagnose() {
  log.header('🔍 前后端数据库不匹配诊断工具');

  // 检查环境变量
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    log.error('缺少环境变量 SUPABASE_URL 或 SUPABASE_ANON_KEY');
    log.info('请在 .env 文件中配置这些变量');
    process.exit(1);
  }

  log.success('环境变量配置正确');

  // 创建 Supabase 客户端
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  log.info(`连接到: ${process.env.SUPABASE_URL}`);

  // 执行诊断
  const results = {
    tables: {},
    functions: {},
  };

  // 检查表结构
  for (const [tableName, requiredFields] of Object.entries(REQUIRED_FIELDS)) {
    log.header(`检查表: ${tableName}`);

    try {
      const result = await checkTableStructure(supabase, tableName, requiredFields);
      results.tables[tableName] = result;

      if (result.missing.length === 0) {
        log.success(`✓ ${tableName} 表结构完整`);
      } else {
        log.error(`✗ ${tableName} 表缺失 ${result.missing.length} 个字段`);
        result.missing.forEach((field) => {
          console.log(`  - ${field}`);
        });
      }
    } catch (error) {
      log.error(`检查 ${tableName} 表时出错: ${error.message}`);
      results.tables[tableName] = {
        exists: false,
        present: [],
        missing: requiredFields,
        error: error.message,
      };
    }
  }

  // 检查数据库函数
  log.header('检查数据库函数');

  try {
    const functionsResult = await checkFunctions(supabase);
    results.functions = functionsResult;

    if (functionsResult.missing.length === 0) {
      log.success('✓ 所有数据库函数都已安装');
    } else {
      log.warning(`⚠ 缺失 ${functionsResult.missing.length} 个数据库函数`);
      functionsResult.missing.forEach((func) => {
        console.log(`  - ${func}`);
      });
    }
  } catch (error) {
    log.warning(`检查数据库函数时出错: ${error.message}`);
  }

  // 生成报告
  log.header('📊 诊断报告摘要');

  const totalMissing = Object.values(results.tables).reduce(
    (sum, table) => sum + (table.missing?.length || 0),
    0
  );

  if (totalMissing === 0 && results.functions.missing?.length === 0) {
    log.success('✓ 数据库结构完整，没有发现不匹配问题！');
    log.info('如果仍然有功能异常，请检查:');
    console.log('  1. 浏览器控制台是否有 JavaScript 错误');
    console.log('  2. Network 标签页的 API 响应是否正常');
    console.log('  3. 数据是否正确回填（points 可能存在但为 NULL）');
  } else {
    log.warning(`发现 ${totalMissing} 个缺失字段和 ${results.functions.missing?.length || 0} 个缺失函数`);

    console.log('');
    console.log('🔧 建议的修复步骤:');
    console.log('');

    if (totalMissing > 0) {
      console.log('1. 执行数据库修复脚本:');
      console.log(`   ${colors.cyan}safe_fix_frontend_backend_mismatch.sql${colors.reset}`);
      console.log('');
      console.log('   在 Supabase SQL Editor 中:');
      console.log('   - 访问 https://app.supabase.com');
      console.log('   - 选择您的项目');
      console.log('   - 打开 SQL Editor');
      console.log('   - 复制并执行修复脚本');
      console.log('');
    }

    if (results.functions.missing?.length > 0) {
      console.log('2. 安装缺失的数据库函数:');
      console.log(`   ${colors.cyan}fix_frontend_backend_mismatch.sql${colors.reset}`);
      console.log('   (该脚本包含数据库函数定义)');
      console.log('');
    }

    console.log('3. 验证修复结果:');
    console.log(`   ${colors.cyan}verify_database_state.sql${colors.reset}`);
    console.log('');

    console.log('4. 清除浏览器缓存并刷新页面');
    console.log('');

    console.log('📖 详细文档:');
    console.log(`   ${colors.cyan}FRONTEND_BACKEND_MISMATCH_DIAGNOSIS.md${colors.reset}`);
    console.log(`   ${colors.cyan}FRONTEND_BACKEND_FIX_GUIDE.md${colors.reset}`);
  }

  // 保存详细报告
  const reportPath = './database_diagnosis_report.json';
  require('fs').writeFileSync(reportPath, JSON.stringify(results, null, 2));
  log.info(`详细报告已保存到: ${reportPath}`);
}

/**
 * 检查单个表的结构
 */
async function checkTableStructure(supabase, tableName, requiredFields) {
  // 使用 RPC 调用来检查列（如果可以的话）
  // 或者通过查询来推断

  const present = [];
  const missing = [];

  // 尝试查询表来检查列是否存在
  try {
    const { data, error } = await supabase
      .from(tableName)
      .select('*')
      .limit(1);

    if (error) {
      if (error.code === '42P01') {
        // 表不存在
        return { exists: false, present: [], missing: requiredFields };
      }
      throw error;
    }

    // 表存在，检查列
    if (data && data.length > 0) {
      const sampleRow = data[0];
      requiredFields.forEach((field) => {
        if (field in sampleRow) {
          present.push(field);
        } else {
          missing.push(field);
        }
      });
    } else {
      // 表为空，无法通过数据推断列
      // 返回所有字段为可能缺失
      return {
        exists: true,
        present: [],
        missing: requiredFields,
        note: '表为空，无法准确检查列',
      };
    }

    return { exists: true, present, missing };
  } catch (error) {
    throw error;
  }
}

/**
 * 检查数据库函数
 */
async function checkFunctions(supabase) {
  const present = [];
  const missing = [];

  // 尝试调用每个函数来检查是否存在
  for (const funcName of REQUIRED_FUNCTIONS) {
    try {
      const { error } = await supabase.rpc(funcName);

      if (error && error.message.includes('function')) {
        missing.push(funcName);
      } else {
        present.push(funcName);
      }
    } catch (e) {
      // 函数不存在
      missing.push(funcName);
    }
  }

  return { present, missing };
}

// 运行诊断
diagnose().catch((error) => {
  log.error(`诊断失败: ${error.message}`);
  console.error(error);
  process.exit(1);
});
