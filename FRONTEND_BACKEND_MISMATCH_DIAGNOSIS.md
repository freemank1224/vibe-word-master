# 前后端数据不匹配诊断报告

**生成时间**: 2025-01-27
**项目**: Vibe Word Master
**问题**: 前端代码和后端数据库字段不匹配

---

## 📋 执行摘要

经过深入分析前端代码和数据库脚本，发现以下**严重不匹配问题**：

| 严重性 | 问题 | 影响 |
|--------|------|------|
| 🔴 **高** | `daily_stats.points` 字段缺失或未映射 | 日历颜色全部显示绿色 |
| 🔴 **高** | `words` 表多个 V2 字段缺失 | 测试功能异常 |
| 🟡 **中** | `sessions` 表软删除字段缺失 | 删除功能可能异常 |
| 🟡 **中** | 数据库函数未安装 | 统计同步失败 |

---

## 🔍 详细分析

### 1. daily_stats 表不匹配

#### 前端期望字段 (types.ts)
```typescript
interface DayStats {
  date: string;        // YYYY-MM-DD
  total: number;       // 总测试数
  correct: number;     // 正确数
  points?: number;     // 🔴 关键字段！用于计算准确率
}
```

#### 前端使用位置

**App.tsx:121** - 加载统计数据时
```typescript
stats.forEach((s: any) => {
    statsMap[s.date] = {
        date: s.date,
        total: s.total,
        correct: s.correct,
        points: s.points  // ⚠️ 必须映射此字段！
    };
});
```

**CalendarView.tsx:30-32** - 计算准确率
```typescript
const rate = stat.points !== undefined
  ? stat.points / (stat.total * 3)  // 使用 points 计算更准确
  : stat.correct / stat.total;       // 降级方案
```

#### 数据库应有字段
```sql
daily_stats (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES auth.users,
    date DATE NOT NULL,
    total INTEGER NOT NULL DEFAULT 0,
    correct INTEGER NOT NULL DEFAULT 0,
    points NUMERIC DEFAULT 0,        -- 🔴 可能缺失
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    UNIQUE(user_id, date)
)
```

#### ⚠️ 症状
- 日历所有日期都显示为**绿色**
- 准确率计算显示 `NaN`
- Activity Log 悬浮面板无法正常显示

---

### 2. words 表不匹配

#### 前端期望字段 (types.ts:2-23)
```typescript
interface WordEntry {
  id: string;                      // ✓ 基础字段
  text: string;                    // ✓
  timestamp: number;               // ✓ (映射 created_at)
  sessionId: string;               // ✓ (映射 session_id)
  correct: boolean;                // ✓
  tested: boolean;                 // ✓
  image_path?: string | null;      // ✓
  image_url?: string | null;       // ✓ (计算字段)

  // 🔴 V2 字段 - 可能缺失！
  error_count: number;             // 🔴
  best_time_ms: number | null;     // 🔴
  last_tested: number | null;      // 🔴
  phonetic: string | null;         // 🔴
  audio_url: string | null;        // 🔴
  language?: string | null;        // 🔴
  definition_cn: string | null;    // 🔴
  definition_en: string | null;    // 🔴
  deleted?: boolean;               // 🔴
  tags?: string[];                 // 🔴
  score?: number;                  // 🔴
}
```

#### 前端使用位置

**dataService.ts:140-149** - 映射 WordEntry
```typescript
const words: WordEntry[] = (wordsData || []).map((w: any) => ({
    id: w.id,
    text: w.text,
    timestamp: new Date(w.created_at).getTime(),
    sessionId: w.session_id,
    correct: w.correct,
    tested: w.tested,
    image_path: w.image_path,
    image_url: getImageUrl(w.image_path),
    error_count: w.error_count || 0,           // 🔴 可能 undefined
    best_time_ms: w.best_time_ms || null,      // 🔴 可能 undefined
    last_tested: w.last_tested ? new Date(w.last_tested).getTime() : null, // 🔴
    phonetic: w.phonetic || null,              // 🔴
    audio_url: w.audio_url || null,            // 🔴
    definition_cn: w.definition_cn || null,    // 🔴
    definition_en: w.definition_en || null,    // 🔴
    deleted: w.deleted || false,               // 🔴
    tags: w.tags || ['Custom']                 // 🔴
}));
```

**dataService.ts:452-454** - 更新单词状态
```typescript
const { data: currentWord } = await supabase
  .from('words')
  .select('error_count, best_time_ms')  // 🔴 依赖这些字段
  .eq('id', wordId)
  .single();
```

#### 数据库应有字段
```sql
words (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES auth.users NOT NULL,
    session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    image_path TEXT,

    -- 基础字段
    tested BOOLEAN DEFAULT false,
    correct BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),

    -- 🔴 V2 测试字段 (可能缺失)
    last_tested TIMESTAMPTZ DEFAULT NULL,
    error_count INTEGER DEFAULT 0,
    best_time_ms INTEGER DEFAULT NULL,
    score NUMERIC DEFAULT NULL,

    -- 🔴 词典字段 (可能缺失)
    phonetic TEXT DEFAULT NULL,
    audio_url TEXT DEFAULT NULL,
    definition_en TEXT DEFAULT NULL,
    definition_cn TEXT DEFAULT NULL,
    language TEXT DEFAULT 'en',

    -- 🔴 软删除和标签 (可能缺失)
    deleted BOOLEAN DEFAULT false,
    deleted_at TIMESTAMPTZ DEFAULT NULL,
    tags TEXT[] DEFAULT ARRAY['Custom'],

    updated_at TIMESTAMPTZ DEFAULT NOW()
)
```

#### ⚠️ 症状
- 测试模式 V2 功能异常
- 无法记录最佳时间
- 错误计数不更新
- 词典数据（音标、释义、音频）无法保存
- 软删除功能失效

---

### 3. sessions 表不匹配

#### 前端期望字段 (types.ts:25-32)
```typescript
interface InputSession {
  id: string;
  timestamp: number;
  wordCount: number;
  targetCount: number;
  deleted?: boolean;      // 🔴 可能缺失
  libraryTag?: string;    // 🔴 可能缺失
}
```

#### 前端使用位置

**dataService.ts:100-128** - 映射 InputSession
```typescript
const sessions: InputSession[] = (sessionsData || []).map((s: any) => {
    const libraryTag = s.library_tag || 'Custom';  // 🔴 可能 undefined
    // ... 标签计算逻辑
    return {
        id: s.id,
        timestamp: Math.max(new Date(s.created_at).getTime(), lastWordTime),
        wordCount: sessionWords.length,
        targetCount: s.target_count,
        deleted: s.deleted || false,  // 🔴 可能 undefined
        libraryTag
    };
});
```

**dataService.ts:186** - 创建会话
```typescript
.insert({
    user_id: userId,
    word_count: uniqueWordList.length,
    target_count: targetCount,
    library_tag: libraryTag  // 🔴 依赖此字段
})
```

**dataService.ts:257-263** - 获取会话标签
```typescript
const { data: sessionInfo } = await supabase
    .from('sessions')
    .select('library_tag')  // 🔴 必须存在
    .eq('id', sessionId)
    .single();

const libraryTag = sessionInfo?.library_tag || 'Custom';
```

**dataService.ts:609-613** - 软删除单词
```typescript
.update({ deleted: true })  // 🔴 words 表依赖 deleted 字段
```

**dataService.ts:627-631** - 软删除会话
```typescript
.update({ deleted: true })  // 🔴 sessions 表依赖 deleted 字段
```

#### 数据库应有字段
```sql
sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES auth.users NOT NULL,
    word_count INTEGER DEFAULT 0,
    target_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- 🔴 软删除和库标签 (可能缺失)
    deleted BOOLEAN DEFAULT false,
    deleted_at TIMESTAMPTZ DEFAULT NULL,
    library_tag TEXT DEFAULT 'Custom'
)
```

#### ⚠️ 症状
- 库功能无法使用（CET-4, CET-6, TOEFL 等）
- 会话删除功能异常
- 标签管理失效

---

### 4. 数据库函数缺失

#### 前端使用的 RPC 函数

**dataService.ts:409-418** - 同步今日统计
```typescript
const { error } = await supabase.rpc('sync_todays_stats_with_timezone', {
  p_timezone_offset_hours: offsetHours
});

// 降级到旧函数
if (error) {
   await supabase.rpc('sync_todays_stats');
}
```

#### 应有的数据库函数
```sql
-- 🔴 函数 1: 动态时区同步
CREATE OR REPLACE FUNCTION sync_todays_stats_with_timezone(
    p_timezone_offset_hours INTEGER DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
AS $$
    -- 根据 timezone 同步今日统计
$$;

-- 🔴 函数 2: 静态时区同步
CREATE OR REPLACE FUNCTION sync_todays_stats()
RETURNS void
LANGUAGE plpgsql
AS $$
    -- 使用固定时区同步
$$;

-- 🔴 函数 3: 历史数据整合
CREATE OR REPLACE FUNCTION consolidate_daily_stats()
RETURNS void
LANGUAGE plpgsql
AS $$
    -- 回填历史统计数据
$$;
```

#### ⚠️ 症状
- 每日统计不自动更新
- 历史数据无法回填
- 时区处理错误

---

## 📊 字段完整性检查清单

### daily_stats 表
| 字段 | 类型 | 前端使用 | 可能缺失 |
|------|------|----------|----------|
| id | UUID | ✓ | ❌ |
| user_id | UUID | ✓ | ❌ |
| date | DATE | ✓ | ❌ |
| total | INTEGER | ✓ | ❌ |
| correct | INTEGER | ✓ | ❌ |
| **points** | NUMERIC | 🔴 **必需** | 🔴 **可能缺失** |

### words 表
| 字段 | 类型 | 前端使用 | 可能缺失 |
|------|------|----------|----------|
| id | UUID | ✓ | ❌ |
| user_id | UUID | ✓ | ❌ |
| session_id | UUID | ✓ | ❌ |
| text | TEXT | ✓ | ❌ |
| image_path | TEXT | ✓ | ❌ |
| tested | BOOLEAN | ✓ | ❌ |
| correct | BOOLEAN | ✓ | ❌ |
| created_at | TIMESTAMPTZ | ✓ | ❌ |
| **last_tested** | TIMESTAMPTZ | 🔴 **必需** | 🔴 **可能缺失** |
| **error_count** | INTEGER | 🔴 **必需** | 🔴 **可能缺失** |
| **best_time_ms** | INTEGER | 🔴 **必需** | 🔴 **可能缺失** |
| **score** | NUMERIC | 🔴 **必需** | 🔴 **可能缺失** |
| **phonetic** | TEXT | 🔴 **词典** | 🔴 **可能缺失** |
| **audio_url** | TEXT | 🔴 **词典** | 🔴 **可能缺失** |
| **definition_en** | TEXT | 🔴 **词典** | 🔴 **可能缺失** |
| **definition_cn** | TEXT | 🔴 **词典** | 🔴 **可能缺失** |
| **language** | TEXT | 🔴 **词典** | 🔴 **可能缺失** |
| **deleted** | BOOLEAN | 🔴 **软删除** | 🔴 **可能缺失** |
| **deleted_at** | TIMESTAMPTZ | 🟡 **可选** | 🔴 **可能缺失** |
| **tags** | TEXT[] | 🔴 **库功能** | 🔴 **可能缺失** |

### sessions 表
| 字段 | 类型 | 前端使用 | 可能缺失 |
|------|------|----------|----------|
| id | UUID | ✓ | ❌ |
| user_id | UUID | ✓ | ❌ |
| word_count | INTEGER | ✓ | ❌ |
| target_count | INTEGER | ✓ | ❌ |
| created_at | TIMESTAMPTZ | ✓ | ❌ |
| **deleted** | BOOLEAN | 🔴 **必需** | 🔴 **可能缺失** |
| **deleted_at** | TIMESTAMPTZ | 🟡 **可选** | 🔴 **可能缺失** |
| **library_tag** | TEXT | 🔴 **库功能** | 🔴 **可能缺失** |

---

## 🛠️ 修复方案

### 方案 1: 使用安全修复脚本（推荐）

#### Step 1: 验证当前数据库状态

在 **Supabase SQL Editor** 中执行：

```sql
-- 复制 verify_database_state.sql 的内容
-- 执行并保存结果
```

#### Step 2: 执行安全修复脚本

在 **Supabase SQL Editor** 中执行：

```sql
-- 复制 safe_fix_frontend_backend_mismatch.sql 的内容
-- 执行并检查 NOTICE 输出
```

此脚本会：
- ✅ 检查每个列是否存在
- ✅ 只添加缺失的列（不会重复）
- ✅ 回填历史数据
- ✅ 刷新 Schema 缓存

#### Step 3: 验证修复结果

```sql
-- 检查所有必需列是否已添加
SELECT
    table_name,
    column_name,
    data_type
FROM information_schema.columns
WHERE table_name IN ('daily_stats', 'words', 'sessions')
AND column_name IN (
    'points', 'last_tested', 'error_count', 'best_time_ms',
    'score', 'phonetic', 'audio_url', 'definition_en',
    'definition_cn', 'language', 'deleted', 'deleted_at', 'tags', 'library_tag'
)
ORDER BY table_name, column_name;
```

---

### 方案 2: 手动修复（如果脚本失败）

#### 2.1 修复 daily_stats 表

```sql
-- 添加 points 列
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'daily_stats'
        AND column_name = 'points'
    ) THEN
        ALTER TABLE public.daily_stats ADD COLUMN points NUMERIC DEFAULT 0;
        RAISE NOTICE 'Added points column to daily_stats';
    END IF;
END $$;

-- 回填历史数据
UPDATE public.daily_stats
SET points = correct * 3
WHERE points = 0 AND correct > 0;
```

#### 2.2 修复 words 表

```sql
DO $$
BEGIN
    -- 添加 V2 测试字段
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'last_tested') THEN
        ALTER TABLE public.words ADD COLUMN last_tested TIMESTAMPTZ DEFAULT NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'error_count') THEN
        ALTER TABLE public.words ADD COLUMN error_count INTEGER DEFAULT 0;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'best_time_ms') THEN
        ALTER TABLE public.words ADD COLUMN best_time_ms INTEGER DEFAULT NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'score') THEN
        ALTER TABLE public.words ADD COLUMN score NUMERIC DEFAULT NULL;
    END IF;

    -- 添加词典字段
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'phonetic') THEN
        ALTER TABLE public.words ADD COLUMN phonetic TEXT DEFAULT NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'audio_url') THEN
        ALTER TABLE public.words ADD COLUMN audio_url TEXT DEFAULT NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'definition_en') THEN
        ALTER TABLE public.words ADD COLUMN definition_en TEXT DEFAULT NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'definition_cn') THEN
        ALTER TABLE public.words ADD COLUMN definition_cn TEXT DEFAULT NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'language') THEN
        ALTER TABLE public.words ADD COLUMN language TEXT DEFAULT 'en';
    END IF;

    -- 添加软删除和标签字段
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'deleted') THEN
        ALTER TABLE public.words ADD COLUMN deleted BOOLEAN DEFAULT false;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'deleted_at') THEN
        ALTER TABLE public.words ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'words' AND column_name = 'tags') THEN
        ALTER TABLE public.words ADD COLUMN tags TEXT[] DEFAULT ARRAY['Custom'];
    END IF;

    RAISE NOTICE 'All words table columns added successfully';
END $$;
```

#### 2.3 修复 sessions 表

```sql
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sessions' AND column_name = 'deleted') THEN
        ALTER TABLE public.sessions ADD COLUMN deleted BOOLEAN DEFAULT false;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sessions' AND column_name = 'deleted_at') THEN
        ALTER TABLE public.sessions ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sessions' AND column_name = 'library_tag') THEN
        ALTER TABLE public.sessions ADD COLUMN library_tag TEXT DEFAULT 'Custom';
    END IF;

    RAISE NOTICE 'All sessions table columns added successfully';
END $$;
```

---

## 🧪 验证修复效果

### 1. 浏览器控制台检查

```javascript
// 在浏览器控制台运行
console.log('Checking daily_stats data...');
// 查看加载的统计数据是否包含 points
```

### 2. 功能验证清单

- [ ] 日历颜色多样化（不是全绿）
- [ ] 悬停日期显示 Activity Log
- [ ] Activity Log 显示准确率
- [ ] 测试模式 V2 正常工作
- [ ] 可以删除 Session
- [ ] 库功能正常（CET-4, CET-6, TOEFL）

### 3. SQL 验证查询

```sql
-- 验证 points 列存在且有数据
SELECT
    date,
    total,
    correct,
    points,
    CASE WHEN points IS NOT NULL THEN '✓' ELSE '✗' END as points_exists
FROM public.daily_stats
ORDER BY date DESC
LIMIT 10;

-- 验证 words V2 字段
SELECT
    COUNT(*) FILTER (WHERE last_tested IS NOT NULL) as has_last_tested,
    COUNT(*) FILTER (WHERE error_count > 0) as has_error_count,
    COUNT(*) FILTER (WHERE best_time_ms IS NOT NULL) as has_best_time,
    COUNT(*) FILTER (WHERE score IS NOT NULL) as has_score,
    COUNT(*) FILTER (WHERE deleted = true) as has_deleted,
    COUNT(*) FILTER (WHERE tags IS NOT NULL) as has_tags
FROM public.words;
```

---

## 🚨 常见问题排查

### Q1: 日历仍然全部是绿色

**原因**: `points` 字段虽然存在但值为 NULL

**解决方案**:
```sql
-- 强制回填所有记录
UPDATE public.daily_stats
SET points = CASE
    WHEN correct > 0 THEN correct * 3
    ELSE 0
END
WHERE points IS NULL OR points = 0;
```

### Q2: Activity Log 悬浮面板不显示

**原因**: JavaScript 错误或数据格式问题

**解决方案**:
1. 打开浏览器开发者工具 (F12)
2. 查看 Console 标签页的错误信息
3. 检查 Network 标签页的 API 响应

### Q3: 无法删除 Session

**原因**: RLS 策略问题或 `deleted` 字段缺失

**解决方案**:
```sql
-- 检查 RLS 策略
SELECT *
FROM pg_policies
WHERE tablename = 'sessions';

-- 应该有类似这样的策略：
-- POLICY "Users can delete their own sessions"
-- ON sessions FOR UPDATE
-- USING (auth.uid() = user_id)
```

---

## 📝 总结

### 关键问题
1. 🔴 **最严重**: `daily_stats.points` 字段缺失 → 日历颜色失效
2. 🔴 **严重**: `words` 表 V2 字段缺失 → 测试功能异常
3. 🟡 **中等**: `sessions` 表软删除字段缺失 → 删除功能异常

### 推荐行动
1. ⭐ **立即执行**: `safe_fix_frontend_backend_mismatch.sql`
2. ⭐ **验证结果**: `verify_database_state.sql`
3. ⭐ **测试功能**: 按照验证清单逐项测试

### 文件位置
- 安全修复脚本: [safe_fix_frontend_backend_mismatch.sql](safe_fix_frontend_backend_mismatch.sql)
- 验证脚本: [verify_database_state.sql](verify_database_state.sql)
- 修复指南: [FRONTEND_BACKEND_FIX_GUIDE.md](FRONTEND_BACKEND_FIX_GUIDE.md)
- 前端代码: [App.tsx](App.tsx), [services/dataService.ts](services/dataService.ts)

---

**文档版本**: 1.0
**最后更新**: 2025-01-27
**作者**: Claude Code (AI Assistant)
