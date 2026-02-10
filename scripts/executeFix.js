#!/usr/bin/env node

/**
 * 数据库修复脚本执行器
 *
 * 自动连接到 Supabase 并执行修复脚本
 *
 * 使用方法:
 *   node scripts/executeFix.js
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

const log = {
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  warning: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  info: (msg) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  header: (msg) => {
    console.log('');
    console.log(`${colors.blue}${colors.bold}════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.blue}${colors.bold}${msg}${colors.reset}`);
    console.log(`${colors.blue}${colors.bold}════════════════════════════════════════${colors.reset}`);
  },
  step: (num, total, msg) => {
    console.log(`\n${colors.cyan}[${num}/${total}]${colors.reset} ${msg}`);
  },
};

// 读取 SQL 文件内容
function readSQLFile(filename) {
  const filePath = path.join(__dirname, '..', filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`SQL 文件不存在: ${filename}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

// 检查列是否存在
async function checkColumnExists(supabase, tableName, columnName) {
  try {
    // 尝试查询该列
    const { data, error } = await supabase
      .from(tableName)
      .select(columnName)
      .limit(1);

    if (error) {
      // 如果错误消息包含 "column"，说明列不存在
      if (error.message && error.message.includes('column')) {
        return false;
      }
      // 其他错误可能是权限问题等
      return null; // 未知
    }

    return true;
  } catch (e) {
    return false;
  }
}

// 执行单个 ALTER TABLE 语句
async function addColumn(supabase, tableName, columnDef) {
  // 由于 Supabase JS 客户端不支持 DDL 操作，
  // 我们需要通过 RPC 调用或者直接提示用户手动执行

  log.warning(`需要手动添加列: ${columnDef}`);
  return null;
}

// 主执行函数
async function executeFix() {
  log.header('🚀 数据库修复脚本执行器');

  // 检查环境变量
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    log.error('缺少环境变量 SUPABASE_URL 或 SUPABASE_ANON_KEY');
    log.info('请确保 .env 文件已正确配置');
    process.exit(1);
  }

  log.success('环境变量配置正确');
  log.info(`连接到: ${process.env.SUPABASE_URL}`);

  // 创建 Supabase 客户端
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  const totalSteps = 4;
  let currentStep = 0;

  // Step 1: 检查表是否存在
  currentStep++;
  log.step(currentStep, totalSteps, '检查数据库表结构');

  const tables = ['daily_stats', 'words', 'sessions'];
  const tableStatus = {};

  for (const tableName of tables) {
    try {
      const { data, error } = await supabase
        .from(tableName)
        .select('*')
        .limit(1);

      if (error) {
        tableStatus[tableName] = { exists: false, error: error.message };
        log.error(`  ✗ ${tableName}: ${error.message}`);
      } else {
        tableStatus[tableName] = { exists: true };
        log.success(`  ✓ ${tableName}: 存在`);
      }
    } catch (e) {
      tableStatus[tableName] = { exists: false, error: e.message };
      log.error(`  ✗ ${tableName}: ${e.message}`);
    }
  }

  // Step 2: 检查关键字段
  currentStep++;
  log.step(currentStep, totalSteps, '检查关键字段');

  const criticalChecks = [
    { table: 'daily_stats', column: 'points', name: 'daily_stats.points' },
    { table: 'words', column: 'last_tested', name: 'words.last_tested' },
    { table: 'words', column: 'error_count', name: 'words.error_count' },
    { table: 'words', column: 'deleted', name: 'words.deleted' },
    { table: 'sessions', column: 'deleted', name: 'sessions.deleted' },
    { table: 'sessions', column: 'library_tag', name: 'sessions.library_tag' },
  ];

  const missingColumns = [];

  for (const check of criticalChecks) {
    if (!tableStatus[check.table]?.exists) {
      log.warning(`  ⊘ ${check.name}: 表不存在`);
      continue;
    }

    const exists = await checkColumnExists(supabase, check.table, check.column);

    if (exists === true) {
      log.success(`  ✓ ${check.name}: 存在`);
    } else if (exists === false) {
      log.error(`  ✗ ${check.name}: 缺失`);
      missingColumns.push(check);
    } else {
      log.warning(`  ? ${check.name}: 无法检查（可能是权限问题）`);
    }
  }

  // Step 3: 生成修复 SQL
  currentStep++;
  log.step(currentStep, totalSteps, '生成修复脚本');

  if (missingColumns.length === 0) {
    log.success('所有关键字段都已存在！');
  } else {
    log.warning(`发现 ${missingColumns.length} 个缺失字段`);

    console.log('\n' + colors.cyan + '════════════════════════════════════════' + colors.reset);
    console.log(colors.cyan + colors.bold + '请在 Supabase SQL Editor 中执行以下 SQL:' + colors.reset);
    console.log(colors.cyan + '════════════════════════════════════════' + colors.reset);
    console.log('');

    // 生成修复 SQL
    console.log('-- ===============================================');
    console.log('-- 自动生成的修复脚本');
    console.log('-- ===============================================\n');

    for (const check of missingColumns) {
      const columnType = getColumnDefinition(check.table, check.column);
      console.log(`-- 添加 ${check.name}`);
      console.log(`DO $$`);
      console.log(`BEGIN`);
      console.log(`    IF NOT EXISTS (`);
      console.log(`        SELECT 1 FROM information_schema.columns`);
      console.log(`        WHERE table_name = '${check.table}'`);
      console.log(`        AND column_name = '${check.column}'`);
      console.log(`    ) THEN`);
      console.log(`        ALTER TABLE public.${check.table} ADD COLUMN ${columnType};`);
      console.log(`        RAISE NOTICE 'Added ${check.column} to ${check.table}';`);
      console.log(`    END IF;`);
      console.log(`END $$;\n`);
    }

    console.log('-- 刷新 Schema 缓存');
    console.log('NOTIFY pgrst, \'reload schema\';');
    console.log('');
  }

  // Step 4: 提供下一步指引
  currentStep++;
  log.step(currentStep, totalSteps, '完成');

  console.log('\n' + colors.bold + '📋 下一步操作:' + colors.reset);
  console.log('');

  if (missingColumns.length > 0) {
    console.log('1. 复制上面生成的 SQL 语句');
    console.log('2. 打开 Supabase SQL Editor:');
    console.log(`   ${colors.cyan}https://app.supabase.com${colors.reset}`);
    console.log('3. 选择您的项目');
    console.log('4. 点击左侧 "SQL Editor"');
    console.log('5. 粘贴并执行 SQL 语句');
    console.log('6. 检查底部的 NOTICE 输出确认成功');
    console.log('');
    console.log('或者执行完整的修复脚本:');
    console.log(`   ${colors.cyan}safe_fix_frontend_backend_mismatch.sql${colors.reset}`);
    console.log('');
  }

  console.log('7. 清除浏览器缓存并刷新页面:');
  console.log(`   ${colors.yellow}Mac: Cmd+Shift+R${colors.reset}`);
  console.log(`   ${colors.yellow}Windows: Ctrl+Shift+R${colors.reset}`);
  console.log('');

  console.log('8. 验证修复效果:');
  console.log('   - 日历颜色应该多样化（不是全绿）');
  console.log('   - 悬停日期应显示 Activity Log');
  console.log('   - 测试模式应该正常工作');
  console.log('');
}

// 获取列定义
function getColumnDefinition(tableName, columnName) {
  const definitions = {
    'daily_stats': {
      'points': 'points NUMERIC DEFAULT 0',
    },
    'words': {
      'last_tested': 'last_tested TIMESTAMPTZ DEFAULT NULL',
      'error_count': 'error_count INTEGER DEFAULT 0',
      'best_time_ms': 'best_time_ms INTEGER DEFAULT NULL',
      'score': 'score NUMERIC DEFAULT NULL',
      'phonetic': 'phonetic TEXT DEFAULT NULL',
      'audio_url': 'audio_url TEXT DEFAULT NULL',
      'definition_en': 'definition_en TEXT DEFAULT NULL',
      'definition_cn': 'definition_cn TEXT DEFAULT NULL',
      'language': 'language TEXT DEFAULT \'en\'',
      'deleted': 'deleted BOOLEAN DEFAULT false',
      'deleted_at': 'deleted_at TIMESTAMPTZ DEFAULT NULL',
      'tags': 'tags TEXT[] DEFAULT ARRAY[\'Custom\']',
    },
    'sessions': {
      'deleted': 'deleted BOOLEAN DEFAULT false',
      'deleted_at': 'deleted_at TIMESTAMPTZ DEFAULT NULL',
      'library_tag': 'library_tag TEXT DEFAULT \'Custom\'',
    },
  };

  return definitions[tableName]?.[columnName] || `${columnName} TEXT`;
}

// 运行
executeFix().catch((error) => {
  log.error(`执行失败: ${error.message}`);
  console.error(error);
  process.exit(1);
});
