/**
 * Sync Service - 处理本地与云端的数据同步
 * 支持离线优先、冲突检测、自动重试
 */

import { supabase } from '../lib/supabaseClient';
import { WordEntry, InputSession } from '../types';

// ============================================================================
// 类型定义
// ============================================================================

export type SyncStatus = 'synced' | 'pending' | 'syncing' | 'failed' | 'conflict';

export interface SessionWithSync extends InputSession {
  syncStatus: SyncStatus;
  lastSyncAttempt?: number;
  conflictData?: {
    cloud: InputSession;
    local: InputSession;
  };
}

export interface LocalBackup {
  sessions: SessionWithSync[];
  words: WordEntry[];
  version: number; // 用于检测本地数据格式版本
}

export interface SyncResult {
  success: boolean;
  action: 'uploaded' | 'downloaded' | 'skipped' | 'conflict' | 'error';
  message?: string;
  conflictData?: {
    cloud: InputSession;
    local: InputSession;
  };
}

// ============================================================================
// 常量
// ============================================================================

const LOCAL_STORAGE_KEY = 'vocab_local_backup';
const SYNC_THRESHOLD_TOLERANCE = 1000; // 1秒内的差异视为同时更新

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 生成单词内容的哈希值，用于检测内容是否真的不同
 */
const getContentHash = (words: WordEntry[]): string => {
  const sorted = [...words].sort((a, b) => a.text.localeCompare(b.text));
  return sorted.map(w => `${w.text}:${w.correct ? '1' : '0'}`).join('|');
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
export const loadLocalBackup = (): LocalBackup | null => {
  try {
    const data = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!data) return null;

    const backup: LocalBackup = JSON.parse(data);

    // 验证数据格式
    if (!backup.sessions || !Array.isArray(backup.sessions)) {
      console.warn('[SyncService] Invalid backup format, clearing...');
      clearLocalBackup();
      return null;
    }

    console.log(`[SyncService] Loaded ${backup.sessions.length} sessions from local backup`);
    return backup;
  } catch (error) {
    console.error('[SyncService] Failed to load local backup:', error);
    return null;
  }
};

/**
 * 保存本地备份数据
 */
export const saveLocalBackup = (backup: LocalBackup): void => {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(backup));
    console.log(`[SyncService] Saved ${backup.sessions.length} sessions to local backup`);
  } catch (error) {
    console.error('[SyncService] Failed to save local backup:', error);

    // 容量不足警告
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      console.warn('[SyncService] LocalStorage quota exceeded, need cleanup');
      // TODO: 实现清理策略（删除最旧的数据）
    }
  }
};

/**
 * 清除本地备份
 */
export const clearLocalBackup = (): void => {
  localStorage.removeItem(LOCAL_STORAGE_KEY);
  console.log('[SyncService] Local backup cleared');
};

/**
 * 保存 Session 到本地备份
 */
export const saveSessionToLocal = (
  session: InputSession,
  words: WordEntry[],
  syncStatus: SyncStatus = 'pending'
): void => {
  const backup = loadLocalBackup() || { sessions: [], words: [], version: 1 };

  // 更新或添加 Session
  const existingIndex = backup.sessions.findIndex(s => s.id === session.id);

  const sessionWithSync: SessionWithSync = {
    ...session,
    syncStatus,
    lastSyncAttempt: Date.now()
  };

  if (existingIndex >= 0) {
    backup.sessions[existingIndex] = sessionWithSync;
  } else {
    backup.sessions.push(sessionWithSync);
  }

  // 更新或添加 Words
  const existingWordIds = new Set(backup.words.map(w => w.id));
  words.forEach(word => {
    if (!existingWordIds.has(word.id)) {
      backup.words.push(word);
    } else {
      const idx = backup.words.findIndex(w => w.id === word.id);
      if (idx >= 0) backup.words[idx] = word;
    }
  });

  saveLocalBackup(backup);
};

/**
 * 从本地备份中删除 Session
 */
export const deleteSessionFromLocal = (sessionId: string): void => {
  const backup = loadLocalBackup();
  if (!backup) return;

  backup.sessions = backup.sessions.filter(s => s.id !== sessionId);
  backup.words = backup.words.filter(w => w.sessionId !== sessionId);

  saveLocalBackup(backup);
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

    const cloudWordsData: WordEntry[] = (cloudWords || []).map((w: any) => ({
      id: w.id,
      text: w.text,
      timestamp: new Date(w.created_at).getTime(),
      sessionId: w.session_id,
      correct: w.correct,
      tested: w.tested,
      image_path: w.image_path,
      image_url: null, // 稍后生成
      error_count: w.error_count || 0,
      best_time_ms: w.best_time_ms || null,
      last_tested: w.last_tested ? new Date(w.last_tested).getTime() : null,
      phonetic: w.phonetic || null,
      audio_url: w.audio_url || null,
      definition_cn: w.definition_cn || null,
      definition_en: w.definition_en || null,
      deleted: w.deleted || false,
      tags: w.tags || ['Custom']
    }));

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
          message: 'Local and cloud are already in sync'
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
const uploadNewSession = async (
  userId: string,
  session: InputSession,
  words: WordEntry[]
): Promise<SyncResult> => {
  try {
    // 1. 创建 Session
    const { data: sessionData, error: sessionError } = await supabase
      .from('sessions')
      .insert({
        id: session.id, // 使用本地生成的 ID
        user_id: userId,
        word_count: session.wordCount,
        target_count: session.targetCount,
        library_tag: session.libraryTag,
        created_at: new Date(session.timestamp).toISOString()
      })
      .select()
      .single();

    if (sessionError) {
      console.error('[SyncService] ❌ Session insert error:', sessionError);
      console.error('[SyncService]    Error code:', sessionError.code);
      console.error('[SyncService]    Error message:', sessionError.message);
      console.error('[SyncService]    Error details:', sessionError.details);
      console.error('[SyncService]    Error hint:', sessionError.hint);
      throw sessionError;
    }

    // 2. 批量插入 Words（不包含图片数据）
    console.log(`[SyncService] 📝 Preparing to insert ${words.length} words...`);
    const wordsPayload = words.map(w => ({
      id: w.id,
      user_id: userId,
      session_id: session.id,
      text: w.text,
      correct: w.correct,
      tested: w.tested,
      error_count: w.error_count || 0,
      best_time_ms: w.best_time_ms,
      last_tested: w.last_tested ? new Date(w.last_tested).toISOString() : null,
      phonetic: w.phonetic,
      audio_url: w.audio_url,
      definition_cn: w.definition_cn,
      definition_en: w.definition_en,
      tags: w.tags,
      created_at: new Date(w.timestamp).toISOString()
    }));

    const { error: wordsError } = await supabase
      .from('words')
      .insert(wordsPayload);

    if (wordsError) {
      console.error('[SyncService] ❌ Words insert error:', wordsError);
      console.error('[SyncService]    Error code:', wordsError.code);
      console.error('[SyncService]    Error message:', wordsError.message);
      console.error('[SyncService]    Error details:', wordsError.details);
      console.error('[SyncService]    Error hint:', wordsError.hint);
      throw wordsError;
    }

    console.log(`[SyncService] ✅ Uploaded new session ${session.id} with ${words.length} words`);

    return {
      success: true,
      action: 'uploaded',
      message: 'Successfully uploaded to cloud'
    };

  } catch (error) {
    console.error('[SyncService] ❌ Upload failed with exception:', error);
    console.error('[SyncService]    Error name:', (error as any).name);
    console.error('[SyncService]    Error message:', (error as Error).message);
    console.error('[SyncService]    Error stack:', (error as any).stack);
    return {
      success: false,
      action: 'error',
      message: `Upload failed: ${(error as Error).message}`
    };
  }
};

/**
 * 更新云端 Session（本地优先）
 */
const updateCloudSession = async (
  userId: string,
  session: InputSession,
  words: WordEntry[]
): Promise<SyncResult> => {
  try {
    console.log(`[SyncService] 🔄 Updating session ${session.id} with ${words.length} words`);

    // 1. 更新 Session 元数据
    const { error: sessionError } = await supabase
      .from('sessions')
      .update({
        word_count: session.wordCount,
        target_count: session.targetCount,
        created_at: new Date(session.timestamp).toISOString() // 更新时间戳
      })
      .eq('id', session.id)
      .eq('user_id', userId);

    if (sessionError) {
      console.error('[SyncService] ❌ Session update error:', sessionError);
      console.error('[SyncService]    Error code:', sessionError.code);
      console.error('[SyncService]    Error message:', sessionError.message);
      console.error('[SyncService]    Error details:', sessionError.details);
      console.error('[SyncService]    Error hint:', sessionError.hint);
      throw sessionError;
    }

    // 2. 更新或插入 Words（使用 upsert）
    const wordsPayload = words.map(w => ({
      id: w.id,
      user_id: userId,
      session_id: session.id,
      text: w.text,
      correct: w.correct,
      tested: w.tested,
      error_count: w.error_count || 0,
      best_time_ms: w.best_time_ms,
      last_tested: w.last_tested ? new Date(w.last_tested).toISOString() : null,
      phonetic: w.phonetic,
      audio_url: w.audio_url,
      definition_cn: w.definition_cn,
      definition_en: w.definition_en,
      tags: w.tags,
      created_at: new Date(w.timestamp).toISOString()
    }));

    // Supabase 的 upsert 不支持批量，我们分批处理
    const BATCH_SIZE = 100;
    const totalBatches = Math.ceil(wordsPayload.length / BATCH_SIZE);
    console.log(`[SyncService] 📦 Will process ${wordsPayload.length} words in ${totalBatches} batches`);

    for (let i = 0; i < wordsPayload.length; i += BATCH_SIZE) {
      const batch = wordsPayload.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;

      console.log(`[SyncService] 📝 Processing batch ${batchNum}/${totalBatches} (${batch.length} words)`);

      // 先删除已存在的 words
      const wordIds = batch.map(w => w.id);
      const { error: deleteError } = await supabase
        .from('words')
        .delete()
        .in('id', wordIds)
        .eq('user_id', userId);

      if (deleteError) {
        console.error('[SyncService] ❌ Batch delete error:', deleteError);
        console.error('[SyncService]    Error code:', deleteError.code);
        console.error('[SyncService]    Error message:', deleteError.message);
        console.error('[SyncService]    Error details:', deleteError.details);
        console.error('[SyncService]    Error hint:', deleteError.hint);
        throw deleteError;
      }

      // 再插入新数据
      const { error: wordsError } = await supabase
        .from('words')
        .insert(batch);

      if (wordsError) {
        console.error('[SyncService] ❌ Batch insert error:', wordsError);
        console.error('[SyncService]    Error code:', wordsError.code);
        console.error('[SyncService]    Error message:', wordsError.message);
        console.error('[SyncService]    Error details:', wordsError.details);
        console.error('[SyncService]    Error hint:', wordsError.hint);
        throw wordsError;
      }
    }

    console.log(`[SyncService] Updated session ${session.id} with ${words.length} words`);

    return {
      success: true,
      action: 'uploaded',
      message: 'Local changes uploaded to cloud'
    };

  } catch (error) {
    console.error('[SyncService] ❌ Update failed with exception:', error);
    console.error('[SyncService]    Error name:', (error as any).name);
    console.error('[SyncService]    Error message:', (error as Error).message);
    console.error('[SyncService]    Error stack:', (error as any).stack);
    return {
      success: false,
      action: 'error',
      message: `Update failed: ${(error as Error).message}`
    };
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
  const backup = loadLocalBackup();
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
    const session = pendingSessions[i];
    onProgress?.(i + 1, pendingSessions.length, session.id);

    // 获取本地单词数据
    const localWords = backup.words.filter(w => w.sessionId === session.id);

    const result = await syncSessionToCloud(userId, session, localWords);

    if (result.success) {
      if (result.action === 'uploaded') {
        // 更新本地状态为 synced
        session.syncStatus = 'synced';
        session.lastSyncAttempt = Date.now();
        synced++;
      } else if (result.action === 'downloaded') {
        // 应用云端数据到本地
        const idx = backup.sessions.findIndex(s => s.id === session.id);
        if (idx >= 0) {
          backup.sessions[idx] = result.cloudData!.session;
        }

        // 更新 words
        const wordIds = new Set(localWords.map(w => w.id));
        backup.words = backup.words.filter(w => !wordIds.has(w.id));
        backup.words.push(...result.cloudData!.words);

        saveLocalBackup(backup);
        synced++;
      } else if (result.action === 'conflict') {
        session.syncStatus = 'conflict';
        session.conflictData = result.conflictData;
        conflicts++;
      }
    } else {
      session.syncStatus = 'failed';
      session.lastSyncAttempt = Date.now();
      failed++;
    }
  }

  // 保存更新后的状态
  saveLocalBackup(backup);

  console.log(`[SyncService] Sync complete: ${synced} synced, ${failed} failed, ${conflicts} conflicts`);

  return { synced, failed, conflicts };
};
