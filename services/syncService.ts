/**
 * Sync Service - 处理本地与云端的数据同步
 * 支持离线优先、冲突检测、自动重试
 */

import { supabase } from '../lib/supabaseClient';
import type { WordEntry, InputSession } from '../types';
import { createLocalBackupStore, indexedBackupKey, isOwnedLocalBackup, localBackupKey, mapCloudWord, newWordRow, requireBackupOwner, wordMetadata } from './sessionSyncModel.ts';
import type { LocalBackup, OwnedLocalBackup, SessionWithSync, SyncStatus } from './sessionSyncModel.ts';
export type { LocalBackup, SessionWithSync, SyncStatus } from './sessionSyncModel.ts';

// ============================================================================
// 类型定义
// ============================================================================

export interface SyncResult {
  success: boolean;
  action: 'uploaded' | 'downloaded' | 'skipped' | 'conflict' | 'error';
  message?: string;
  cloudData?: {
    session: InputSession;
    words: WordEntry[];
  };
  conflictData?: {
    cloud: InputSession;
    local: InputSession;
  };
}

// ============================================================================
// 常量
// ============================================================================

const INDEXED_DB_NAME = 'vocab-monster-local';
const INDEXED_DB_VERSION = 1;
const INDEXED_DB_STORE = 'backup_store';
const SYNC_THRESHOLD_TOLERANCE = 1000; // 1秒内的差异视为同时更新
const STORAGE_CLEANUP_KEYS = [
  'vibe_audio_cache',
  'vibe_audio_cache_lru',
  'vibe_audio_cache_meta',
  'vibe_word_image_gen_debug_logs_v1',
  'vibe_word_image_cache_meta_v1'
];
const STORAGE_CLEANUP_PREFIXES = [
  'vibe_avatar_b64:',
  'vibe_avatar_url:'
];

let backupDbPromise: Promise<IDBDatabase | null> | null = null;

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 生成单词内容的哈希值，用于检测内容是否真的不同
 */
const getContentHash = (words: WordEntry[]): string => {
  const sorted = [...words].sort((a, b) => a.text.localeCompare(b.text));
  return sorted.map(w => JSON.stringify({ id: w.id, ...wordMetadata(w) })).join('|');
};

const canUseIndexedDB = (): boolean => (
  typeof window !== 'undefined' && typeof indexedDB !== 'undefined'
);

const openBackupDatabase = async (): Promise<IDBDatabase | null> => {
  if (!canUseIndexedDB()) return null;

  if (!backupDbPromise) {
    backupDbPromise = new Promise((resolve) => {
      try {
        const request = indexedDB.open(INDEXED_DB_NAME, INDEXED_DB_VERSION);

        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(INDEXED_DB_STORE)) {
            db.createObjectStore(INDEXED_DB_STORE);
          }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
          console.error('[SyncService] Failed to open IndexedDB backup store:', request.error);
          resolve(null);
        };
      } catch (error) {
        console.error('[SyncService] IndexedDB unavailable:', error);
        resolve(null);
      }
    });
  }

  return backupDbPromise;
};

const loadBackupFromIndexedDB = async (userId: string): Promise<unknown> => {
  const db = await openBackupDatabase();
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(INDEXED_DB_STORE, 'readonly');
      const store = transaction.objectStore(INDEXED_DB_STORE);
      const request = store.get(indexedBackupKey(userId));

      request.onsuccess = () => {
        const result = request.result;
        if (!result) {
          resolve(null);
          return;
        }

        resolve(result);
      };

      request.onerror = () => {
        console.error('[SyncService] Failed to read IndexedDB backup:', request.error);
        resolve(null);
      };
    } catch (error) {
      console.error('[SyncService] IndexedDB read failed:', error);
      resolve(null);
    }
  });
};

const saveBackupToIndexedDB = async (backup: OwnedLocalBackup): Promise<boolean> => {
  const db = await openBackupDatabase();
  if (!db) return false;

  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(INDEXED_DB_STORE, 'readwrite');
      const store = transaction.objectStore(INDEXED_DB_STORE);

      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => {
        console.error('[SyncService] Failed to save IndexedDB backup:', transaction.error);
        resolve(false);
      };

      store.put(backup, indexedBackupKey(backup.ownerId));
    } catch (error) {
      console.error('[SyncService] IndexedDB write failed:', error);
      resolve(false);
    }
  });
};

const clearBackupFromIndexedDB = async (userId: string): Promise<void> => {
  const db = await openBackupDatabase();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(INDEXED_DB_STORE, 'readwrite');
      const store = transaction.objectStore(INDEXED_DB_STORE);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      store.delete(indexedBackupKey(userId));
    } catch {
      resolve();
    }
  });
};

const loadBackupFromLocalStorage = (userId: string): unknown => {
  const data = localStorage.getItem(localBackupKey(userId));
  // A malformed scoped backup must remain visible as an error, not be replaced.
  return data ? JSON.parse(data) : null;
};

const saveBackupToLocalStorage = (backup: OwnedLocalBackup): boolean => {
  try {
    localStorage.setItem(localBackupKey(backup.ownerId), JSON.stringify(backup));
    console.log(`[SyncService] Saved ${backup.sessions.length} sessions to localStorage backup`);
    return true;
  } catch (error) {
    console.error('[SyncService] Failed to save localStorage backup:', error);

    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      console.warn('[SyncService] LocalStorage quota exceeded, need cleanup');
      const reclaimedKeys: string[] = [];

      STORAGE_CLEANUP_KEYS.forEach(key => {
        if (localStorage.getItem(key) !== null) {
          localStorage.removeItem(key);
          reclaimedKeys.push(key);
        }
      });

      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (!key) continue;

        if (STORAGE_CLEANUP_PREFIXES.some(prefix => key.startsWith(prefix))) {
          localStorage.removeItem(key);
          reclaimedKeys.push(key);
        }
      }

      if (reclaimedKeys.length > 0) {
        console.warn('[SyncService] Cleared non-critical localStorage keys:', reclaimedKeys);

        try {
          localStorage.setItem(localBackupKey(backup.ownerId), JSON.stringify(backup));
          console.log(`[SyncService] Saved ${backup.sessions.length} sessions to localStorage backup after cleanup`);
          return true;
        } catch (retryError) {
          console.error('[SyncService] Retry save after cleanup failed:', retryError);
        }
      }
    }

    return false;
  }
};

/**
 * 比较两个 Session 的优先级
 * @returns 'local' | 'cloud' | 'equal' | 'conflict'
 */
const compareSessionPriority = (
  local: InputSession,
  cloud: InputSession,
  localWords: WordEntry[],
  cloudWords: WordEntry[]
): 'local' | 'cloud' | 'equal' | 'conflict' => {
  // 1. 删除状态优先级最高
  if (cloud.deleted && !local.deleted) return 'cloud'; // 云端已删除，不要恢复
  if (!cloud.deleted && local.deleted) return 'local'; // 本地已删除，应该同步删除

  // 2. 时间戳比较（使用服务端时间）
  const timeDiff = local.timestamp - cloud.timestamp;

  // 3. 单词数量比较
  const wordCountDiff = localWords.length - cloudWords.length;

  // 时间差很小，视为同时更新
  if (Math.abs(timeDiff) < SYNC_THRESHOLD_TOLERANCE) {
    // Finish a partially uploaded session after a network failure. Existing
    // cloud content must be an exact subset, so concurrent edits still conflict.
    if (localWords.length > cloudWords.length && cloudWords.every(cloudWord => {
      const localWord = localWords.find(word => word.id === cloudWord.id);
      return localWord && getContentHash([localWord]) === getContentHash([cloudWord]);
    })) return 'local';
    // 单词数量相同，检查内容哈希
    if (localWords.length === cloudWords.length) {
      const localHash = getContentHash(localWords);
      const cloudHash = getContentHash(cloudWords);
      if (localHash === cloudHash) return 'equal'; // 完全相同
    }

    // 同时更新但内容不同 → 冲突
    return 'conflict';
  }

  // 4. 判断优先级
  // 本地更新 AND 单词更多 → 本地优先
  if (timeDiff > 0 && wordCountDiff >= 0) {
    return 'local';
  }

  // 云端更新 AND 单词更多 → 云端优先
  if (timeDiff < 0 && wordCountDiff <= 0) {
    return 'cloud';
  }

  // 5. 无法自动判断 → 冲突
  return 'conflict';
};

// ============================================================================
// 本地存储管理
// ============================================================================

/**
 * 加载本地备份数据
 */
const localBackupStore = createLocalBackupStore({
  resolveCurrentUser: async () => {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) throw error;
    return session?.user.id ?? null;
  },
  read: async (userId) => {
    // Global V1 keys have no trustworthy owner. Preserve them without adopting them.
    const indexedBackup = await loadBackupFromIndexedDB(userId);
    const localBackup = loadBackupFromLocalStorage(userId);
    for (const candidate of [indexedBackup, localBackup]) {
      if (candidate != null && !isOwnedLocalBackup(candidate, userId)) throw new Error('本地备份归属异常，原始数据已保留。');
    }
    const indexed = indexedBackup as OwnedLocalBackup | null;
    const local = localBackup as OwnedLocalBackup | null;
    if (!indexed) return local;
    if (!local) return indexed;
    // A failed IndexedDB write may have left a newer fallback snapshot.
    return (local.savedAt ?? 0) >= (indexed.savedAt ?? 0) ? local : indexed;
  },
  write: async (userId, backup) => {
    if (await saveBackupToIndexedDB(backup)) {
      localStorage.removeItem(localBackupKey(userId));
      return true;
    }
    return saveBackupToLocalStorage(backup);
  },
  remove: async (userId) => {
    await clearBackupFromIndexedDB(userId);
    localStorage.removeItem(localBackupKey(userId));
  },
});

export const loadLocalBackup = (userId?: string): Promise<LocalBackup | null> => localBackupStore.load(userId);
export const saveLocalBackup = (backup: LocalBackup, userId?: string): Promise<boolean> => localBackupStore.save(backup, userId);
export const clearLocalBackup = (userId?: string): Promise<void> => localBackupStore.clear(userId);

export const saveSessionToLocal = (
  session: InputSession,
  words: WordEntry[],
  syncStatus: SyncStatus = 'pending',
  userId?: string,
): Promise<boolean> => localBackupStore.update(backup => {
  const existingIndex = backup.sessions.findIndex(s => s.id === session.id);
  const sessionWithSync: SessionWithSync = { ...session, syncStatus, lastSyncAttempt: Date.now(),
    localRevision: (existingIndex >= 0 ? backup.sessions[existingIndex].localRevision ?? 0 : 0) + 1 };
  if (existingIndex >= 0) backup.sessions[existingIndex] = sessionWithSync;
  else backup.sessions.push(sessionWithSync);
  for (const word of words) {
    if (word.sessionId !== session.id) throw new Error('单词不属于待保存的词库。');
    const index = backup.words.findIndex(w => w.id === word.id);
    if (index >= 0) backup.words[index] = word;
    else backup.words.push(word);
  }
  return backup;
}, userId);

export const deleteSessionFromLocal = async (sessionId: string, userId?: string): Promise<void> => {
  const saved = await localBackupStore.update(backup => ({
    ...backup,
    sessions: backup.sessions.filter(s => s.id !== sessionId),
    words: backup.words.filter(w => w.sessionId !== sessionId),
  }), userId);
  if (!saved) throw new Error('本地备份删除未保存，请重试。');
};

const assertCurrentUser = async (userId: string): Promise<void> => {
  requireBackupOwner(userId);
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (session?.user.id !== userId) throw new Error('账号已切换，已停止之前账号的同步。');
};

// ============================================================================
// 同步核心逻辑
// ============================================================================

/**
 * 同步单个 Session 到云端
 * @param userId 用户ID
 * @param localSession 本地 Session 数据
 * @param localWords 本地单词列表
 * @returns 同步结果
 */
export const syncSessionToCloud = async (
  userId: string,
  localSession: InputSession,
  localWords: WordEntry[]
): Promise<SyncResult> => {
  try {
    await assertCurrentUser(userId);
    console.log(`[SyncService] Syncing session ${localSession.id}...`);

    // 1. 检查云端是否存在
    const { data: cloudSession, error: fetchError } = await supabase
      .from('sessions')
      .select('*')
      .eq('id', localSession.id)
      .eq('user_id', userId)
      .maybeSingle(); // 使用 maybeSingle，不存在时返回 null 而不是报错

    if (fetchError) {
      console.error('[SyncService] ❌ Error fetching cloud session:', fetchError);
      console.error('[SyncService]    Error code:', fetchError.code);
      console.error('[SyncService]    Error message:', fetchError.message);
      console.error('[SyncService]    Error details:', fetchError.details);
      console.error('[SyncService]    Error hint:', fetchError.hint);
      return {
        success: false,
        action: 'error',
        message: `Failed to check cloud: ${fetchError.message}`
      };
    }

    // 场景 1: 云端不存在 → 直接上传
    if (!cloudSession) {
      console.log('[SyncService] Cloud session not found, uploading...');
      return await uploadNewSession(userId, localSession, localWords);
    }

    // 场景 2-4: 云端存在 → 需要比较
    console.log('[SyncService] Cloud session exists, comparing...');

    // 获取云端单词数据
    await assertCurrentUser(userId);
    const { data: cloudWords, error: wordsError } = await supabase
      .from('words')
      .select('*')
      .eq('session_id', localSession.id)
      .eq('user_id', userId)
      .or('deleted.eq.false,deleted.is.null');

    if (wordsError) {
      console.error('[SyncService] ❌ Error fetching cloud words:', wordsError);
      console.error('[SyncService]    Error code:', wordsError.code);
      console.error('[SyncService]    Error message:', wordsError.message);
      console.error('[SyncService]    Error details:', wordsError.details);
      console.error('[SyncService]    Error hint:', wordsError.hint);
      return {
        success: false,
        action: 'error',
        message: `Failed to fetch cloud words: ${wordsError.message}`
      };
    }

    // 比较优先级
    const cloudSessionData: InputSession = {
      id: cloudSession.id,
      timestamp: new Date(cloudSession.created_at).getTime(),
      wordCount: cloudSession.word_count,
      targetCount: cloudSession.target_count,
      deleted: cloudSession.deleted || false,
      libraryTag: cloudSession.library_tag || 'Custom'
    };

    const cloudWordsData: WordEntry[] = (cloudWords || []).map(w => {
      const imageUrl = w.image_path ? supabase.storage.from('vocab-images').getPublicUrl(w.image_path).data.publicUrl : null;
      return mapCloudWord(w, imageUrl);
    });
    const assetIds = [...new Set(cloudWordsData.map(w => w.image_asset_id).filter((id): id is string => Boolean(id)))];
    if (assetIds.length) {
      await assertCurrentUser(userId);
      const { data: assets, error: assetError } = await supabase.from('image_assets').select('id, public_url').in('id', assetIds);
      if (assetError) throw assetError;
      const urls = new Map<string, string>((assets || []).map(asset => [asset.id as string, asset.public_url as string]));
      for (const word of cloudWordsData) word.image_url = urls.get(word.image_asset_id) || word.image_url;
    }
    await assertCurrentUser(userId);

    const priority = compareSessionPriority(
      localSession,
      cloudSessionData,
      localWords,
      cloudWordsData
    );

    console.log(`[SyncService] Comparison result: ${priority}`);

    switch (priority) {
      case 'local':
        // 本地优先 → 上传覆盖云端
        return await updateCloudSession(userId, localSession, localWords);

      case 'cloud':
        // 云端优先 → 下载覆盖本地
        return {
          success: true,
          action: 'downloaded',
          message: 'Cloud data is newer, downloaded to local',
          cloudData: {
            session: cloudSessionData,
            words: cloudWordsData
          }
        };

      case 'equal':
        // 完全相同 → 无需操作
        return {
          success: true,
          action: 'skipped',
          message: 'Local and cloud are already in sync',
          cloudData: { session: cloudSessionData, words: cloudWordsData }
        };

      case 'conflict':
        // 冲突 → 返回冲突数据让用户选择
        return {
          success: false,
          action: 'conflict',
          message: 'Conflict detected, user decision required',
          conflictData: {
            cloud: cloudSessionData,
            local: localSession
          }
        };
    }

  } catch (error) {
    console.error('[SyncService] ❌ Sync failed with exception:', error);
    console.error('[SyncService]    Error name:', (error as any).name);
    console.error('[SyncService]    Error message:', (error as Error).message);
    console.error('[SyncService]    Error stack:', (error as any).stack);
    return {
      success: false,
      action: 'error',
      message: `Sync failed: ${(error as Error).message}`
    };
  }
};

/**
 * 上传新 Session（云端不存在）
 */
const syncSessionWords = async (userId: string, session: InputSession, words: WordEntry[]): Promise<void> => {
  const uniqueWords = [...new Map(words.map(word => [word.id, word])).values()];
  if (uniqueWords.some(word => word.sessionId !== session.id)) throw new Error('单词与词库归属不符，已停止同步。');
  for (let offset = 0; offset < uniqueWords.length; offset += 100) {
    const batch = uniqueWords.slice(offset, offset + 100);
    await assertCurrentUser(userId);
    // ON CONFLICT DO NOTHING is race-safe: an existing word and its FK-linked
    // learning events are never deleted, replaced, or given a stale snapshot.
    const { error: insertError } = await supabase.from('words').upsert(
      batch.map(word => newWordRow(userId, session.id, word)),
      { onConflict: 'id', ignoreDuplicates: true },
    );
    if (insertError) throw insertError;
    for (let index = 0; index < batch.length; index += 4) {
      await assertCurrentUser(userId);
      await Promise.all(batch.slice(index, index + 4).map(async word => {
        const { error } = await supabase.from('words').update(wordMetadata(word))
          .eq('id', word.id).eq('user_id', userId).eq('session_id', session.id)
          .or('deleted.eq.false,deleted.is.null');
        if (error) throw error;
      }));
    }
  }
};

const uploadNewSession = async (userId: string, session: InputSession, words: WordEntry[]): Promise<SyncResult> => {
  try {
    await assertCurrentUser(userId);
    const { error } = await supabase.from('sessions').insert({
      id: session.id, user_id: userId, word_count: session.wordCount, target_count: session.targetCount,
      library_tag: session.libraryTag, deleted: Boolean(session.deleted),
      created_at: new Date(session.timestamp).toISOString(),
    });
    if (error) {
      // Another device may have inserted this session after our earlier read.
      // Re-read its contents and run the ordinary conflict decision.
      throw error;
    }
    await syncSessionWords(userId, session, words);
    return { success: true, action: 'uploaded', message: 'Successfully uploaded to cloud' };
  } catch (error) {
    return { success: false, action: 'error', message: `Upload failed: ${error instanceof Error ? error.message : String(error)}` };
  }
};

const updateCloudSession = async (userId: string, session: InputSession, words: WordEntry[]): Promise<SyncResult> => {
  try {
    await assertCurrentUser(userId);
    const { data, error } = await supabase.from('sessions').update({
      word_count: session.wordCount, target_count: session.targetCount,
      library_tag: session.libraryTag, deleted: Boolean(session.deleted),
      created_at: new Date(session.timestamp).toISOString(),
    }).eq('id', session.id).eq('user_id', userId).or('deleted.eq.false,deleted.is.null').select('id');
    if (error) throw error;
    if (!data?.length) throw new Error('云端词库已删除或不可访问，已停止上传。');
    await syncSessionWords(userId, session, words);
    return { success: true, action: 'uploaded', message: 'Local metadata uploaded without changing learning progress' };
  } catch (error) {
    return { success: false, action: 'error', message: `Update failed: ${error instanceof Error ? error.message : String(error)}` };
  }
};

/**
 * 用户解决冲突：选择保留哪个版本
 */
export const resolveConflict = async (
  userId: string,
  sessionId: string,
  choice: 'local' | 'cloud',
  localData: { session: InputSession; words: WordEntry[] },
  cloudData: { session: InputSession; words: WordEntry[] }
): Promise<SyncResult> => {
  await assertCurrentUser(userId);
  console.log(`[SyncService] Resolving conflict with choice: ${choice}`);

  if (choice === 'local') {
    // 用户选择本地版本 → 上传覆盖云端
    return await updateCloudSession(userId, localData.session, localData.words);
  } else {
    // 用户选择云端版本 → 下载覆盖本地
    return {
      success: true,
      action: 'downloaded',
      message: 'Cloud version applied',
      cloudData: {
        session: cloudData.session,
        words: cloudData.words
      }
    };
  }
};

/** Persist only the session snapshot that was actually synchronized. */
export const persistSessionSyncResult = async (userId: string, session: SessionWithSync, result: SyncResult): Promise<boolean> => {
  let applied = false;
  const saved = await localBackupStore.update(current => {
      const index = current.sessions.findIndex(item => item.id === session.id);
      if (index < 0) return current;
      const latest = current.sessions[index];
      // A save during the network request remains pending for the next sync.
      if (latest.lastSyncAttempt !== session.lastSyncAttempt || latest.timestamp !== session.timestamp
        || (latest.localRevision ?? 0) !== (session.localRevision ?? 0)) return current;
      applied = true;
      if (result.success) {
        current.sessions[index] = {
          ...(result.cloudData?.session ?? latest), syncStatus: 'synced', lastSyncAttempt: Date.now(), localRevision: latest.localRevision,
        };
        if (result.cloudData) {
          current.words = current.words.filter(word => word.sessionId !== session.id);
          current.words.push(...result.cloudData.words);
        }
      } else if (result.action === 'conflict') {
        current.sessions[index] = { ...latest, syncStatus: 'conflict', conflictData: result.conflictData };
      } else {
        current.sessions[index] = { ...latest, syncStatus: 'failed', lastSyncAttempt: Date.now() };
      }
      return current;
    }, userId);
    if (!saved) throw new Error('同步结果未能保存到本地，请重试。');
  return applied;
};

/**
 * 同步所有待同步的 Sessions
 */
export const syncAllPendingSessions = async (
  userId: string,
  onProgress?: (current: number, total: number, sessionId: string) => void
): Promise<{
  synced: number;
  failed: number;
  conflicts: number;
}> => {
  await assertCurrentUser(userId);
  const backup = await loadLocalBackup(userId);
  if (!backup) {
    return { synced: 0, failed: 0, conflicts: 0 };
  }

  // 筛选出待同步的 Sessions
  const pendingSessions = backup.sessions.filter(
    s => s.syncStatus === 'pending' || s.syncStatus === 'failed'
  );

  console.log(`[SyncService] Found ${pendingSessions.length} sessions to sync`);

  let synced = 0;
  let failed = 0;
  let conflicts = 0;

  for (let i = 0; i < pendingSessions.length; i++) {
    await assertCurrentUser(userId);
    const session = pendingSessions[i];
    onProgress?.(i + 1, pendingSessions.length, session.id);

    // 获取本地单词数据
    const localWords = backup.words.filter(w => w.sessionId === session.id);

    const result = await syncSessionToCloud(userId, session, localWords);

    await assertCurrentUser(userId);
    await persistSessionSyncResult(userId, session, result);
    if (result.success) synced++;
    else if (result.action === 'conflict') conflicts++;
    else failed++;
  }
  return { synced, failed, conflicts };
};
