#!/bin/bash

# =================================================================
# 前后端数据不匹配自动诊断工具
# =================================================================
# 此脚本帮助您快速诊断和修复前后端数据库不匹配问题
#
# 使用方法:
#   1. 确保已安装 supabase CLI: npm install -g supabase
#   2. 运行: bash diagnose_mismatch.sh
# =================================================================

set -e  # 遇到错误立即退出

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 函数: 打印带颜色的消息
print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

print_header() {
    echo ""
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
}

# 检查 Supabase CLI
print_header "检查环境"

if ! command -v supabase &> /dev/null; then
    print_error "Supabase CLI 未安装"
    print_info "请运行: npm install -g supabase"
    exit 1
fi

print_success "Supabase CLI 已安装"

# 检查 .env 文件
if [ ! -f .env ]; then
    print_error ".env 文件不存在"
    exit 1
fi

print_success ".env 文件存在"

# 提取项目 ref
SUPABASE_URL=$(grep "SUPABASE_URL=" .env | cut -d'/' -f3)
if [ -z "$SUPABASE_URL" ]; then
    print_error "无法从 .env 提取 SUPABASE_URL"
    exit 1
fi

print_success "检测到 Supabase 项目: $SUPABASE_URL"

# 询问用户是否继续
print_header "开始诊断"
print_warning "此脚本将连接到您的 Supabase 数据库并检查表结构"
read -p "是否继续? (y/N) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    print_info "已取消"
    exit 0
fi

# 执行验证脚本
print_header "执行数据库验证"

if [ -f verify_database_state.sql ]; then
    print_info "正在执行 verify_database_state.sql..."

    # 使用 supabase db execute 或者提示用户手动执行
    if command -v psql &> /dev/null; then
        print_info "检测到 psql，尝试直接执行..."

        # 从 .env 提取数据库连接信息
        DB_URL=$(grep "DATABASE_URL=" .env | cut -d'=' -f2-)

        if [ -z "$DB_URL" ]; then
            print_warning "未找到 DATABASE_URL，请在 Supabase 控制台手动执行 SQL"
            print_info "脚本位置: verify_database_state.sql"
        else
            psql "$DB_URL" -f verify_database_state.sql
        fi
    else
        print_warning "未检测到 psql"
        print_info "请在 Supabase SQL Editor 中执行以下文件:"
        print_info "  1. verify_database_state.sql"
    fi
else
    print_error "verify_database_state.sql 文件不存在"
fi

# 显示诊断报告
print_header "诊断报告"

print_info "请查看以下文件了解详细诊断结果:"
echo "  - FRONTEND_BACKEND_MISMATCH_DIAGNOSIS.md"
echo "  - FRONTEND_BACKEND_FIX_GUIDE.md"

# 询问是否执行修复
print_header "修复选项"
print_warning "如果发现数据库字段缺失，请执行修复脚本"
print_info "修复脚本: safe_fix_frontend_backend_mismatch.sql"

read -p "是否查看修复脚本内容? (y/N) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    if [ -f safe_fix_frontend_backend_mismatch.sql ]; then
        less safe_fix_frontend_backend_mismatch.sql
    else
        print_error "safe_fix_frontend_backend_mismatch.sql 文件不存在"
    fi
fi

# 显示快速修复命令
print_header "快速修复命令"

cat << 'EOF'
如果您想快速修复，请在 Supabase SQL Editor 中执行:

1. 打开 https://app.supabase.com
2. 选择您的项目
3. 点击左侧 "SQL Editor"
4. 新建查询，复制以下内容:

-- 检查并添加 daily_stats.points
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'daily_stats'
        AND column_name = 'points'
    ) THEN
        ALTER TABLE public.daily_stats ADD COLUMN points NUMERIC DEFAULT 0;
        RAISE NOTICE 'Added points column';
    END IF;
END $$;

-- 回填数据
UPDATE public.daily_stats SET points = correct * 3 WHERE points = 0;

-- 刷新 Schema 缓存
NOTIFY pgrst, 'reload schema';

EOF

print_header "完成"
print_success "诊断工具执行完成"
print_info "如有问题，请查看 FRONTEND_BACKEND_MISMATCH_DIAGNOSIS.md"
