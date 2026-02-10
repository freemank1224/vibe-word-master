# 项目清理归档

## 归档时间
2025-02-10

## 归档原因
建立正式的数据库版本控制系统后，以下文件已被新的系统替代：

## 归档的文件列表

### 📄 诊断文档（9个）
- `DIAGNOSIS_README.md` - 诊断文档
- `FRONTEND_BACKEND_FIX_GUIDE.md` - 前后端修复指南
- `FRONTEND_BACKEND_MISMATCH_DIAGNOSIS.md` - 不匹配诊断
- `QUICK_FIX_GUIDE.md` - 快速修复指南
- `SESSION_FIX_REPORT.md` - 会话修复报告
- `STATS_DEDUPLICATION_FIX.md` - 统计去重修复
- `WORD_LIBRARY_DIAGNOSIS.md` - 词库诊断
- `DATABASE_FIX_SUMMARY.md` - 数据库修复总结
- `docs/library_deduplication_update.md` - 词库去重更新

### 🔧 数据库脚本（19个）
- `update_schema.sql` - Schema 更新
- `update_schema_achievements.sql` - 成就系统更新
- `update_schema_image_gen_status.sql` - 图片生成状态
- `update_schema_language.sql` - 语言字段
- `update_schema_library_tag.sql` - 词库标签
- `update_schema_soft_delete.sql` - 软删除
- `update_schema_tags.sql` - 标签系统
- `update_schema_timezone_dynamic.sql` - 动态时区
- `update_schema_v2_scores.sql` - V2 分数
- `update_schema_v2_stats.sql` - V2 统计
- `fix_delete_permissions.sql` - 删除权限修复
- `fix_duplicate_words.sql` - 重复词修复
- `fix_duplicates.sql` - 去重修复
- `fix_frontend_backend_mismatch.sql` - 前后端不匹配修复
- `fix_stats_accuracy_and_date.sql` - 统计准确性和日期
- `fix_stats_deduplication.sql` - 统计去重
- `safe_fix_frontend_backend_mismatch.sql` - 安全修复
- `URGENT_fix_daily_stats.sql` - 紧急统计修复
- `check_table_structure.sql` - 表结构检查
- `diagnose_stats_mismatch.sql` - 统计不匹配诊断
- `verify_database_state.sql` - 数据库状态验证

### 🛠️ 诊断脚本（1个）
- `diagnose_mismatch.sh` - 不匹配诊断脚本

## 新的替代系统

所有这些文件已被以下系统替代：

### 📁 数据库版本控制系统
- **位置**: `database/`
- **核心文件**:
  - `database/snapshot/20250210_baseline_schema.sql` - 完整数据库快照
  - `database/migrations/` - 迁移文件目录
  - `database/DATABASE_VERSION_CONTROL.md` - 完整指南
  - `database/QUICKSTART.md` - 快速入门

### 🛠️ 新的工具脚本
- **位置**: `scripts/db/`
- **脚本**:
  - `verify-frontend-backend-alignment.sh` - 前后端一致性检查
  - `list-migrations.sh` - 列出迁移
  - `verify-schema.sh` - 验证 schema

## 保留的文件

以下文件仍然保留在项目根目录：
- `README.md` - 项目主要文档
- `.env` / `.env.example` - 环境变量
- `.gitignore` - Git 忽略规则
- `package.json` / `package-lock.json` - NPM 配置
- `tsconfig.json` - TypeScript 配置
- `vite.config.ts` - Vite 配置
- `index.html` - HTML 入口
- `test-gemini.ts` - 测试文件

## 为什么归档而不是删除？

这些文件记录了项目的历史演进过程，包括：
- 遇到的问题和解决方案
- 数据库 schema 的演进历程
- 调试和修复经验

归档而不是删除，保留了这些有价值的历史信息，同时保持项目根目录的整洁。

## 如何使用归档？

如果需要查看历史修复记录或参考以前的解决方案：
1. 进入 `archive/legacy_docs_and_scripts/` 目录
2. 查看相关的文档或脚本
3. 参考 `CLEANUP_SUMMARY.md` 了解每个文件的用途

## 注意事项

⚠️ **归档的文件不应再使用**，因为：
1. 它们已被新的数据库版本控制系统替代
2. 其中一些脚本可能已过时，不适用于当前数据库结构
3. 新系统提供了更好的组织和管理方式

如需修改数据库，请使用：
```bash
# 创建新的迁移文件
cp database/migrations/template.sql database/migrations/YYYYMMDD_description.sql
```
