# Baseline Schema vs 实际数据库 - 差异分析

## 🔍 发现的差异

### ❌ 不匹配的字段类型

| 表名 | 字段名 | 实际数据库 | 我的文件 | 状态 |
|------|--------|-----------|----------|------|
| words | text | VARCHAR(255) | VARCHAR | ⚠️ 不精确 |
| words | language | VARCHAR(10) | VARCHAR | ⚠️ 不精确 |
| sessions | library_tag | VARCHAR(100) | VARCHAR | ⚠️ 不精确 |
| sessions | name | VARCHAR(255) | VARCHAR | ⚠️ 不精确 |
| user_settings | timezone_name | VARCHAR(100) | VARCHAR | ⚠️ 不精确 |

### ⚠️ 可能遗漏的内容

我创建的 baseline schema 是**手动编写**的，基于我对代码的理解，可能遗漏了：
- 某些索引
- 某些约束
- 某些触发器
- 某些函数

## ✅ 解决方案

让我从实际数据库导出**真正的完整 schema**：