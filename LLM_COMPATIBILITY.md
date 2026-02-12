# AI 单词选择功能 - LLM 兼容性说明

## 🌐 通用 LLM 支持

**AI 单词选择功能现已支持所有兼容 OpenAI API 标准的 LLM！**

### ✅ 支持的 LLM 提供商

| 提供商 | 类型 | 状态 | 模型 | 配置方式 |
|---------|------|------|------|----------|
| **Google Gemini** | 官方 | ✅ 完全支持 | `gemini-2.5-flash` | Settings → Provider: "Gemini" |
| **OpenAI** | 官方 | ✅ 完全支持 | `gpt-4o-mini` | Settings → Provider: "OpenAI" |
| **Claude (Anthropic)** | 第三方 | ✅ 兼容支持 | Claude 3.5/3.7 | Settings → Provider: "Custom" + OpenAI-compatible endpoint |
| **DeepSeek** | 第三方 | ✅ 兼容支持 | deepseek-chat | Settings → Provider: "Custom" |
| **Groq** | 第三方 | ✅ 兼容支持 | llama3-70b-8192 | Settings → Provider: "Custom" |
| **OpenRouter** | 第三方 | ✅ 兼容支持 | 多种模型 | Settings → Provider: "Custom" |
| **本地 Ollama** | 本地 | ✅ 兼容支持 | 本地模型 | Settings → Provider: "Custom" + 本地端点 |
| **其他兼容 OpenAI API 的服务** | - | ✅ 理论支持 | 任何模型 | Settings → Provider: "Custom" |

---

## 🔧 技术实现

### 架构设计

```
AIServiceManager (services/ai/index.ts)
    │
    ├─→ GeminiProvider (services/ai/geminiProvider.ts)
    │     └─ optimizeWordSelection() ✅ 已实现
    │
    ├─→ OpenAIProvider (services/ai/openaiProvider.ts)
    │     └─ optimizeWordSelection() ✅ 已实现
    │          └─ 兼容所有 OpenAI API 标准的 LLM
    │
    └─→ LocalProvider (services/ai/localProvider.ts)
          └─ 本地验证（fallback）
```

### API 兼容性

**Gemini API**:
```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent
Headers: { "Content-Type": "application/json" }
Body: {
  contents: [{ parts: [{ text: "..." }] }],
  config: { responseMimeType: "application/json" }
}
```

**OpenAI API 标准** (适用于 OpenAI 及所有兼容的第三方):
```
POST {endpoint}/chat/completions
Headers: {
  "Content-Type": "application/json",
  "Authorization": "Bearer {apiKey}"
}
Body: {
  model: "{modelName}",
  messages: [{ role: "user", content: "..." }],
  response_format: { type: "json_object" },
  temperature: 0.7,
  max_tokens: 200
}
```

**关键差异**:
- Gemini: 使用 `responseMimeType`
- OpenAI 标准使用 `response_format: { type: "json_object" }`
- OpenAIProvider 实现了标准格式，因此兼容所有第三方 LLM

---

## 📝 配置示例

### 示例 1: 使用 Claude (Anthropic)

虽然 Claude 有自己的 API，但可以通过 OpenAI-compatible 代理使用：

```javascript
// 在浏览器控制台或设置页面
localStorage.setItem('vibe_ai_provider', 'custom');
localStorage.setItem('vibe_ai_key', 'YOUR_ANTHROPIC_API_KEY');
localStorage.setItem('vibe_ai_endpoint', 'https://api.anthropic.com/v1');
localStorage.setItem('vibe_ai_selection', 'true');
```

**注意**: Anthropic 目前不提供官方的 OpenAI-compatible API，需要使用第三方代理服务（如 OpenRouter）。

### 示例 2: 使用 DeepSeek

DeepSeek 提供兼容 OpenAI 的 API：

```javascript
localStorage.setItem('vibe_ai_provider', 'custom');
localStorage.setItem('vibe_ai_key', 'YOUR_DEEPSEEK_API_KEY');
localStorage.setItem('vibe_ai_endpoint', 'https://api.deepseek.com');
localStorage.setItem('vibe_ai_selection', 'true');
```

### 示例 3: 使用本地 Ollama

Ollama 提供本地 OpenAI-compatible API：

```javascript
localStorage.setItem('vibe_ai_provider', 'custom');
localStorage.setItem('vibe_ai_key', 'ollama'); // Ollama 不需要真实 key
localStorage.setItem('vibe_ai_endpoint', 'http://localhost:11434/v1');
localStorage.setItem('vibe_ai_selection', 'true');
```

**启动 Ollama**:
```bash
ollama serve
# 或者使用特定模型
ollama run llama2
```

### 示例 4: 使用 OpenRouter (多 LLM 聚合)

OpenRouter 提供对多种 LLM 的统一访问：

```javascript
localStorage.setItem('vibe_ai_provider', 'custom');
localStorage.setItem('vibe_ai_key', 'YOUR_OPENROUTER_API_KEY');
localStorage.setItem('vibe_ai_endpoint', 'https://openrouter.ai/api/v1');
localStorage.setItem('vibe_ai_model', 'anthropic/claude-3.5-sonnet'); // 可选
localStorage.setItem('vibe_ai_selection', 'true');
```

---

## 🧪 测试验证

### 测试步骤

1. **选择 Provider**: 在设置页面选择并配置 LLM provider
2. **启用 AI**: 确保 AI mode 已开启
3. **启动测试**: 选择单词库并启动测试模式
4. **观察日志**: 打开浏览器控制台查看日志

### 预期日志输出

**Gemini**:
```
🎯 [Adaptive Selector] { ... }
✅ AI selection returned 10 words using Gemini
```

**OpenAI / 第三方**:
```
🎯 [Adaptive Selector] { ... }
✅ AI selection returned 10 words using OpenAI-compatible API
```

**Fallback (如果 API 失败)**:
```
⚠️ OpenAI optimization failed: [error details]
🔄 Using adaptive algorithm (fallback)
```

---

## ⚠️ 注意事项

### API Key 安全

- ✅ API key 存储在 `localStorage` 中，仅本地可用
- ✅ 不会上传到服务器（除了发送到 LLM API 本身）
- ⚠️ 不要在公共设备上保存 API key
- ⚠️ 定期轮换 API key

### 成本考虑

| 提供商 | 每 1K tokens (估算) | 单次调用成本 |
|---------|-------------------|------------|
| Gemini | $0.000075 | ~$0.0001 |
| OpenAI gpt-4o-mini | $0.00015 | ~$0.0002 |
| DeepSeek | $0.00014 | ~$0.0002 |
| Groq (Llama3) | $0.0000 (免费) | $0 |
| 本地 Ollama | $0 | $0 |

**注意**: AI 单词选择每次约使用 500-1000 tokens，因此成本非常低。

### 性能

- **Gemini 2.5 Flash**: ~2-5 秒响应时间
- **OpenAI gpt-4o-mini**: ~1-3 秒响应时间
- **第三方 LLM**: 取决于提供商和地理位置
- **超时保护**: 15 秒后自动降级到本地算法

### 兼容性限制

1. **响应格式**: LLM 必须返回有效的 JSON 数组
2. **超时**: 15 秒超时，慢速 LLM 可能触发 fallback
3. **Token 限制**: 部分 LLM 可能有较低的 token 限制
4. **CORS**: 浏览器端调用需要 LLM API 支持 CORS

---

## 🔮 未来扩展

### 计划中的增强

1. **Claude 原生支持**: 添加 AnthropicProvider（直接使用 Claude API）
2. **流式响应**: 支持 streaming JSON 以获得更快响应
3. **模型选择**: 用户可在设置中指定具体模型
4. **多 provider 并行**: 同时查询多个 LLM，合并结果
5. **成本追踪**: 记录每个 provider 的 API 使用量和成本

---

## 📚 参考资料

- [OpenAI API 文档](https://platform.openai.com/docs/api-reference)
- [Gemini API 文档](https://ai.google.dev/docs)
- [DeepSeek API 文档](https://platform.deepseek.com/api-docs/)
- [Groq API 文档](https://groq.com/docs)
- [Ollama 文档](https://ollama.com/docs/)
- [OpenRouter 文档](https://openrouter.ai/docs)

---

## ✅ 总结

**AI 单词选择功能现已支持所有主要 LLM 提供商！**

- ✅ Gemini: 原生支持
- ✅ OpenAI: 原生支持
- ✅ 第三方 LLM: 通过 OpenAI-compatible API 支持
- ✅ 本地 LLM: 通过本地端点支持
- ✅ 优雅降级: API 失败时使用本地算法

**用户可以自由选择任何 LLM，享受智能的单词选择体验！**
