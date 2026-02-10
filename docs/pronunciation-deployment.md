# 部署指南：解决生产环境 CORS 问题

## 🚨 问题：Vercel 部署后音频无法播放

部署到 Vercel 后，有道词典等 API 可能因为 **CORS（跨域）** 问题无法访问。

**原因**：
```
✅ 本地: localhost → dict.youdao.com (浏览器允许)
❌ 生产: vercel.app → dict.youdao.com (CORS 阻止)
```

## ✅ 解决方案：Supabase Edge Function 代理

使用你自己的 Supabase Edge Function 作为代理，绕过 CORS 限制。

### 架构对比

**❌ 直接访问（可能失败）**
```
Vercel → 有道API (被CORS阻止)
```

**✅ 代理访问（可靠）**
```
Vercel → Supabase Edge Function → 有道API (成功)
```

---

## 📋 部署步骤

### 1. 确保 Supabase 项目已创建

如果你还没有 Supabase 项目：

```bash
# 安装 Supabase CLI
npm install -g supabase

# 登录
supabase login

# 链接项目
supabase link --project-ref YOUR_PROJECT_ID
```

### 2. 部署 Edge Function

```bash
# 进入项目目录
cd /Users/softmaple/Documents/vibe-word-master

# 部署发音代理函数
supabase functions deploy pronunciation
```

**预期输出**：
```
✅ Finished deploying function.
   Endpoint: https://YOUR_PROJECT.supabase.co/functions/v1/pronunciation
```

### 3. 验证部署

在浏览器中访问：
```
https://YOUR_PROJECT.supabase.co/functions/v1/pronunciation?word=hello
```

应该听到 "hello" 的发音。

### 4. 配置环境变量（Vercel）

在 Vercel 项目设置中添加环境变量：

```
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
```

或在本地 `.env` 文件中：
```bash
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
```

### 5. 重新部署到 Vercel

```bash
npm run build
vercel --prod
```

---

## 🧪 测试生产环境

部署后，在浏览器控制台查看日志：

### ✅ 成功日志
```
✅ Pronunciation service initialized with Supabase proxy support
📡 Proxy URL: https://YOUR_PROJECT.supabase.co/functions/v1/pronunciation
🌐 Available pronunciation sources:
   0. Supabase Proxy
   1. Youdao Dictionary (CN)
   2. iCiba Dictionary (CN)
   ...

🔊 Trying source: Supabase Proxy for "hello"
🌐 URL: https://YOUR_PROJECT.supabase.co/functions/v1/pronunciation?word=hello&source=youdao&lang=en
✅ Success using: Supabase Proxy
```

### ❌ 失败日志
```
⚠️ Supabase URL not found, skipping proxy
🔊 Trying source: Youdao Dictionary (CN) for "hello"
❌ Audio error for "hello": DOMException: The element has no supported sources
```

---

## 📊 发音源优先级（更新后）

| 优先级 | API | 类型 | 本地 | Vercel |
|-------|-----|------|------|--------|
| 0️⃣ | **Supabase Proxy** | 代理 | ✅ | ✅ **推荐** |
| 1️⃣ | 有道词典（直连） | 直接 | ✅ | ❌ CORS |
| 2️⃣ | 金山词霸（直连） | 直接 | ✅ | ❌ CORS |
| 3️⃣ | 海词（直连） | 直接 | ✅ | ❌ CORS |
| 999 | 浏览器TTS | 兜底 | ✅ | ✅ |

---

## 🛠️ Edge Function 代码

代理函数已创建在：
```
supabase/functions/pronunciation/index.ts
```

**功能**：
- ✅ 接收前端请求
- ✅ 转发到有道词典API
- ✅ 返回音频数据并设置 CORS 头
- ✅ 缓存24小时提升性能

**支持的源**：
- `youdao` - 有道词典（默认）
- `iciba` - 金山词霸（美式）
- `iciba-uk` - 金山词霸（英式）
- `dictcn` - 海词词典

---

## 🔧 高级配置

### 自定义代理URL

如果你使用其他代理服务，可以修改代码：

```typescript
// services/pronunciationService.ts
const customProxySource: PronunciationSource = {
  name: 'Custom Proxy',
  priority: 0,
  getAudioUrl: async (word: string, lang: string = 'en') => {
    return `https://your-proxy.com/pronounce?word=${word}&lang=${lang}`;
  }
};
```

### 添加更多词典源

编辑 `supabase/functions/pronunciation/index.ts`：

```typescript
const PRONUNCIATION_SOURCES = {
  youdao: (word: string, type: '1' | '2' = '2') =>
    `https://dict.youdao.com/dictvoice?type=${type}&audio=${word}`,

  // 添加新源
  yourdict: (word: string) =>
    `https://your-dict.com/audio/${word}.mp3`,
};
```

---

## 💡 费用说明

**Supabase Edge Functions 免费额度**：
- ✅ 500,000 MB 内存/月
- ✅ 50GB 出站流量/月

对于单词发音应用，**完全免费**足够使用。

---

## 📝 故障排除

### 问题1：部署失败

```bash
# 检查 Supabase CLI 版本
supabase --version

# 更新到最新版本
npm update -g supabase
```

### 问题2：函数返回 404

**原因**：函数未正确部署

**解决**：
```bash
# 查看已部署的函数
supabase functions list

# 重新部署
supabase functions deploy pronunciation
```

### 问题3：音频播放失败

**检查**：
1. 环境变量是否设置：`VITE_SUPABASE_URL`
2. Edge Function 是否可访问
3. 浏览器控制台错误日志

### 问题4：本地正常，Vercel 失败

**原因**：环境变量未同步到 Vercel

**解决**：
```bash
# 在 Vercel 项目设置中添加
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co

# 或通过 CLI 设置
vercel env add VITE_SUPABASE_URL production
```

---

## ✅ 部署清单

- [ ] Supabase 项目已创建
- [ ] Edge Function 已部署
- [ ] 环境变量已配置（本地 + Vercel）
- [ ] 本地测试通过
- [ ] Vercel 重新部署
- [ ] 生产环境测试通过

---

**完成这些步骤后，你的应用在 Vercel 上将完美播放单词发音！** 🎉
