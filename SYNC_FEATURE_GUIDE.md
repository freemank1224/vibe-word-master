# 本地缓存 + 云端同步功能实现指南

## 📋 功能概述

为解决中国境内用户 Supabase 连接不稳定的问题，实现**离线优先**的本地缓存 + 云端同步功能。

### 核心特性

1. ✅ **本地备份** - 保存失败时自动存储到 localStorage
2. ☁️ **同步状态** - 每个 Session 卡片显示 Cloud 图标
3. 🔄 **自动重试** - 30分钟自动尝试同步
4. 👆 **手动触发** - 点击 Cloud 图标立即同步
5. ⚠️ **冲突解决** - 智能检测 + 用户选择

---

## 🎨 UI 状态设计

### Cloud 图标状态

```typescript
const SYNC_ICONS = {
  synced: {
    icon: 'cloud_done',
    color: 'text-electric-green',
    tooltip: '✅ 已同步到云端',
    animation: ''
  },
  pending: {
    icon: 'cloud_off',
    color: 'text-yellow-500',
    tooltip: '⚠️ 未同步，等待网络连接',
    animation: ''
  },
  syncing: {
    icon: 'cloud_sync',
    color: 'text-electric-blue',
    tooltip: '🔄 正在同步...',
    animation: 'animate-spin'
  },
  failed: {
    icon: 'cloud_error',
    color: 'text-red-500',
    tooltip: '❌ 同步失败，点击重试',
    animation: ''
  }
}
```

### Dashboard Session 卡片修改

在每个 Session 卡片的右上角添加 Cloud 图标按钮：

```tsx
{/* Full List View - Session 卡片 */}
<div className="bg-light-charcoal p-4 rounded-xl border flex justify-between items-center">
  {/* 左侧：复选框 + 信息 */}
  <div className="flex items-center gap-3">
    <input type="checkbox" ... />
    <div onClick={() => onStartEdit(s.id)} className="cursor-pointer">
      <p className="text-xs font-mono text-text-dark mb-1">
        {new Date(s.timestamp).toLocaleDateString()}
      </p>
      <p className="font-headline text-2xl text-white">
        {s.wordCount} WORDS
      </p>
    </div>
  </div>

  {/* 右侧：Cloud 图标 + 编辑/删除按钮 */}
  <div className="flex gap-2 items-center">
    {/* ☁️ Cloud 同步按钮 */}
    <button
      onClick={(e) => {
        e.stopPropagation();
        handleManualSync(s.id);
      }}
      className={`p-2 rounded-lg transition-all ${
        syncStatus === 'synced'
          ? 'bg-electric-green/10 text-electric-green hover:bg-electric-green/20'
          : syncStatus === 'pending'
          ? 'bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20'
          : syncStatus === 'syncing'
          ? 'bg-electric-blue/10 text-electric-blue'
          : 'bg-red-500/10 text-red-500 hover:bg-red-500/20'
      }`}
      title={SYNC_ICONS[syncStatus].tooltip}
    >
      <span
        className={`material-symbols-outlined text-lg ${
          syncStatus === 'syncing' ? 'animate-spin' : ''
        }`}
      >
        {SYNC_ICONS[syncStatus].icon}
      </span>
    </button>

    <button ...>Edit</button>
    <button ...>Delete</button>
  </div>
</div>
```

---

## 🔧 冲突解决策略

### 决策矩阵

| 场景 | 云端状态 | 本地状态 | 自动操作 |
|------|---------|---------|---------|
| 1️⃣ | 不存在 | 存在 | 直接上传 ✅ |
| 2️⃣ | 存在 | 更新 + 单词多 | 覆盖云端 📤 |
| 3️⃣ | 更新 + 单词多 | 存在 | 拉取云端 📥 |
| 4️⃣ | 存在 | 存在（无法判断） | **用户选择** ⚠️ |

### 冲突解决对话框

```tsx
{/* 冲突解决 Modal */}
{conflictModal && (
  <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-6">
    <div className="bg-light-charcoal border-2 border-yellow-500 rounded-3xl p-8 max-w-2xl w-full shadow-[0_0_50px_rgba(234,179,8,0.3)]">
      <div className="flex items-center gap-3 mb-6">
        <span className="material-symbols-outlined text-5xl text-yellow-500">warning</span>
        <h3 className="text-3xl font-headline text-white">SYNC CONFLICT</h3>
      </div>

      <p className="text-text-light mb-8">
        检到云端和本地有不同版本的该 Session。请选择要保留的版本：
      </p>

      <div className="grid md:grid-cols-2 gap-6 mb-8">
        {/* 云端版本 */}
        <div
          onClick={() => handleResolveConflict('cloud')}
          className={`cursor-pointer p-6 rounded-2xl border-2 transition-all ${
            conflictChoice === 'cloud'
              ? 'border-electric-blue bg-electric-blue/10'
              : 'border-mid-charcoal hover:border-electric-blue/50'
          }`}
        >
          <div className="flex items-center gap-2 mb-4">
            <span className="material-symbols-outlined text-electric-blue">cloud</span>
            <h4 className="text-lg font-headline text-white">云端版本</h4>
          </div>
          <div className="space-y-2 text-sm">
            <p className="text-text-light">
              <span className="text-text-dark">时间：</span>
              {new Date(conflictModal.cloud.timestamp).toLocaleString()}
            </p>
            <p className="text-text-light">
              <span className="text-text-dark">单词数：</span>
              {conflictModal.cloud.wordCount} 个
            </p>
            <p className="text-text-light">
              <span className="text-text-dark">标签：</span>
              {conflictModal.cloud.libraryTag}
            </p>
          </div>
        </div>

        {/* 本地版本 */}
        <div
          onClick={() => handleResolveConflict('local')}
          className={`cursor-pointer p-6 rounded-2xl border-2 transition-all ${
            conflictChoice === 'local'
              ? 'border-electric-green bg-electric-green/10'
              : 'border-mid-charcoal hover:border-electric-green/50'
          }`}
        >
          <div className="flex items-center gap-2 mb-4">
            <span className="material-symbols-outlined text-electric-green">devices</span>
            <h4 className="text-lg font-headline text-white">本地版本</h4>
          </div>
          <div className="space-y-2 text-sm">
            <p className="text-text-light">
              <span className="text-text-dark">时间：</span>
              {new Date(conflictModal.local.timestamp).toLocaleString()}
            </p>
            <p className="text-text-light">
              <span className="text-text-dark">单词数：</span>
              {conflictModal.local.wordCount} 个
            </p>
            <p className="text-text-light">
              <span className="text-text-dark">标签：</span>
              {conflictModal.local.libraryTag}
            </p>
          </div>
        </div>
      </div>

      {/* 按钮组 */}
      <div className="flex gap-4">
        <button
          onClick={() => setConflictModal(null)}
          className="flex-1 py-4 rounded-xl bg-mid-charcoal text-text-light hover:bg-white hover:text-charcoal transition-all font-mono text-xs uppercase"
        >
          取消
        </button>
        <button
          onClick={handleConfirmResolution}
          disabled={!conflictChoice}
          className="flex-1 py-4 rounded-xl bg-electric-green text-charcoal hover:bg-white transition-all font-headline text-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          <span className="material-symbols-outlined">check_circle</span>
          使用 {conflictChoice === 'cloud' ? '云端' : '本地'} 版本
        </button>
      </div>
    </div>
  </div>
)}
```

---

## 📦 App 组件集成

### 1. 添加状态管理

```typescript
// 在 App 组件内添加
const [notification, setNotification] = useState<{
  message: string;
  type: 'success' | 'warning' | 'error';
} | null>(null);

const showNotification = (message: string, type = 'success') => {
  setNotification({ message, type });
  setTimeout(() => setNotification(null), 5000);
};

const [syncingSessionId, setSyncingSessionId] = useState<string | null>(null);
const [conflictModal, setConflictModal] = useState<{
  sessionId: string;
  cloud: InputSession;
  local: InputSession;
} | null>(null);
```

### 2. 修改 handleSaveSession

已在之前完成，核心逻辑：

```typescript
try {
  // 尝试云端保存
  await saveSessionData(...);

  // ✅ 成功 → 清除本地备份
  const backup = loadLocalBackup();
  if (backup) {
    backup.sessions = backup.sessions.filter(s => s.id !== sessionId);
    saveLocalBackup(backup);
  }
} catch (e) {
  // ❌ 失败 → 保存到本地
  saveSessionToLocal(sessionData, wordsData, 'pending');
  showNotification('⚠️ 已保存到本地，连接恢复后自动同步', 'warning');
}
```

### 3. 添加手动同步处理

```typescript
const handleManualSync = async (sessionId: string) => {
  if (!session?.user) return;

  setSyncingSessionId(sessionId);

  try {
    // 从本地备份获取数据
    const localBackup = loadLocalBackup();
    const localSession = localBackup?.sessions.find(s => s.id === sessionId);
    const localWords = localBackup?.words.filter(w => w.sessionId === sessionId);

    if (!localSession || !localWords) {
      showNotification('该 Session 未找到本地备份数据', 'error');
      return;
    }

    // 调用同步服务
    const result = await syncSessionToCloud(
      session.user.id,
      localSession,
      localWords
    );

    if (result.success) {
      if (result.action === 'uploaded') {
        // 上传成功 → 清除本地备份
        const updatedBackup = {
          ...localBackup!,
          sessions: localBackup!.sessions.filter(s => s.id !== sessionId)
        };
        saveLocalBackup(updatedBackup);

        showNotification('✅ 同步成功！', 'success');
      } else if (result.action === 'downloaded') {
        // 云端较新 → 应用云端数据
        if (result.cloudData) {
          setSessions(prev => prev.map(s =>
            s.id === sessionId ? result.cloudData!.session : s
          ));
          setWords(prev => {
            const oldIds = prev
              .filter(w => w.sessionId === sessionId)
              .map(w => w.id);
            const newWords = result.cloudData!.words.filter(
              w => !oldIds.has(w.id)
            );
            return [...prev.filter(w => !oldIds.has(w.id)), ...newWords];
          });
        }
        showNotification('📥 已应用云端最新数据', 'success');
      } else if (result.action === 'skipped') {
        showNotification('✅ 数据已同步，无需操作', 'success');
      }
    } else {
      // 冲突 → 显示对话框
      if (result.action === 'conflict' && result.conflictData) {
        setConflictModal({
          sessionId,
          cloud: result.conflictData.cloud,
          local: result.conflictData.local
        });
      } else {
        showNotification(`❌ ${result.message}`, 'error');
      }
    }
  } finally {
    setSyncingSessionId(null);
  }
};
```

### 4. 自动同步（30分钟）

```typescript
useEffect(() => {
  if (!session?.user) return;

  const interval = setInterval(async () => {
    const backup = loadLocalBackup();
    if (!backup) return;

    const pendingSessions = backup.sessions.filter(
      s => s.syncStatus === 'pending' || s.syncStatus === 'failed'
    );

    if (pendingSessions.length === 0) return;

    console.log(`[AutoSync] Found ${pendingSessions.length} pending sessions`);

    const result = await syncAllPendingSessions(session.user.id);
    console.log(
      `[AutoSync] Complete: ${result.synced} synced, ${result.failed} failed`
    );

    // 更新本地状态
    if (result.synced > 0) {
      const { sessions: cloudSessions, words: cloudWords } =
        await fetchUserData(session.user.id);
      setSessions(cloudSessions);
      setWords(cloudWords);
    }
  }, 30 * 60 * 1000); // 30分钟

  return () => clearInterval(interval);
}, [session?.user]);
```

### 5. 通知组件渲染

在 App 组件的 return 之前添加：

```tsx
{/* Notification Toast */}
{notification && (
  <div
    className={`fixed top-4 left-1/2 -translate-x-1/2 z-[200] px-6 py-4 rounded-2xl shadow-2xl border-2 flex items-center gap-3 animate-in slide-in-from-top-4 fade-in duration-300 ${
      notification.type === 'success'
        ? 'bg-electric-green/20 border-electric-green text-white'
        : notification.type === 'warning'
        ? 'bg-yellow-500/20 border-yellow-500 text-white'
        : 'bg-red-500/20 border-red-500 text-white'
    }`}
  >
    <span className="material-symbols-outlined text-2xl">
      {notification.type === 'success'
        ? 'check_circle'
        : notification.type === 'warning'
        ? 'warning'
        : 'error'}
    </span>
    <p className="font-medium">{notification.message}</p>
  </div>
)}
```

---

## 🎯 总结

### ✅ 实现步骤

1. **已完成**：
   - ✅ `syncService.ts` - 核心同步逻辑
   - ✅ 修改 `handleSaveSession` - 保存失败本地备份
   - ✅ 添加导入和状态定义

2. **待实现**（按优先级）：
   - ⏸️ 修改 Dashboard 组件添加 Cloud 图标
   - ⏸️ 添加手动同步处理函数
   - ⏸️ 实现冲突解决对话框
   - ⏸️ 添加自动同步（30分钟）
   - ⏸️ 添加通知 Toast 组件

### 🚀 测试建议

1. **离线测试**：断网后添加单词，验证本地备份
2. **同步测试**：恢复网络后手动点击 Cloud 图标
3. **冲突测试**：模拟云端和本地数据不一致
4. **自动重试**：等待 30 分钟验证自动同步

### 📝 文件清单

- ✅ `/services/syncService.ts` - 新增
- 🔄 `/App.tsx` - 部分修改
- ⏸️ `/App.tsx` - Dashboard 组件需要更新
- ⏸️ CSS 动画类（如需要）

---

## 💡 额外建议

### 存储优化
- 只在 localStorage 存储**文本数据**
- 图片通过 `imageBase64` 标记，同步时重新上传
- 定期清理已同步的旧数据

### 网络监听
```typescript
useEffect(() => {
  const handleOnline = () => {
    console.log('🌐 Network restored, syncing...');
    // 触发立即同步
  };

  const handleOffline = () => {
    console.log('📴 Network lost, switching to offline mode');
    showNotification('⚠️ 网络断开，数据将保存到本地', 'warning');
  };

  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);

  return () => {
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
  };
}, []);
```
