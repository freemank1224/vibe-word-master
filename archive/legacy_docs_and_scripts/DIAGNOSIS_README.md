# 前后端数据不匹配诊断工具

此目录包含了用于诊断和修复 Vibe Word Master 项目前后端数据库不匹配问题的完整工具集。

---

## 📁 文件清单

### 📄 文档

| 文件 | 说明 |
|------|------|
| [FRONTEND_BACKEND_MISMATCH_DIAGNOSIS.md](FRONTEND_BACKEND_MISMATCH_DIAGNOSIS.md) | 📋 完整的诊断报告，包含所有不匹配字段分析 |
| [FRONTEND_BACKEND_FIX_GUIDE.md](FRONTEND_BACKEND_FIX_GUIDE.md) | 📖 修复指南，包含详细的修复步骤 |
| [DIAGNOSIS_README.md](DIAGNOSIS_README.md) | 📚 本文件，工具使用说明 |

### 🔧 SQL 脚本

| 文件 | 说明 | 优先级 |
|------|------|--------|
| [verify_database_state.sql](verify_database_state.sql) | 🔍 验证数据库当前状态 | ⭐⭐⭐ |
| [safe_fix_frontend_backend_mismatch.sql](safe_fix_frontend_backend_mismatch.sql) | 🛠️ **安全修复脚本**（推荐使用） | ⭐⭐⭐ |
| [fix_frontend_backend_mismatch.sql](fix_frontend_backend_mismatch.sql) | ⚡ 完整修复脚本（包含回填） | ⭐⭐ |
| [check_table_structure.sql](check_table_structure.sql) | 📊 表结构检查脚本 | ⭐ |

### 🤖 自动化工具

| 文件 | 说明 | 使用方法 |
|------|------|----------|
| [diagnose_mismatch.sh](diagnose_mismatch.sh) | 🔧 Bash 诊断工具 | `bash diagnose_mismatch.sh` |
| [scripts/diagnoseDatabase.js](scripts/diagnoseDatabase.js) | 🟨 Node.js 诊断工具 | `node scripts/diagnoseDatabase.js` |

---

## 🚀 快速开始

### 方案 1: 使用自动诊断工具（推荐）

#### 使用 Node.js 工具

```bash
# 1. 安装依赖（如果还没有）
npm install

# 2. 运行诊断工具
node scripts/diagnoseDatabase.js
```

#### 使用 Bash 工具

```bash
# 1. 添加执行权限
chmod +x diagnose_mismatch.sh

# 2. 运行诊断工具
bash diagnose_mismatch.sh
```

### 方案 2: 手动执行 SQL 脚本

1. **访问 Supabase 控制台**
   - 打开 https://app.supabase.com
   - 选择您的项目
   - 点击左侧 "SQL Editor"

2. **执行验证脚本**
   - 新建查询
   - 复制 `verify_database_state.sql` 的全部内容
   - 执行并查看结果

3. **执行修复脚本**
   - 新建查询
   - 复制 `safe_fix_frontend_backend_mismatch.sql` 的全部内容
   - 执行并检查 NOTICE 输出

4. **验证修复结果**
   - 重新执行 `verify_database_state.sql`
   - 确认所有字段都已添加

---

## 📊 主要问题概览

### 🔴 高优先级问题

| 问题 | 影响 | 位置 |
|------|------|------|
| `daily_stats.points` 字段缺失 | 日历颜色全部显示绿色 | [App.tsx:121](App.tsx#L121) |
| `words.last_tested` 字段缺失 | 无法记录最后测试时间 | [dataService.ts:142](services/dataService.ts#L142) |
| `words.error_count` 字段缺失 | 错误计数功能失效 | [dataService.ts:456](services/dataService.ts#L456) |

### 🟡 中优先级问题

| 问题 | 影响 | 位置 |
|------|------|------|
| `words.best_time_ms` 字段缺失 | 最佳时间记录失效 | [dataService.ts:459](services/dataService.ts#L459) |
| `sessions.deleted` 字段缺失 | 软删除功能异常 | [dataService.ts:628](services/dataService.ts#L628) |
| `sessions.library_tag` 字段缺失 | 库功能无法使用 | [dataService.ts:101](services/dataService.ts#L101) |

### 🟢 低优先级问题（可选字段）

| 问题 | 影响 | 位置 |
|------|------|------|
| `words.phonetic` 字段缺失 | 音标功能失效 | [dataService.ts:472](services/dataService.ts#L472) |
| `words.audio_url` 字段缺失 | 音频播放失效 | [dataService.ts:473](services/dataService.ts#L473) |
| `words.definition_en/cn` 字段缺失 | 释义功能失效 | [dataService.ts:475-476](services/dataService.ts#L475-L476) |

---

## 🛠️ 修复步骤详解

### Step 1: 备份数据库（可选但推荐）

```sql
-- 在 Supabase 控制台的项目设置中
-- 找到 "Database" → "Backups"
-- 点击 "Create Backup" 创建备份
```

### Step 2: 验证当前状态

```sql
-- 在 Supabase SQL Editor 中执行 verify_database_state.sql
-- 保存输出结果以供对比
```

### Step 3: 执行安全修复脚本

```sql
-- 在 Supabase SQL Editor 中执行 safe_fix_frontend_backend_mismatch.sql
-- 检查底部的 NOTICE 输出
-- 确认所有列都已添加
```

### Step 4: 验证修复结果

```sql
-- 重新执行 verify_database_state.sql
-- 对比修复前后的结果
-- 确认所有字段都已存在
```

### Step 5: 测试前端功能

- [ ] 日历颜色多样化（不是全绿）
- [ ] 悬停日期显示 Activity Log
- [ ] Activity Log 显示准确率
- [ ] 测试模式 V2 正常工作
- [ ] 可以删除 Session
- [ ] 库功能正常（CET-4, CET-6, TOEFL）

### Step 6: 清除浏览器缓存

```bash
# 在浏览器中按 Cmd+Shift+R (Mac) 或 Ctrl+Shift+R (Windows)
# 或打开开发者工具，右键刷新按钮选择"清空缓存并硬性重新加载"
```

---

## 🧪 验证查询

### 检查 daily_stats.points 字段

```sql
SELECT
    date,
    total,
    correct,
    points,
    CASE WHEN points IS NOT NULL THEN '✓ 存在' ELSE '✗ 缺失' END as status
FROM public.daily_stats
ORDER BY date DESC
LIMIT 10;
```

### 检查 words 表关键字段

```sql
SELECT
    COUNT(*) FILTER (WHERE last_tested IS NOT NULL) as has_last_tested,
    COUNT(*) FILTER (WHERE error_count > 0) as has_error_count,
    COUNT(*) FILTER (WHERE best_time_ms IS NOT NULL) as has_best_time,
    COUNT(*) FILTER (WHERE score IS NOT NULL) as has_score,
    COUNT(*) FILTER (WHERE deleted = true) as has_deleted,
    COUNT(*) FILTER (WHERE tags IS NOT NULL) as has_tags
FROM public.words;
```

### 检查所有表的字段

```sql
SELECT
    table_name,
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
AND table_name IN ('daily_stats', 'words', 'sessions')
AND column_name IN (
    'points', 'last_tested', 'error_count', 'best_time_ms',
    'score', 'phonetic', 'audio_url', 'definition_en',
    'definition_cn', 'language', 'deleted', 'deleted_at', 'tags', 'library_tag'
)
ORDER BY table_name, column_name;
```

---

## ❓ 常见问题

### Q1: 执行修复脚本后仍然有问题？

**A**: 可能的原因：
1. 浏览器缓存了旧数据 → 清除缓存并强制刷新
2. 数据存在但值为 NULL → 需要回填数据
3. Schema 缓存未刷新 → 等待几秒或重试

**解决方案**:
```sql
-- 强制回填 points
UPDATE public.daily_stats
SET points = CASE
    WHEN correct > 0 THEN correct * 3
    ELSE 0
END
WHERE points IS NULL OR points = 0;

-- 刷新 Schema 缓存
NOTIFY pgrst, 'reload schema';
```

### Q2: 修复脚本执行报错？

**A**: 检查错误消息：
- 如果是 "column already exists" → 可以忽略，脚本已处理
- 如果是 "permission denied" → 检查数据库权限
- 如果是 "table does not exist" → 先创建表

**解决方案**: 使用 `safe_fix_frontend_backend_mismatch.sql`，它会检查列是否存在

### Q3: 日历颜色仍然全绿？

**A**: 这是最常见的问题，通常由以下原因导致：
1. `points` 字段存在但值为 NULL
2. 前端没有正确映射 `points` 字段
3. 浏览器缓存

**解决方案**:
```sql
-- 1. 检查 points 是否存在且有值
SELECT date, total, correct, points FROM public.daily_stats ORDER BY date DESC LIMIT 5;

-- 2. 如果存在但为 NULL，回填数据
UPDATE public.daily_stats SET points = correct * 3 WHERE points IS NULL;

-- 3. 刷新缓存
NOTIFY pgrst, 'reload schema';

-- 4. 前端强制刷新
# 浏览器按 Cmd+Shift+R (Mac) 或 Ctrl+Shift+R (Windows)
```

### Q4: 无法删除 Session？

**A**: 检查 RLS 策略

**解决方案**:
```sql
-- 检查 RLS 策略
SELECT * FROM pg_policies WHERE tablename = 'sessions';

-- 确保有正确的更新策略
-- 应该有类似这样的策略：
-- POLICY "Users can update their own sessions"
-- ON sessions FOR UPDATE
-- USING (auth.uid() = user_id)
```

---

## 📞 获取帮助

如果以上方法都无法解决问题：

1. **收集诊断信息**
   ```bash
   # 运行诊断工具并保存输出
   node scripts/diagnoseDatabase.js > diagnosis_output.txt
   ```

2. **检查浏览器控制台**
   - 按 F12 打开开发者工具
   - 查看 Console 标签页的错误
   - 查看 Network 标签页的 API 响应

3. **提供以下信息**
   - `database_diagnosis_report.json`（由诊断工具生成）
   - 浏览器控制台的错误截图
   - Network 标签页的失败请求详情

---

## 📝 相关文件

### 前端代码
- [App.tsx](App.tsx) - 主应用，加载数据处
- [services/dataService.ts](services/dataService.ts) - 数据服务，所有数据库操作
- [types.ts](types.ts) - TypeScript 类型定义
- [components/CalendarView.tsx](components/CalendarView.tsx) - 日历组件

### 数据库相关
- [verify_database_state.sql](verify_database_state.sql) - 验证脚本
- [safe_fix_frontend_backend_mismatch.sql](safe_fix_frontend_backend_mismatch.sql) - 安全修复脚本
- [fix_frontend_backend_mismatch.sql](fix_frontend_backend_mismatch.sql) - 完整修复脚本

---

## 🎯 总结

### 关键要点

1. 🔴 **最严重的问题**: `daily_stats.points` 字段缺失 → 日历颜色失效
2. 🟡 **修复方案**: 执行 `safe_fix_frontend_backend_mismatch.sql`
3. 🟢 **验证方法**: 执行 `verify_database_state.sql`
4. 🔵 **测试清单**: 确保所有功能正常工作

### 推荐流程

```bash
# 1. 运行诊断工具
node scripts/diagnoseDatabase.js

# 2. 执行修复脚本
# (在 Supabase SQL Editor 中执行 safe_fix_frontend_backend_mismatch.sql)

# 3. 验证修复
node scripts/diagnoseDatabase.js

# 4. 测试前端功能
# (在浏览器中逐项测试)
```

---

**文档版本**: 1.0
**最后更新**: 2025-01-27
**作者**: Claude Code (AI Assistant)
