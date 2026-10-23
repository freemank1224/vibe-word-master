import type { InputSession, WordEntry } from '../types.ts';
import { normalizeReviewState } from './reviewScheduler.ts';

export type SyncStatus = 'synced' | 'pending' | 'syncing' | 'failed' | 'conflict';
export interface SessionWithSync extends InputSession {
  syncStatus: SyncStatus;
  lastSyncAttempt?: number;
  localRevision?: number;
  conflictData?: { cloud: InputSession; local: InputSession };
}
export interface LocalBackup {
  sessions: SessionWithSync[];
  words: WordEntry[];
  version: number;
  ownerId?: string;
  savedAt?: number;
}
export interface OwnedLocalBackup extends LocalBackup { ownerId: string; }
export function requireBackupOwner(userId: string | undefined | null): string {
  if (typeof userId !== 'string' || !userId.trim()) throw new Error('需要登录后访问本地备份。');
  return userId;
}
export const localBackupKey = (userId: string) => `vocab_local_backup:${requireBackupOwner(userId)}`;
export const indexedBackupKey = (userId: string) => `session_backup:${requireBackupOwner(userId)}`;
export function isOwnedLocalBackup(value: unknown, userId: string): value is OwnedLocalBackup {
  if (!value || typeof value !== 'object') return false;
  const backup = value as Partial<LocalBackup>;
  return backup.ownerId === userId && Array.isArray(backup.sessions) && Array.isArray(backup.words);
}
export function withBackupOwner(backup: LocalBackup, userId: string): OwnedLocalBackup {
  requireBackupOwner(userId);
  if (backup.ownerId && backup.ownerId !== userId) throw new Error('本地备份属于另一个账号，已停止写入。');
  return { ...backup, ownerId: userId, version: 2, savedAt: Date.now() };
}

/** Only content fields belong to session sync. Review events own every learning field. */
export function wordMetadata(word: WordEntry) {
  return {
    text: word.text,
    phonetic: word.phonetic,
    audio_url: word.audio_url,
    language: word.language || 'en',
    lexeme_id: word.lexeme_id ?? null,
    definition_cn: word.definition_cn,
    definition_en: word.definition_en,
    meaning_options: word.meaning_options ?? [],
    selected_meaning_key: word.selected_meaning_key ?? null,
    tags: word.tags ?? ['Custom'],
    image_path: word.image_path ?? null,
    image_asset_id: word.image_asset_id ?? null,
    deleted: Boolean(word.deleted),
  };
}
export function newWordRow(userId: string, sessionId: string, word: WordEntry) {
  return {
    ...wordMetadata(word), id: word.id, user_id: requireBackupOwner(userId), session_id: sessionId,
    created_at: new Date(word.timestamp).toISOString(),
    // Initial learning state is provided by DB defaults, then journal replay.
  };
}
const nullableString = (value: unknown): string | null => typeof value === 'string' ? value : null;
const finiteNumber = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
export function mapCloudWord(row: Record<string, unknown>, imageUrl: string | null = null): WordEntry {
  if (typeof row.id !== 'string' || typeof row.text !== 'string' || typeof row.session_id !== 'string') {
    throw new Error('云端单词缺少身份字段。');
  }
  return {
    id: row.id, text: row.text, sessionId: row.session_id,
    timestamp: new Date(String(row.created_at)).getTime(),
    correct: row.correct === true, tested: row.tested === true,
    error_count: finiteNumber(row.error_count), consecutive_correct: finiteNumber(row.consecutive_correct),
    score: finiteNumber(row.score), learning_revision: finiteNumber(row.learning_revision),
    best_time_ms: typeof row.best_time_ms === 'number' ? row.best_time_ms : null,
    last_tested: row.last_tested ? new Date(String(row.last_tested)).getTime() : null,
    review_state: normalizeReviewState(row.review_state),
    image_path: nullableString(row.image_path), image_asset_id: nullableString(row.image_asset_id), image_url: imageUrl,
    phonetic: nullableString(row.phonetic), audio_url: nullableString(row.audio_url),
    language: nullableString(row.language) || 'en', lexeme_id: nullableString(row.lexeme_id),
    definition_cn: nullableString(row.definition_cn), definition_en: nullableString(row.definition_en),
    meaning_options: Array.isArray(row.meaning_options) ? row.meaning_options : [],
    selected_meaning_key: nullableString(row.selected_meaning_key),
    deleted: row.deleted === true,
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : ['Custom'],
  };
}

export interface LocalBackupAdapter {
  resolveCurrentUser: () => Promise<string | null>;
  read: (userId: string) => Promise<unknown>;
  write: (userId: string, backup: OwnedLocalBackup) => Promise<boolean>;
  remove: (userId: string) => Promise<void>;
}
/** Captures account before the first storage await, and serializes per-account mutations. */
export function createLocalBackupStore(adapter: LocalBackupAdapter) {
  const pending = new Map<string, Promise<unknown>>();
  const owner = async (userId?: string) => requireBackupOwner(userId ?? await adapter.resolveCurrentUser());
  const read = async (userId: string): Promise<OwnedLocalBackup | null> => {
    const value = await adapter.read(userId);
    if (value == null) return null;
    if (!isOwnedLocalBackup(value, userId)) throw new Error('本地备份归属异常，原始数据已保留。');
    return value;
  };
  const serialize = async <T>(userId: string, work: () => Promise<T>): Promise<T> => {
    const before = pending.get(userId) ?? Promise.resolve();
    const task = before.catch(() => undefined).then(work);
    pending.set(userId, task);
    try { return await task; }
    finally { if (pending.get(userId) === task) pending.delete(userId); }
  };
  return {
    async load(userId?: string) { return read(await owner(userId)); },
    async save(backup: LocalBackup, userId?: string) {
      const id = await owner(userId);
      const owned = withBackupOwner(backup, id);
      return serialize(id, () => adapter.write(id, owned));
    },
    async clear(userId?: string) {
      const id = await owner(userId);
      return serialize(id, () => adapter.remove(id));
    },
    async update(update: (backup: OwnedLocalBackup) => OwnedLocalBackup, userId?: string) {
      const id = await owner(userId);
      return serialize(id, async () => {
        const backup = await read(id) ?? { ownerId: id, version: 2, sessions: [], words: [] };
        return adapter.write(id, withBackupOwner(update(backup), id));
      });
    },
  };
}
