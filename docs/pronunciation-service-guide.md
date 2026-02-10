# 发音服务升级说明

## 🎯 更新概述

已将单词发音引擎升级为**中国境内可访问**的多源真人发音服务，解决以下问题：
- ✅ 所有API均在中国境内可直接访问
- ✅ 真人发音替代机械TTS
- ✅ 多源自动降级，确保高可用性
- ✅ 智能缓存，提升响应速度

## 📊 发音源配置（按优先级）

| 优先级 | API | 类型 | 特点 | 状态 |
|-------|-----|------|------|------|
| 1️⃣ | **有道词典** | 真人发音 | 中国最可靠，免费 | 🟢 推荐 |
| 2️⃣ | **金山词霸** | 真人发音 | 中国备选源 | 🟢 推荐 |
| 3️⃣ | **海词词典** | 真人发音 | 中国可访问 | 🟢 可用 |
| 4️⃣ | **教育资源** | 真人发音 | 备用源 | 🟡 试用 |
| 5️⃣ | **Vocabulary.com** | 真人发音 | 国际源 | 🟡 可能受限 |
| 6️⃣ | **浏览器TTS** | 系统语音 | 兜底方案 | ⚪ 最后手段 |

## 🚀 使用方法

### 方法1：在应用中测试
```bash
npm run dev
```
启动应用后，在测试模式下听单词发音即可。

### 方法2：使用可视化测试页面
在浏览器中打开：
```
public/test-pronunciation-cn.html
```
或访问：
```
http://localhost:5173/test-pronunciation-cn.html
```

### 方法3：在浏览器控制台测试
```javascript
// 测试单个单词
playWordPronunciation("hello", "en").then(r => console.log(r))

// 测试多个单词
const words = ["hello", "world", "beautiful"];
for (const w of words) {
  await playWordPronunciation(w);
  await new Promise(r => setTimeout(r, 2000));
}
```

## 🔍 调试日志

发音服务会在浏览器控制台输出详细日志：

```
🔊 Trying source: Youdao Dictionary (CN) for "hello"
🌐 URL: https://dict.youdao.com/dictvoice?type=2&audio=hello
🆕 Creating new audio for "hello"
▶️ Playing audio for "hello"
✅ Playback completed for "hello"
✅ Success using: Youdao Dictionary (CN)
```

## 📦 技术细节

### 文件结构
```
services/
  ├── pronunciationService.ts  # 核心发音服务（已更新）
  └── dictionaryService.ts     # 词典服务（已集成）

components/
  └── TestModeV2.tsx           # 测试模式（已更新清理逻辑）

public/
  └── test-pronunciation-cn.html  # 测试页面（新建）
```

### 关键特性
1. **智能降级**：优先使用有道，失败自动尝试下一个
2. **音频缓存**：已播放的单词会缓存，避免重复请求
3. **CORS处理**：所有API均支持跨域访问
4. **错误恢复**：网络错误自动重试下一个源

## ⚙️ 高级配置

### 指定发音源
```javascript
// 强制使用某个音源
await playWordPronunciation("hello", "en", "Youdao Dictionary (CN)")
```

### 英式/美式发音
```javascript
// 美式发音（默认）
await playWordPronunciation("schedule", "en")

// 英式发音
await playWordPronunciation("schedule", "en-GB")
```

### 预加载音频
```javascript
// 预加载单词（可选优化）
import { preloadAudio } from './services/pronunciationService'
await preloadAudio("vocabulary")
```

## 🐛 故障排除

### 问题1：所有发音都使用浏览器TTS
**原因**：网络问题或API不可用
**解决**：
1. 检查网络连接
2. 查看控制台日志确认哪个源失败
3. 在中国大陆应优先使用有道/词霸

### 问题2：发音质量不佳
**原因**：降级到浏览器TTS
**解决**：
1. 检查是否在外网环境（可能访问受限）
2. 尝试手动访问有道API验证可用性
3. 考虑使用VPN访问国际源

### 问题3：音频加载慢
**原因**：网络延迟或首次加载
**解决**：
- 系统会自动缓存，第二次播放会很快
- 可考虑预加载常用单词

## 📈 性能优化

### 已实现的优化
- ✅ 音频文件缓存
- ✅ 并发请求控制
- ✅ 自动清理过期缓存
- ✅ 智能降级策略

### 预期性能指标
- **首次播放**：< 2秒（取决于网络）
- **缓存命中**：< 100ms
- **降级速度**：每个源最多等待3秒

## 🔗 API参考

### 主函数
```typescript
playWordPronunciation(
  word: string,              // 单词
  lang: string = 'en',       // 语言：en/en-GB
  preferredSource?: string   // 指定音源（可选）
): Promise<{ success: boolean; sourceUsed: string }>
```

### 辅助函数
```typescript
stopCurrentAudio()          // 停止当前播放
clearAudioCache()           // 清空缓存
getAvailableSources()       // 获取所有可用源
preloadAudio(word, lang)    // 预加载音频
```

## 📞 反馈

如果遇到问题或有改进建议，请：
1. 在浏览器控制台查看详细日志
2. 测试 `test-pronunciation-cn.html` 页面
3. 提供控制台日志以便诊断

---

**更新日期**：2025-02-11
**版本**：v2.0 (China-Accessible)
