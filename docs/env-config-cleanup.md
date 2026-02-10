# 环境变量配置优化说明

## ✅ 已完成的优化

### 问题
`.env` 文件中存在冗余变量：
```bash
SUPABASE_URL=https://mkdxdlsjisqazermmfoe.supabase.co
VITE_SUPABASE_URL=https://mkdxdlsjisqazermmfoe.supabase.co  # 冗余！
```

### 解决方案
统一使用 `SUPABASE_URL`，通过 Vite 配置自动暴露给客户端。

## 📋 修改的文件

### 1. `.env` - 移除冗余变量
```bash
# 之前
SUPABASE_URL=https://mkdxdlsjisqazermmfoe.supabase.co
VITE_SUPABASE_URL=https://mkdxdlsjisqazermmfoe.supabase.co  ❌

# 现在
SUPABASE_URL=https://mkdxdlsjisqazermmfoe.supabase.co  ✅
```

### 2. `vite.config.ts` - 添加客户端暴露
```typescript
// 新增：自动将 SUPABASE_URL 暴露为 VITE_SUPABASE_URL
'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(env.SUPABASE_URL),
'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(env.SUPABASE_ANON_KEY),
```

## 🔧 工作原理

**Vite 环境变量规则**：
- `VITE_*` 变量 → 自动暴露到浏览器（客户端）
- 非 `VITE_*` 变量 → 仅在服务端（Node.js）

**现在的配置**：
1. `.env` 中只定义 `SUPABASE_URL`（服务端和客户端共享）
2. `vite.config.ts` 将其转换为 `import.meta.env.VITE_SUPABASE_URL`（客户端访问）
3. Node.js 脚本使用 `process.env.SUPABASE_URL`（服务端访问）

## 📊 使用场景

| 场景 | 使用的变量 | 访问方式 |
|------|----------|----------|
| **服务端脚本** | `SUPABASE_URL` | `process.env.SUPABASE_URL` |
| **浏览器前端** | `SUPABASE_URL` → `VITE_SUPABASE_URL` | `import.meta.env.VITE_SUPABASE_URL` |
| **数据库脚本** | `SUPABASE_URL` | `process.env.SUPABASE_URL` |
| **发音服务** | `SUPABASE_URL` → `VITE_SUPABASE_URL` | `import.meta.env.VITE_SUPABASE_URL` |

## ✅ 验证结果

- ✅ 构建成功（806ms）
- ✅ 无冗余变量
- ✅ 单一配置源
- ✅ 服务端和客户端都能正常访问

## 🎯 优势

1. **单一配置源** - 只需维护一个变量
2. **减少错误** - 避免两个变量不同步
3. **更简洁** - .env 文件更清晰
4. **向后兼容** - 代码无需修改

---

**现在配置更简洁、更安全、更易维护！** 🎉
