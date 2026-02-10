# 🎯 Vercel 部署发音功能完整指南

## ⚡ 快速回答

### Q: Vercel 上能否正常使用发音服务？
**A: ✅ 可以，但需要配置环境变量！**

### Q: Vercel 上需要设置环境变量吗？
**A: ✅ 是的，必须在 Vercel Dashboard 中手动配置！**

---

## 📋 关键点

### 1. 本地 vs Vercel 环境变量

| 环境 | 配置方式 | 变量名 | 发音功能 |
|------|---------|--------|---------|
| **本地开发** | `.env` 文件 | `SUPABASE_URL` | ✅ 正常 |
| **Vercel** | Dashboard 手动配置 | `VITE_SUPABASE_URL` | ⚠️ 需要配置 |

### 2. 为什么 Vercel 需要单独配置？

**原因**：
1. ❌ Vercel **不会**自动读取 `.env` 文件
2. ✅ Vercel 需要在 **Dashboard** 中手动配置
3. 📦 构建时，Vite 会将 `VITE_*` 变量打包到客户端代码
4. 🌐 浏览器只能访问 `VITE_*` 前缀的变量

---

## 🔧 Vercel 配置步骤（5分钟）

### 步骤 1：打开 Vercel Dashboard

1. 访问 https://vercel.com
2. 选择你的项目（vocabulary-vibe）
3. 点击 **Settings** 标签
4. 选择 **Environment Variables**

### 步骤 2：添加环境变量

点击 **Add New**，添加以下变量：

#### 变量 1: VITE_SUPABASE_URL
```
名称: VITE_SUPABASE_URL
值: https://mkdxdlsjisqazermmfoe.supabase.co
环境: ✅ Production  ✅ Preview  ✅ Development
```

#### 变量 2: VITE_SUPABASE_ANON_KEY
```
名称: VITE_SUPABASE_ANON_KEY
值: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rZHhkbHNqaXNxYXplcm1tZm9lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4ODA4NjgsImV4cCI6MjA4MzQ1Njg2OH0.7WKjv6OSGurKwDQIwpGX_w3fN-RxK94Qzy9qPKD3g4k
环境: ✅ Production  ✅ Preview  ✅ Development
```

### 步骤 3：重新部署

配置完成后，有两种方式重新部署：

**方式 1: CLI**
```bash
vercel --prod
```

**方式 2: Dashboard**
1. 进入 **Deployments** 标签
2. 点击最新部署右侧的 **...** 菜单
3. 选择 **Redeploy**

---

## ✅ 验证部署

部署完成后，验证发音功能：

### 方法 1: 浏览器控制台

打开你的 Vercel 应用，按 F12 打开控制台：

```javascript
// 检查环境变量
console.log('Supabase URL:', import.meta.env.VITE_SUPABASE_URL);

// 应该输出:
// Supabase URL: https://mkdxdlsjisqazermmfoe.supabase.co
```

### 方法 2: 测试发音

在应用中测试一个单词发音，然后在控制台查看日志：

**✅ 成功日志**：
```
✅ Pronunciation service initialized with Supabase proxy support
📡 Proxy URL: https://mkdxdlsjisqazermmfoe.supabase.co/functions/v1/pronunciation
🔊 Trying source: Supabase Proxy for "hello"
✅ Success using: Supabase Proxy
```

**❌ 失败日志**（环境变量未配置）：
```
⚠️ Supabase URL not found, skipping proxy
❌ Trying source: Youdao Dictionary (CN)
❌ Audio error: DOMException: The element has no supported sources
```

---

## 🛠️ 快速诊断

### 运行环境检查脚本

```bash
node scripts/check-vercel-env.cjs
```

这会检查：
- ✅ 本地 `.env` 文件
- ✅ Vercel CLI 安装
- ✅ Vercel 登录状态
- ⚠️ 提醒配置 Vercel 环境变量

---

## 📊 配置对比

### ❌ 错误配置（发音功能失败）

```bash
# .env 文件
SUPABASE_URL=https://xxx.supabase.co

# Vercel Dashboard
(空)
```

**结果**：Vercel 无法访问 Supabase，发音降级到浏览器 TTS

### ✅ 正确配置（发音功能正常）

```bash
# .env 文件
SUPABASE_URL=https://xxx.supabase.co

# Vercel Dashboard
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=xxx
```

**结果**：Vercel 使用 Supabase 代理，发音功能完美

---

## 🎯 完整检查清单

部署前必做：

- [ ] ✅ 本地 `.env` 文件已配置
- [ ] ✅ 本地测试发音功能正常
- [ ] ⏳ **Vercel Dashboard 已添加 `VITE_SUPABASE_URL`**
- [ ] ⏳ **Vercel Dashboard 已添加 `VITE_SUPABASE_ANON_KEY`**
- [ ] ⏳ 选择了所有环境（Production, Preview, Development）
- [ ] ⏳ 重新部署应用
- [ ] ⏳ Vercel 生产环境测试发音功能

---

## 💡 常见问题

### Q1: 配置后还是不工作？

**解决**：
1. 清除浏览器缓存（Ctrl+Shift+R）
2. 确认变量名以 `VITE_` 开头（必须大写）
3. 确认重新部署了应用
4. 检查控制台错误日志

### Q2: 必须配置两个变量吗？

**答**：
- `VITE_SUPABASE_URL` - ✅ 必须（发音功能需要）
- `VITE_SUPABASE_ANON_KEY` - 推荐（其他数据库操作需要）

### Q3: 为什么本地不用 `VITE_` 前缀？

**答**：因为 `vite.config.ts` 自动转换了：
```typescript
'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(env.SUPABASE_URL)
```

但 Vercel 构建时不会自动转换，所以需要显式配置 `VITE_*` 变量。

---

## 📚 相关文档

- **[docs/vercel-env-setup.md](vercel-env-setup.md)** - Vercel 环境变量详细指南
- **[docs/pronunciation-deployment.md](pronunciation-deployment.md)** - Edge Function 部署指南
- **[scripts/check-vercel-env.cjs](../scripts/check-vercel-env.cjs)** - 环境检查脚本

---

## 🚀 快速开始

**1. 运行检查脚本**：
```bash
node scripts/check-vercel-env.cjs
```

**2. 配置 Vercel 环境变量**（5分钟）

**3. 重新部署**：
```bash
vercel --prod
```

**4. 测试发音功能**

**完成！** 🎉
