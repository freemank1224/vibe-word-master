import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import type { WordEntry } from '../../types';
import { overlayLearningProgress } from '../../services/learningRecordStore';
import { syncPendingLearningProgress } from '../../services/learningProgressSync';
import {
  getMonsterSurfAccount, startMonsterSurfRun, settleMonsterSurfRun, MonsterSurfServiceError,
  type MonsterSurfRun, type MonsterSurfSettlement,
} from '../../services/monsterSurfService';
import { selectSurfReviewVocabulary, type SurfReviewVocabulary } from './reviewVocabulary';
import { currentSurfWord, pauseSurf, startSurf } from './game';
import type { SurfState, SurfWord } from './types';
import { SURF_WORDS } from './words';
import { DEFAULT_SURF_RUN_MODE, modeWordLimit, type SurfRunMode } from './runMode';
import { appendSurfAttempt, hasUnconfirmedSurfReceipt, readSurfRide, replaySurfLearning, SurfJournalError, writeSurfRide, type SavedRide, type SavedSurfAttempt } from './sessionJournal';

const errorCodeOf = (error: unknown) => error instanceof SurfJournalError ? 'storage_error'
  : error instanceof MonsterSurfServiceError ? error.code : 'request_failed';

/** Read only the learner's vocabulary; no image downloads or library side effects. */
async function fetchSurfWords(userId: string): Promise<WordEntry[]> {
  const words: WordEntry[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from('words')
      .select('id,text,created_at,session_id,correct,tested,score,error_count,best_time_ms,last_tested,audio_url,language,definition_cn,definition_en,meaning_options,selected_meaning_key,consecutive_correct,review_state,learning_revision,deleted')
      .eq('user_id', userId).or('deleted.eq.false,deleted.is.null').is('deleted_at', null)
      .order('id').range(offset, offset + 499);
    if (error) throw error;
    for (const row of data || []) words.push({
      ...row, timestamp: Date.parse(row.created_at), sessionId: row.session_id,
      last_tested: row.last_tested ? Date.parse(row.last_tested) : null,
      error_count: row.error_count || 0, best_time_ms: row.best_time_ms ?? null, phonetic: null,
      language: row.language || 'en', consecutive_correct: row.consecutive_correct || 0,
      learning_revision: row.learning_revision || 0,
    } as WordEntry);
    if (!data || data.length < 500) break;
  }
  return overlayLearningProgress(userId, words);
}

/** Account/wallet boundary. Physics stays local; charging and payout are atomic RPCs. */
export function useSurfSession() {
  const [practice] = useState(() => new URLSearchParams(location.search).get('practice') === '1');
  const [status, setStatus] = useState<'loading' | 'anonymous' | 'ready' | 'error'>(practice ? 'ready' : 'loading');
  const [balance, setBalance] = useState<number | null>(null);
  const [selection, setSelection] = useState<SurfReviewVocabulary | null>(null);
  const [run, setRun] = useState<MonsterSurfRun | null>(null);
  const [result, setResult] = useState<MonsterSurfSettlement | null>(null);
  const [busy, setBusy] = useState<'start' | 'settle' | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [learningPending, setLearningPending] = useState(false);
  const [learningSyncing, setLearningSyncing] = useState(false);
  const [attempts, setAttempts] = useState<readonly SavedSurfAttempt[]>([]);
  const [recoveredState, setRecoveredState] = useState<SurfState | null>(null);
  const [recoveredRunId, setRecoveredRunId] = useState<string | null>(null);
  const owner = useRef<string | null>(null);
  const generation = useRef(0);
  const allWords = useRef<WordEntry[]>([]);
  const currentRun = useRef<MonsterSurfRun | null>(null);
  const journal = useRef<SavedRide | null>(null);
  const busyRef = useRef<object | null>(null);
  const learningFlush = useRef<{ userId: string; dirty: boolean; promise: Promise<void> } | null>(null);
  const lastCapture = useRef({ at: 0, event: -1, phase: '' });
  const currentSelection = useRef<SurfReviewVocabulary | null>(null);
  const alive = useRef(true);

  const flushLearning = useCallback(async (userId: string) => {
    const existing = learningFlush.current;
    if (existing?.userId === userId) { existing.dirty = true; return existing.promise; }
    const work = { userId, dirty: true, promise: Promise.resolve() };
    learningFlush.current = work;
    setLearningSyncing(true);
    work.promise = (async () => {
      let pending = true;
      try {
        // New answers arriving during a shared RPC cause another pass after it
        // completes; a resolved upload is not proof that its later events synced.
        for (let pass = 0; pass < 4 && alive.current && owner.current === userId; pass++) {
          work.dirty = false;
          const replay = replaySurfLearning(userId, journal.current, allWords.current);
          allWords.current = replay.words;
          const synced = await syncPendingLearningProgress(userId);
          pending = synced.pending > 0 || work.dirty || replay.missingWordIds.length > 0;
          if (!pending || replay.missingWordIds.length || synced.unavailableWordIds?.length) break;
        }
      } catch { pending = true; }
      finally {
        if (alive.current && owner.current === userId && learningFlush.current === work) {
          setLearningPending(pending); setLearningSyncing(false);
        }
        if (learningFlush.current === work) learningFlush.current = null;
      }
    })();
    return work.promise;
  }, []);

  const refresh = useCallback(async () => {
    if (practice) return;
    const epoch = ++generation.current;
    try {
      const { data, error } = await supabase.auth.getSession();
      if (!alive.current || epoch !== generation.current) return;
      if (error) throw error;
      const userId = data.session?.user.id ?? null;
      const changed = userId !== owner.current;
      owner.current = userId;
      if (changed) {
        currentRun.current = null; journal.current = null; allWords.current = [];
        currentSelection.current = null; busyRef.current = null; learningFlush.current = null;
        setRun(null); setResult(null); setBalance(null); setSelection(null); setBusy(null);
        setLearningPending(false); setLearningSyncing(false); setAttempts([]); setRecoveredState(null); setRecoveredRunId(null); setErrorCode(null);
      }
      if (!userId) { setStatus('anonymous'); return; }
      // Review is local and read-only; a connection failure must not hide it.
      if (!currentRun.current && !journal.current) {
        const saved = readSurfRide(userId);
        journal.current = saved; setAttempts(saved?.attempts ?? []);
        if (saved?.snapshot?.phase === 'over') {
          setRecoveredState(saved.snapshot); setRecoveredRunId(saved.runId);
          setLearningPending(saved.attempts.some(attempt => Boolean(attempt.learning)));
        }
      }
      if (changed || !currentSelection.current) setStatus('loading');
      // Local pending events are projected before selection; cloud retries remain durable.
      const [account, words] = await Promise.all([getMonsterSurfAccount(), fetchSurfWords(userId)]);
      if (!alive.current || epoch !== generation.current) return;
      const selected = selectSurfReviewVocabulary(words, { limit: Infinity });
      allWords.current = words; currentSelection.current = selected;
      setSelection(selected); setBalance(account.balance);
      if (account.activeRun && journal.current?.runId !== account.activeRun.id) {
        setRecoveredState(null); setRecoveredRunId(null);
      }
      // Never replace a live in-memory run with a stale focus refresh.
      if (!currentRun.current || currentRun.current.status === 'settled') {
        currentRun.current = account.activeRun;
        setRun(account.activeRun);
        journal.current = readSurfRide(userId);
        setAttempts(journal.current?.attempts ?? []);
        // Restore the complete review after refresh, including a lost receipt.
        // The same settlement UUID cannot charge or award coins a second time.
        if (journal.current?.snapshot?.phase === 'over' && (!account.activeRun || account.activeRun.id === journal.current.runId)) {
          const saved = journal.current;
          const receipt = await settleMonsterSurfRun(saved.runId, saved.snapshot!.coins, saved.attempts);
          if (!alive.current || epoch !== generation.current || owner.current !== userId) return;
          const confirmed = { ...saved, receiptConfirmed: true };
          writeSurfRide(userId, confirmed); journal.current = confirmed;
          currentRun.current = receipt.run;
          setRun(receipt.run); setResult(receipt); setBalance(receipt.balance); setRecoveredState(saved.snapshot); setRecoveredRunId(saved.runId);
        }
      }
      setStatus('ready'); setErrorCode(null);
      void flushLearning(userId);
    } catch (error) {
      if (alive.current && epoch === generation.current) { setStatus('error'); setErrorCode(errorCodeOf(error)); }
    }
  }, [practice, flushLearning]);

  useEffect(() => {
    alive.current = true;
    if (practice) return () => { alive.current = false; };
    void refresh();
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      // Run outside the auth callback's lock. Token refresh must not reset a ride.
      if (session?.user.id !== owner.current) queueMicrotask(() => { if (alive.current) void refresh(); });
    });
    const online = () => { if (owner.current) void flushLearning(owner.current); };
    window.addEventListener('online', online);
    return () => { alive.current = false; generation.current += 1; data.subscription.unsubscribe(); window.removeEventListener('online', online); };
  }, [practice, refresh, flushLearning]);

  const begin = async (monsterId: number, mode: SurfRunMode = DEFAULT_SURF_RUN_MODE,
    prepareAudio?: (deck: readonly SurfWord[], mode: 'fixed' | 'endless', checkpoint: number) => Promise<void>,
    signal?: AbortSignal): Promise<SurfState | null> => {
    if (busyRef.current) return null;
    if (practice) {
      const operation = {}; busyRef.current = operation; setBusy('start'); setErrorCode(null);
      try {
        const deck = SURF_WORDS.slice(0, modeWordLimit(mode));
        await prepareAudio?.(deck, mode.kind, 0);
        if (signal?.aborted || !alive.current) return null;
        setResult(null); setAttempts([]); return startSurf(monsterId, deck);
      } catch (error) {
        if (!signal?.aborted && alive.current) setErrorCode(errorCodeOf(error));
        return null;
      } finally { if (busyRef.current === operation) { busyRef.current = null; if (alive.current) setBusy(null); } }
    }
    const userId = owner.current;
    if (!userId || status !== 'ready') { setErrorCode('not_authenticated'); return null; }
    const operation = {}; const epoch = generation.current;
    const current = () => alive.current && owner.current === userId && epoch === generation.current;
    busyRef.current = operation; setBusy('start'); setErrorCode(null); setRecoveredState(null);
    try {
      const auth = await supabase.auth.getSession();
      if (!current()) return null;
      if (auth.error || auth.data.session?.user.id !== userId) throw new MonsterSurfServiceError('auth_changed');
      const saved = journal.current ?? readSurfRide(userId);
      // A confirmed receipt may be replaced by a new ride only after every
      // available WAL answer has its own durable learning-journal copy.
      try {
        const replay = replaySurfLearning(userId, saved, allWords.current);
        allWords.current = replay.words;
        if (replay.missingWordIds.length) throw new MonsterSurfServiceError('learning_unavailable');
      }
      catch (error) { if (error instanceof MonsterSurfServiceError) throw error; throw new SurfJournalError('Pending learning could not be saved.'); }
      if (hasUnconfirmedSurfReceipt(saved)) {
        const receipt = await settleMonsterSurfRun(saved.runId, saved.snapshot!.coins, saved.attempts);
        if (!current()) return null;
        const confirmed = { ...saved, receiptConfirmed: true };
        writeSurfRide(userId, confirmed); journal.current = confirmed;
        setAttempts(confirmed.attempts);
        currentRun.current = receipt.run; setRun(receipt.run); setResult(receipt); setBalance(receipt.balance);
        setRecoveredState(saved.snapshot); setRecoveredRunId(saved.runId);
        return saved.snapshot;
      }
      const activeRun = currentRun.current?.status === 'active' ? currentRun.current : null;
      const runId = activeRun?.id ?? (saved?.snapshot === null && !saved.receiptConfirmed ? saved.runId : crypto.randomUUID());
      const selected = selectSurfReviewVocabulary(overlayLearningProgress(userId, allWords.current), { limit: modeWordLimit(mode) });
      if (!activeRun && !selected.deck.length) throw new MonsterSurfServiceError('invalid_words');
      // Download complete recordings before the entry-fee RPC. A failed or
      // cancelled preparation cannot charge for a ride that never became ready.
      const preparingDeck = activeRun?.words ?? selected.deck;
      const checkpoint = activeRun?.id === saved?.runId ? saved?.snapshot?.checkpoint ?? 0 : 0;
      await prepareAudio?.(preparingDeck, activeRun ? activeRun.mode?.kind ?? 'fixed' : mode.kind, checkpoint);
      if (!current() || signal?.aborted) return null;
      // Prove local durability before charging; retain the UUID on ambiguous responses.
      const pending: SavedRide = saved?.runId === runId ? saved : { version: 1, runId, attempts: [], snapshot: null, receiptConfirmed: false };
      writeSurfRide(userId, pending); journal.current = pending;
      const response = await startMonsterSurfRun(runId, activeRun?.words.map(word => word.wordId) ?? selected.entries.map(word => word.id), activeRun?.mode ?? mode);
      if (!current()) return null;
      if (response.run.status === 'settled') {
        const confirmed = { ...pending, runId: response.run.id, receiptConfirmed: true };
        writeSurfRide(userId, confirmed); journal.current = confirmed;
        currentRun.current = response.run; setRun(response.run); setBalance(response.balance);
        setResult({ run: response.run, balance: response.balance, alreadySettled: true });
        throw new MonsterSurfServiceError('already_settled');
      }
      currentRun.current = response.run; setRun(response.run); setBalance(response.balance); setResult(null);
      const deck = response.run.words;
      let next = startSurf(monsterId, deck);
      const recover = pending.runId === response.run.id ? pending : saved?.runId === response.run.id ? saved : null;
      if (recover?.runId === response.run.id && recover.snapshot) {
        const snapshot = recover.snapshot;
        const sameDeck = snapshot.deck?.length === deck.length && snapshot.deck.every((word, i) => word.wordId === deck[i].wordId && word.answer === deck[i].answer);
        if (!sameDeck || !Number.isInteger(snapshot.checkpoint) || snapshot.checkpoint < 0 || snapshot.checkpoint >= deck.length) throw new MonsterSurfServiceError('storage_error');
        next = snapshot.phase === 'over' ? snapshot : pauseSurf({ ...snapshot, deck });
      }
      const savedNext: SavedRide = { version: 1, runId: response.run.id, attempts: recover?.runId === response.run.id ? recover.attempts : [], snapshot: next, receiptConfirmed: false };
      writeSurfRide(userId, savedNext); journal.current = savedNext;
      setAttempts(savedNext.attempts);
      // Another tab may have started a paid ride while audio was downloading.
      // The server's immutable deck wins; keep its receipt before preparing it.
      if (!signal?.aborted) await prepareAudio?.(deck, response.run.mode?.kind ?? 'fixed', next.checkpoint);
      if (!current() || signal?.aborted) return null;
      return next;
    } catch (error) { if (current() && !signal?.aborted) setErrorCode(errorCodeOf(error)); return null; }
    finally { if (busyRef.current === operation) { busyRef.current = null; if (alive.current) setBusy(null); } }
  };

  const capture = (snapshot: SurfState) => {
    if (practice || !owner.current || !journal.current || currentRun.current?.status !== 'active' || snapshot.phase === 'ready') return;
    const now = performance.now();
    const previous = lastCapture.current;
    if (now - previous.at < 1000 && previous.event === snapshot.eventId && previous.phase === snapshot.phase) return;
    try {
      const next = { ...journal.current, snapshot };
      writeSurfRide(owner.current, next); journal.current = next;
      lastCapture.current = { at: now, event: snapshot.eventId, phase: snapshot.phase };
    } catch { setErrorCode('storage_error'); }
  };

  const recordAttempt = (before: SurfState, next: SurfState): boolean => {
    if (next === before || !before.input.trim() || (next.correct === before.correct && next.feedback !== 'wrong')) return true;
    if (practice) {
      setAttempts(previous => [...previous, { wordId: currentSurfWord(before).wordId ?? `practice:${before.checkpoint}`, answer: before.input }]);
      return true;
    }
    const userId = owner.current;
    const ride = journal.current;
    const word = currentSurfWord(before);
    if (!userId || !ride || !word.wordId || currentRun.current?.status !== 'active') { setErrorCode('not_authenticated'); return false; }
    try {
      const saved = appendSurfAttempt(ride, before, next, Date.now(), `surf:${ride.runId}:${crypto.randomUUID()}`);
      // Commit the answer and its exact learning payload together. If the
      // separate learning journal fails, this saved answer can safely replay.
      writeSurfRide(userId, saved); journal.current = saved;
      setAttempts(saved.attempts);
      setLearningPending(true);
      void flushLearning(userId);
      return true;
    } catch { setErrorCode('storage_error'); return false; }
  };

  const settle = async (snapshot: SurfState): Promise<void> => {
    if (practice || busyRef.current || currentRun.current?.status !== 'active') return;
    const userId = owner.current;
    const ride = journal.current;
    if (!userId || !ride) return;
    const operation = {}; const epoch = generation.current;
    const current = () => alive.current && owner.current === userId && epoch === generation.current;
    busyRef.current = operation; setBusy('settle'); setErrorCode(null);
    try {
      const auth = await supabase.auth.getSession();
      if (!current()) return;
      if (auth.error || auth.data.session?.user.id !== userId) throw new MonsterSurfServiceError('auth_changed');
      const finished = { ...ride, snapshot: { ...snapshot, phase: 'over' as const } };
      writeSurfRide(userId, finished); journal.current = finished;
      const receipt = await settleMonsterSurfRun(ride.runId, snapshot.coins, ride.attempts);
      if (!current()) return;
      const confirmed = { ...finished, receiptConfirmed: true };
      writeSurfRide(userId, confirmed); journal.current = confirmed;
      currentRun.current = receipt.run; setRun(receipt.run); setResult(receipt); setBalance(receipt.balance);
      // Keep the receipt's snapshot until the next successful start, for retry safety.
      void flushLearning(userId);
    } catch (error) { if (current()) setErrorCode(errorCodeOf(error)); }
    finally { if (busyRef.current === operation) { busyRef.current = null; if (alive.current) setBusy(null); } }
  };

  const retryLearning = () => { if (owner.current) void flushLearning(owner.current); };
  return { practice, accountId: owner.current, status, balance, selection, run, result, busy, errorCode,
    attempts, learningPending, learningSyncing, retryLearning, recoveredState, recoveredRunId, begin, recordAttempt, capture, settle, refresh };
}
