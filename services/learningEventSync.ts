import { acknowledgeLearningReplay, readLearningJournal } from './learningRecordStore.ts';
import type { LearningStorage } from './learningRecordStore.ts';
import { parseLearningReplay, projectLearningEvents, sameLearningEvent } from './learningReplay.ts';
import type { LearningEvent, LearningPatch, LearningReplayWord } from './learningReplay.ts';

export interface LearningSyncTransport {
  getUserId(): Promise<string | null>;
  append(events: LearningEvent[]): Promise<unknown>;
  getReplay(wordIds: string[]): Promise<unknown>;
  /** Repair an append whose originating device closed before committing. */
  getUnprojected?(): Promise<unknown>;
  commit(wordId: string, revision: number, patch: LearningPatch): Promise<unknown>;
}
export interface LearningSyncResult {
  synced: number;
  pending: number;
  projections: Record<string, LearningPatch & { learning_revision: number }>;
  unavailableWordIds?: string[];
}
const pendingEvents = (userId: string, storage: LearningStorage) => Object.values(readLearningJournal(userId, storage).events).filter(item => item.pending).map(item => item.event);
const validateReply = (reply: LearningReplayWord[], events: LearningEvent[]) => {
  const words = new Map(reply.map(word => [word.word_id, word]));
  for (const event of events) {
    const remote = words.get(event.word_id)?.events.find(item => item.event_id === event.event_id);
    if (!remote || !sameLearningEvent(event, remote)) throw new Error('云端尚未确认全部学习事件，本机记录已保留。');
  }
};
function batches(events: LearningEvent[]): LearningEvent[][] {
  const result: LearningEvent[][] = [];
  let batch: LearningEvent[] = [];
  let words = new Set<string>();
  for (const event of events) {
    if (batch.length >= 200 || (!words.has(event.word_id) && words.size >= 100)) {
      result.push(batch); batch = []; words = new Set();
    }
    batch.push(event); words.add(event.word_id);
  }
  if (batch.length) result.push(batch);
  return result;
}

/**
 * Append immutable answers, replay through the shared scheduler, then CAS the
 * projection. A lost response, concurrent device or stale read never removes
 * the local event before a positive acknowledgement of the exact revision.
 */
export async function syncLearningEvents(userId: string, transport: LearningSyncTransport, storage: LearningStorage): Promise<LearningSyncResult> {
  const events = pendingEvents(userId, storage);
  const projections: LearningSyncResult['projections'] = {};
  if (!events.length && !transport.getUnprojected) return { synced: 0, pending: 0, projections };
  const assertAccount = async () => {
    if (await transport.getUserId() !== userId) throw new Error('当前账号与待同步学习记录不匹配。');
  };
  let synced = 0;
  const unavailableWordIds = new Set<string>();
  const commitReplay = async (initial: LearningReplayWord, requested: LearningEvent[] = []) => {
    let replay = initial;
    for (let attempt = 0; attempt < 3; attempt++) {
      await assertAccount();
      const patch = projectLearningEvents(replay.base, replay.events);
      const raw = await transport.commit(replay.word_id, replay.revision, patch);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('云端没有确认学习进度写入。');
      const response = raw as Record<string, unknown>;
      if (response.word_id !== replay.word_id || typeof response.committed !== 'boolean' ||
          !Number.isSafeInteger(response.revision) || (response.revision as number) < replay.revision) throw new Error('云端学习进度确认格式异常。');
      if (response.committed) {
        if (response.revision !== replay.revision) throw new Error('云端确认的学习版本不匹配。');
        await assertAccount();
        const before = new Set(pendingEvents(userId, storage).map(event => event.event_id));
        const projection = acknowledgeLearningReplay(userId, replay, storage);
        synced += replay.events.filter(event => before.has(event.event_id)).length;
        projections[replay.word_id] = { ...projection, learning_revision: replay.revision };
        return;
      }
      if (attempt < 2) {
        await assertAccount();
        const next = parseLearningReplay(await transport.getReplay([replay.word_id]));
        if (next.length !== 1 || next[0].word_id !== replay.word_id || next[0].revision < replay.revision) throw new Error('云端学习版本发生异常回退。');
        validateReply(next, requested);
        replay = next[0];
      }
    }
  };
  const uploadBatch = async (batch: LearningEvent[]): Promise<void> => {
    await assertAccount();
    let uploaded: LearningReplayWord[];
    try {
      uploaded = parseLearningReplay(await transport.append(batch));
    } catch (error) {
      // A word deleted on another device must not block unrelated pending words.
      // Retain its events for recovery; only isolate this specific server error.
      const unavailable = error && typeof error === 'object' && 'code' in error && error.code === '42501' &&
        'message' in error && error.message === 'Word unavailable';
      if (!unavailable) throw error;
      const wordIds = [...new Set(batch.map(event => event.word_id))];
      if (wordIds.length === 1) { unavailableWordIds.add(wordIds[0]); return; }
      for (const wordId of wordIds) await uploadBatch(batch.filter(event => event.word_id === wordId));
      return;
    }
    validateReply(uploaded, batch);
    for (const initial of uploaded) {
      // Do not commit an unexpected word returned by a malformed response.
      const requested = batch.filter(event => event.word_id === initial.word_id);
      if (!requested.length) throw new Error('云端返回了未请求的学习记录。');
      await commitReplay(initial, requested);
    }
  };
  for (const batch of batches(events)) await uploadBatch(batch);
  if (transport.getUnprojected) {
    await assertAccount();
    const abandoned = parseLearningReplay(await transport.getUnprojected());
    for (const replay of abandoned) {
      if (!replay.events.length || replay.revision < 1) throw new Error('待恢复的云端学习记录缺少事件。');
      await commitReplay(replay);
    }
  }
  return { synced, pending: pendingEvents(userId, storage).length, projections,
    ...(unavailableWordIds.size ? { unavailableWordIds: [...unavailableWordIds] } : {}) };
}
