# Library-Based Session Organization Update

## 概述

本次更新为Session添加了Library标签功能，使得在UI上可以清晰地标注每个Session所属的词库。同时简化了去重逻辑，允许用户在不同Session中添加相同的单词。

## 主要改动

### 1. 数据库Schema更新

**文件**: `update_schema_library_tag.sql`

- 为`sessions`表添加了`library_tag`字段，用于标识Session所属的词库
- 默认值为`'Custom'`（用户自定义词库）
- 为该字段创建了索引以提高查询性能

**执行方式**: 在Supabase SQL Editor中执行此SQL文件

### 2. TypeScript类型定义

**文件**: `types.ts`

- `InputSession`接口新增`libraryTag?: string`字段

### 3. 数据服务层改动

**文件**: `services/dataService.ts`

#### 3.1 `fetchUserData`
- 从数据库获取session时，映射`library_tag`字段到`libraryTag`属性

#### 3.2 `saveSessionData`
- 新增`libraryTag`参数（默认值为`'Custom'`）
- 创建session时保存library_tag
- 新单词使用对应的library tag

#### 3.3 `modifySession`
- 获取session的`library_tag`以确定使用哪个tag
- 添加的新单词使用session的library tag

#### 3.4 `importDictionaryWords`
- 为每个词库创建独立的session（而非共享一个Library-Imports session）
- 每个词库session的`library_tag`为对应的词库名称（如'CET-4'、'CET-6'等）
- 维持原有的去重和tag管理逻辑（用于词库导入）

### 4. UI改动

**文件**: `App.tsx`

#### 4.1 SessionMatrix组件
- Session卡片现在显示Library标签（仅当不是'Custom'时显示）
- 标签样式：蓝色小徽章，英文大写，位于日期下方
- 响应式设计：在高密度模式下自动调整大小

#### 4.2 InputMode组件（去重逻辑）
- **简化为Session内去重**：只检查当前Session的单词列表中是否有重复
- 允许用户在不同Session中添加相同的单词
- 每个Session独立管理其单词列表

### 5. 去重逻辑说明

#### 手动添加单词（Custom Session）
- **Session内去重**：同一个Session中不允许重复的单词
- **跨Session允许**：可以在不同Session中添加相同的单词
- 每个单词记录是独立的，拥有自己的session_id

#### 词库导入（如CET-4, CET-6）
- **全局去重**：使用tags数组标记单词所属的词库
- 如果单词已存在，添加新的library tag到tags数组
- 如果单词不存在，创建新记录并设置tags

## 核心设计理念

### 数据结构

**Words表**：
- `id`: 单词记录的唯一ID
- `text`: 单词文本
- `session_id`: 所属Session（外键）
- `tags`: 词库标签数组（用于词库分类）
- 其他字段...

**关键点**：
1. 每个单词记录属于一个Session（通过session_id）
2. tags数组用于标记词库分类（Custom, CET-4, CET-6等）
3. 相同的text可以存在于多个Session中（不同的记录）

### Session vs Library

- **Session**: 用户的学习单元，可以包含任意单词
- **Library**: 词库分类标签，通过tags标记

### 示例场景

#### 场景1：手动添加单词
1. 用户创建Session A，添加单词"elaborate"
2. 用户创建Session B，可以再次添加单词"elaborate"
3. 这是两条不同的记录，session_id不同，但都有tags=['Custom']

#### 场景2：词库导入
1. 用户导入CET-6词库，单词"elaborate"被导入，tags=['CET-6']
2. 用户导入TOEFL词库，其中也包含"elaborate"
3. 系统检测到单词已存在，为其添加tag，tags=['CET-6', 'TOEFL']
4. 这是同一条记录，使用tags实现多词库归属

## 使用说明

### 1. 执行数据库迁移

```sql
-- 在Supabase SQL Editor中执行
\i update_schema_library_tag.sql
```

### 2. 重启应用

```bash
npm run dev
```

### 3. 功能验证

1. **查看Session标签**:
   - Dashboard中的Session卡片应显示所属词库标签
   - Custom库的Session不显示标签
   - 导入的词库Session显示对应的库名（如"CET-4"）

2. **测试Session内去重**:
   - 在一个Session中添加单词"test"
   - 再次尝试添加"test"
   - 应该提示"already in this session"

3. **测试跨Session允许**:
   - 在Session A中添加单词"test"
   - 创建Session B，再次添加单词"test"
   - 应该允许添加（不报重复错误）

## 注意事项

1. **数据迁移**: 现有的sessions会自动设置`library_tag = 'Custom'`
2. **向后兼容**: 如果`library_tag`为null，系统会默认使用'Custom'
3. **性能**: 添加了索引，不会影响查询性能
4. **词库导入**: 每个词库的session会保持独立，便于管理和统计

## 技术细节

### Session更新逻辑

```typescript
// modifySession函数
export const modifySession = async (
  userId: string,
  sessionId: string,
  addedWords: { text: string, imageBase64?: string }[],
  removedWordIds: string[],
  updatedWords: { id: string, text: string, imageBase64?: string }[] = []
) => {
    // 获取session的library_tag
    const { data: sessionInfo } = await supabase
        .from('sessions')
        .select('library_tag')
        .eq('id', sessionId)
        .single();
    
    const libraryTag = sessionInfo?.library_tag || 'Custom';
    
    // 删除removed words
    if (removedWordIds.length > 0) {
        await supabase
            .from('words')
            .update({ deleted: true })
            .in('id', removedWordIds);
    }

    // 添加新单词
    if (addedWords.length > 0) {
        const wordsPayload = addedWords.map(w => ({
            user_id: userId,
            session_id: sessionId,
            text: w.text,
            image_path: imagePath,
            tags: [libraryTag]  // 使用session的library_tag
        }));
        
        await supabase.from('words').insert(wordsPayload);
    }
    
    // 更新session word count
    // ...
};
```

### 前端去重检查

```typescript
// 只在当前session的单词列表中检查
if (currentWords.some(w => w.text.toLowerCase() === trimmed.toLowerCase())) {
    setErrorMsg(`"${trimmed}" is already in this session.`);
    return;
}
```

## 设计权衡

### 为什么允许跨Session重复？

1. **灵活性**: 用户可能想在不同的学习阶段重复学习某些单词
2. **独立性**: 每个Session是独立的学习单元
3. **简单性**: 避免复杂的全局去重逻辑

### 为什么词库导入使用全局去重？

1. **避免冗余**: 词库通常很大，不应重复存储
2. **多词库支持**: 一个单词可能同时出现在多个词库中
3. **tags机制**: 使用tags数组可以优雅地表示多词库归属
