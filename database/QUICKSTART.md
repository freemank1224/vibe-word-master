# 数据库版本控制 - 快速入门

## 🎯 你现在的状态

你的项目现在有了一个完整的数据库版本控制系统！

```
database/
├── snapshot/
│   └── 20250210_baseline_schema.sql     # 🔒 完整数据库快照
├── migrations/
│   ├── 20250210_baseline.sql             # 📝 初始迁移
│   └── template.sql                       # 📋 迁移模板
└── DATABASE_VERSION_CONTROL.md           # 📖 完整指南

scripts/db/
├── verify-frontend-backend-alignment.sh  # 🔍 一致性检查
├── list-migrations.sh                    # 📋 列出迁移
└── verify-schema.sh                      # ✅ 验证 schema
```

## 🚀 三步上手

### 1️⃣ 提交当前状态到 Git

```bash
# 查看创建了哪些文件
git status

# 提交数据库版本控制系统
git add database/ scripts/db/
git commit -m "feat: 建立数据库版本控制系统

- 添加数据库 schema 快照 (20250210_baseline_schema.sql)
- 创建迁移模板和目录结构
- 添加前后端一致性验证脚本
- 完整的数据库版本控制指南"
```

### 2️⃣ 理解核心概念

| 概念 | 作用 | 类比 |
|------|------|------|
| **Snapshot（快照）** | 保存完整的数据库状态 | 时间机器，可以回到任意时刻 |
| **Migration（迁移）** | 记录每次数据库变更 | Git commit，每次变更都有记录 |
| **Baseline（基线）** | 当前稳定的数据库状态 | Git 的 main 分支 |

### 3️⃣ 以后如何使用

#### 当你需要修改数据库时：

```bash
# 1. 创建新的迁移文件
cp database/migrations/template.sql database/migrations/20250215_add_new_field.sql

# 2. 编辑迁移文件，添加你的 SQL
# vim database/migrations/20250215_add_new_field.sql

# 3. 本地测试（使用 Supabase Dashboard 或 psql）

# 4. 更新前端代码（types.ts 等）

# 5. 提交到 Git
git add database/migrations/20250215_add_new_field.sql types.ts
git commit -m "feat: add new field to words table"
```

#### 当你担心前后端不一致时：

```bash
# 运行一致性检查脚本
./scripts/db/verify-frontend-backend-alignment.sh
```

## ⚠️ 常见问题解决

### Q1: 我修改了数据库，但前端报错

**可能原因**: 前端代码和数据库 schema 不匹配

**解决步骤**:
```bash
# 1. 检查当前 schema
./scripts/db/verify-frontend-backend-alignment.sh

# 2. 如果缺少字段，创建迁移添加
cp database/migrations/template.sql database/migrations/20250215_fix_missing_field.sql

# 3. 应用迁移
# 方式 A: 通过 Supabase Dashboard 的 SQL Editor
# 方式 B: 使用 psql
psql $DATABASE_URL -f database/migrations/20250215_fix_missing_field.sql
```

### Q2: 我想在全新环境部署

**步骤**:
```bash
# 1. 克隆代码
git clone [your-repo]

# 2. 从基线 schema 创建数据库
psql $DATABASE_URL -f database/snapshot/20250210_baseline_schema.sql

# 3. 按顺序应用所有迁移
for migration in database/migrations/*.sql; do
    psql $DATABASE_URL -f "$migration"
done
```

### Q3: 如何回滚数据库变更？

**方式 1: 回滚 Git 代码**
```bash
git log --oneline  # 找到之前的 commit
git checkout [commit-hash]  # 回滚代码
# 然后手动回滚数据库（使用迁移文件中的 rollback 说明）
```

**方式 2: 使用 Supabase 的自动备份**
- Supabase 保留 7 天的自动备份
- Dashboard → Database → Backups → Point-in-Time Recovery

## 📊 当前数据库状态总结

根据验证脚本，你的数据库包含：

### 主要表
- ✅ **words** - 单词表（618 行）
- ✅ **sessions** - 会话表（19 行）
- ✅ **session_words** - 会话-单词关联表（175 行）
- ✅ **daily_stats** - 每日统计（21 行）
- ✅ **user_achievements** - 用户成就（11 行）
- ✅ **user_settings** - 用户设置（2 行）

### 关键字段验证
- ✅ 所有关键字段都存在于数据库中
- ✅ 前后端命名约定一致（camelCase ↔ snake_case）
- ✅ 数据类型对齐正确

### 历史表（可清理）
- ⚠️ `words_old`, `sessions_old`, `daily_stats_old_backup` 等
- 这些是旧备份表，可以考虑清理

## 🎉 你现在可以放心开发了！

有了这个系统，你不再需要担心：
- ❌ "代码和数据库不匹配怎么办？"
- ❌ "我怎么知道当前数据库是什么状态？"
- ❌ "我想回到之前的数据库版本，怎么做？"
- ❌ "在新环境部署，数据库怎么建立？"

**一切都有记录！Git commit = 代码变更 + 数据库迁移**

## 📚 更多信息

- 完整指南: [database/DATABASE_VERSION_CONTROL.md](database/DATABASE_VERSION_CONTROL.md)
- Baseline Schema: [database/snapshot/20250210_baseline_schema.sql](database/snapshot/20250210_baseline_schema.sql)
- 迁移模板: [database/migrations/template.sql](database/migrations/template.sql)

---

*创建时间: 2025-02-10*
*作者: Claude Code*
