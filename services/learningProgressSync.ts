import { supabase } from '../lib/supabaseClient';
import { syncLearningEvents } from './learningEventSync';
import type { LearningSyncResult, LearningSyncTransport } from './learningEventSync';

const inFlight = new Map<string, Promise<LearningSyncResult>>();
const transport: LearningSyncTransport = {
  async getUserId() {
    // This only detects local account switches. Each RPC separately authorizes
    // auth.uid() on the server; avoid an extra auth HTTP request for every word.
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    return data.session?.user.id ?? null;
  },
  async append(events) {
    const { data, error } = await supabase.rpc('append_learning_events_v1', { p_events: events });
    if (error) throw error;
    return data;
  },
  async getReplay(wordIds) {
    const { data, error } = await supabase.rpc('get_learning_replay_v1', { p_word_ids: wordIds });
    if (error) throw error;
    return data;
  },
  async getUnprojected() {
    const { data, error } = await supabase.rpc('get_unprojected_learning_replays_v1', { p_limit: 100 });
    if (error) throw error;
    return data;
  },
  async commit(wordId, revision, patch) {
    const { data, error } = await supabase.rpc('commit_learning_projection_v1', {
      p_word_id: wordId, p_revision: revision, p_patch: patch,
    });
    if (error) throw error;
    return data;
  },
};

/** No legacy snapshot fallback: deployment/network failures retain every answer for retry. */
export function syncPendingLearningProgress(userId: string): Promise<LearningSyncResult> {
  const active = inFlight.get(userId);
  if (active) return active;
  const work = syncLearningEvents(userId, transport, localStorage).finally(() => inFlight.delete(userId));
  inFlight.set(userId, work);
  return work;
}
