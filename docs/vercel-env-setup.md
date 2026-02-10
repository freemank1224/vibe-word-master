# Vercel 部署环境变量配置指南

## 🚨 重要：Vercel 需要配置环境变量！

### ✅ 答案：是的，Vercel 上需要配置环境变量

---

## 📋 需要在 Vercel 配置的环境变量

### 方法 1：直接配置 `VITE_SUPABASE_URL`（推荐）

在 Vercel 项目设置中添加：

| 变量名 | 值 | 环境 |
|--------|-----|------|
| `VITE_SUPABASE_URL` | `https://mkdxdlsjisqazermmfoe.supabase.co` | Production, Preview, Development |
| `VITE_SUPABASE_ANON_KEY` | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` | Production, Preview, Development |

### 方法 2：配置 `SUPABASE_URL` + `VITE_` 前缀（备选）

如果你想保持和本地 `.env` 一致，也可以：

| 变量名 | 值 | 环境 |
|--------|-----|------|
| `SUPABASE_URL` | `https://mkdxdlsjisqazermmfoe.supabase.co` | Production, Preview, Development |
| `VITE_SUPABASE_URL` | `https://mkdxdlsjisqazermmfoe.supabase.co` | Production, Preview, Development |
| `SUPABASE_ANON_KEY` | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` | All |
| `VITE_SUPABASE_ANON_KEY` | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` | All |

---

## 🔧 Vercel 配置步骤

### 1. 打开 Vercel 项目设置

1. 访问 https://vercel.com/your-username/your-project
2. 点击 **Settings** → **Environment Variables**

### 2. 添加环境变量

逐个添加以下变量：

**必须配置（发音功能需要）**：
```
名称: VITE_SUPABASE_URL
值: https://mkdxdlsjisqazermmfoe.supabase.co
环境: ✅ Production  ✅ Preview  ✅ Development
```

**可选但推荐**：
```
名称: VITE_SUPABASE_ANON_KEY
值: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
环境: ✅ Production  ✅ Preview  ✅ Development
```

### 3. 重新部署

配置完成后，需要重新部署：

```bash
# 方式 1: 通过 Vercel CLI
vercel --prod

# 方式 2: 通过 Vercel Dashboard
点击 "Deployments" → "Redeploy"
```

---

## 🎯 验证部署

部署后，在浏览器控制台检查：

```javascript
// 在浏览器控制台运行
console.log('Supabase URL:', import.meta.env.VITE_SUPABASE_URL);
```

**预期输出**：
```
Supabase URL: https://mkdxdlsjisqazermmfoe.supabase.co
```

然后测试发音：
```javascript
// 测试发音服务
import { playWordPronunciation } from './services/pronunciationService';
playWordPronunciation("hello").then(r => console.log(r));
```

**预期输出**：
```
✅ Pronunciation service initialized with Supabase proxy support
📡 Proxy URL: https://mkdxdlsjisqazermmfoe.supabase.co/functions/v1/pronunciation
✅ Success using: Supabase Proxy
```

---

## ⚠️ 常见问题

### Q1: 配置后还是无法使用发音？

**检查清单**：
- ✅ 确认变量名前缀是 `VITE_`（必须大写）
- ✅ 确认选择了所有环境（Production, Preview, Development）
- ✅ 确认重新部署了应用
- ✅ 清除浏览器缓存后重试

### Q2: 为什么需要 `VITE_` 前缀？

**原因**：
- Vite 只会将 `VITE_*` 前缀的变量暴露到浏览器
- 没有 `VITE_` 前缀的变量只能在服务端使用
- 发音服务运行在浏览器中，所以需要 `VITE_` 前缀

### Q3: 本地正常，Vercel 失败？

**原因**：
- 本地有 `.env` 文件
- Vercel 不会自动读取 `.env` 文件
- 必须在 Vercel Dashboard 中手动配置

### Q4: 如何验证环境变量是否生效？

**方法**：
```javascript
// 在浏览器控制台运行
console.log('所有环境变量:', {
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
  VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY ? '✅ 已配置' : '❌ 未配置'
});
```

---

## 📊 配置对比

| 环境 | 配置位置 | 发音功能 |
|------|---------|---------|
| **本地开发** | `.env` 文件 | ✅ 正常 |
| **Vercel 未配置** | 无 | ❌ 失败（降级到浏览器TTS） |
| **Vercel 已配置** | Dashboard 环境变量 | ✅ 正常 |

---

## 🚀 快速配置模板

复制以下内容到 Vercel 环境变量：

```
VITE_SUPABASE_URL=https://mkdxdlsjisqazermmfoe.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rZHhkbHNqaXNxYXplcm1tZm9lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4ODA4NjgsImV4cCI6MjA4MzQ1Njg2OH0.7WKjv6OSGurKwDQIwpGX_w3fN-RxK94Qzy9qPKD3g4k
```

---

## ✅ 部署后验证清单

- [ ] Vercel 环境变量已配置
- [ ] 重新部署完成
- [ ] 浏览器控制台显示 `Supabase proxy support`
- [ ] 测试单词发音成功
- [ ] 控制台显示 `Success using: Supabase Proxy`

---

**完成这些配置后，Vercel 部署的应用将完美使用发音服务！** 🎉
