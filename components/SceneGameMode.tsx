import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HoverTranslationText } from './HoverTranslationText';
import { SceneImageWithRegions } from './SceneImageWithRegions';
import { SceneLeaderboardPanel } from './SceneLeaderboardPanel';
import { ClozeSentence, ClozeStatus } from './ClozeSentence';
import { LargeWordInput } from './LargeWordInput';
import { Confetti } from './Confetti';
import { playBuzzer, playCheer, playDing } from '../utils/audioFeedback';
import { SCENE_GAME_COST } from '../services/coinService';
import { CoinIcon } from './Coin/CoinIcon';
import {
  InputSession,
  SceneAsset,
  SceneCardResult,
  SceneGamePhase,
  SceneGameSummary,
  WordEntry,
} from '../types';
import {
  MAX_SCENE_WORDS,
  MIN_SCENE_WORDS,
  calculateSceneGameSummary,
  gatherWordMeta,
  getSceneCandidateWords,
  refundSceneCharge,
  requestSceneGeneration,
  requestSceneRegeneration,
  sceneDurationSeconds,
  selectSceneWords,
} from '../services/sceneGame';
import { fetchSceneTts } from '../services/sceneTts';

interface SceneGameModeProps {
  allWords: WordEntry[];
  sessions: InputSession[];
  onComplete: (summary: SceneGameSummary) => Promise<void> | void;
  onCancel: () => void;
  coinBalance?: number;
  onInsufficientCoins?: () => void;
  /** Fired after the scene charge lands (finalize) and after any refund, so the
   *  header CoinCounter can refresh. Passes the post-charge balance when known. */
  onCoinsSpent?: (newBalance?: number) => void;
  /** Optional toast hook (e.g. to confirm a refund). */
  onNotify?: (message: string, kind?: 'success' | 'warning' | 'error') => void;
}

const WORD_COUNT_KEY = 'vibe_scene_word_count';

const formatClock = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

interface WordState {
  solved: boolean;
  locked: boolean;
  attemptsUsed: number;
  activatedAtMs: number | null;
  solvedAtMs: number | null;
  revealed: boolean;
  /** Live typed input value for this row (only meaningful for the active row). */
  inputValue: string;
}

const createWordState = (): WordState => ({
  solved: false,
  locked: false,
  attemptsUsed: 0,
  activatedAtMs: null,
  solvedAtMs: null,
  revealed: false,
  inputValue: '',
});

const MONSTER_NAMES = [
  { en: 'Sunday · Warm Sun Monster', zh: '周日 · 暖阳小怪兽' },
  { en: 'Monday · Electric-Blue Monster', zh: '周一 · 电蓝小怪兽' },
  { en: 'Tuesday · Leaf-Green Monster', zh: '周二 · 翠叶小怪兽' },
  { en: 'Wednesday · Bubble Monster', zh: '周三 · 泡泡小怪兽' },
  { en: 'Thursday · Wise Purple Monster', zh: '周四 · 睿紫小怪兽' },
  { en: 'Friday · Party Pink Monster', zh: '周五 · 派对粉小怪兽' },
  { en: 'Saturday · Sloth Turquoise Monster', zh: '周六 · 树懒青小怪兽' },
];

/**
 * Detect the legacy fallback template `The word "X" is hidden in today's
 * scene — guess it from the picture.`
 *
 * Old scene_assets rows (generated before the sceneDesign.ts refactor that
 * removed `buildFallbackClozeSentence`) carry this meaningless template as
 * the sentence for words where the LLM director failed to produce a real
 * cloze. We treat such sentences as "no sentence" so:
 *   - they are NOT sent to TTS (no wasted API calls)
 *   - REVIEW shows just the word itself, not the template
 *   - PLAYING shows the "Picture only — guess word #N." placeholder
 *
 * The regex is intentionally loose (any quote style, any casing) so it
 * catches minor variations the LLM might have produced.
 */
const FALLBACK_SENTENCE_RE = /the word\s+['"]?.+['"]?\s+is hidden in today'?s scene/i;

const isFallbackSentence = (s: string | null | undefined): boolean => {
  if (!s || !s.trim()) return false;
  return FALLBACK_SENTENCE_RE.test(s.trim());
};

/**
 * Resolve the cloze sentence for a single word from the asset.
 * Falls back through:
 *   1. asset.sentences[word.toLowerCase()]  (built by normalizeAsset)
 *   2. asset.regions[word].sentence          (per-region field)
 *   3. null — the row renders in "no clue" degraded mode.
 *
 * Also returns null when the sentence is the legacy fallback template
 * (see isFallbackSentence) — those rows are treated as "picture only".
 */
const sentenceForWord = (word: WordEntry, asset: SceneAsset | null): string | null => {
  if (!asset) return null;
  const key = word.text.toLowerCase();
  const fromIndex = asset.sentences?.[key];
  if (fromIndex && fromIndex.trim() && !isFallbackSentence(fromIndex)) return fromIndex;
  const fromRegion = asset.regions.find((r) => r.word.toLowerCase() === key)?.sentence;
  if (fromRegion && fromRegion.trim() && !isFallbackSentence(fromRegion)) return fromRegion;
  // Paired (merged) word: it shares a group's sentence but has no per-word
  // entry, so look it up via clozeGroups (used by REVIEW + TTS keying).
  const fromGroup = asset.clozeGroups?.find((g) => g.words.some((w) => w.toLowerCase() === key))?.sentence;
  if (fromGroup && fromGroup.trim() && !isFallbackSentence(fromGroup)) return fromGroup;
  return null;
};

// ----------------------------------------------------------------
// REVIEW phase renders the SAME ClozeSentence component used in PLAYING
// (with status='revealed') so the user sees the exact same wording they
// tried to answer. No separate ReviewCard — keeps content + styling 1:1.
// ----------------------------------------------------------------

// ----------------------------------------------------------------
// PREPARING failure classification — maps a generation error to a
// concrete UI reason so the loading screen can tell the user whether
// the scene ORCHESTRATION (director) or the IMAGE MODEL (render) or
// the SAVE step failed, instead of a generic "failed" string.
// ----------------------------------------------------------------
type PreparingErrorStage = 'designed' | 'rendered' | 'persisted' | 'unknown';
interface PreparingError {
  /** Which checklist step to highlight red (1=orchestration, 2=render).
   *  'persisted'/'unknown' highlight no step. */
  stageKey: PreparingErrorStage;
  titleZh: string;
  titleEn: string;
  detail: string;
}

/**
 * @param reachedStage The last `preparingStage` value reached before the error
 *   (0=selecting, 1=orchestration done, 2=render done). Used to infer which leg
 *   a client-side timeout hit.
 */
const describePreparingError = (err: unknown, reachedStage: number): PreparingError => {
  const failedStage = (err as any)?.failedStage as string | undefined;
  const raw = err instanceof Error ? err.message : String(err);
  const isTimeout = /timeout after \d+ms/i.test(raw);

  if (failedStage === 'designed') {
    return {
      stageKey: 'designed',
      titleZh: '场景编排失败 — 导演模型未能生成场景',
      titleEn: 'Scene orchestration failed — the director model could not build the scene.',
      detail: raw,
    };
  }
  if (failedStage === 'rendered') {
    return {
      stageKey: 'rendered',
      titleZh: '图像生成失败 — 生图模型未能出图',
      titleEn: 'Image generation failed — the render model could not produce an image.',
      detail: raw,
    };
  }
  if (failedStage === 'persisted') {
    return {
      stageKey: 'persisted',
      titleZh: '图像保存失败 — 图片处理或上传出错',
      titleEn: 'Failed to save the image — processing or upload went wrong.',
      detail: raw,
    };
  }
  if (isTimeout) {
    // No explicit failedStage and the client timeout fired — infer the leg from
    // how far the pipeline got.
    if (reachedStage <= 1) {
      return {
        stageKey: 'designed',
        titleZh: '场景编排超时 — 导演模型响应过久，请重试',
        titleEn: 'Scene orchestration timed out — the director model took too long. Please retry.',
        detail: raw,
      };
    }
    return {
      stageKey: 'rendered',
      titleZh: '图像生成/保存超时 — 生图模型响应过久，请重试',
      titleEn: 'Image generation/save timed out — the render model took too long. Please retry.',
      detail: raw,
    };
  }
  return {
    stageKey: 'unknown',
    titleZh: '场景生成失败，请重试',
    titleEn: 'Scene generation failed. Please try again.',
    detail: raw,
  };
};

/**
 * Preload an image URL to completion (decoded and in the browser cache) before
 * we rely on it being visible. Resolves true on a successful load, false on
 * error or timeout. Works for both `data:` URLs (near-instant) and `https:`.
 *
 * The round's `<img>` only mounts in the PLAYING phase, so without preloading
 * the download doesn't even begin until the game timer starts — leaving the
 * left panel blank for the first seconds of play. We therefore await this
 * BEFORE entering COUNTDOWN, so the countdown (and thus the timer) cannot
 * start until the picture is genuinely fully loaded.
 */
const preloadSceneImage = (url: string, timeoutMs = 30000): Promise<boolean> =>
  new Promise((resolve) => {
    if (!url) {
      resolve(false);
      return;
    }
    const img = new Image();
    let settled = false;
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(ok);
    };
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = url;
  });

const SceneGameMode: React.FC<SceneGameModeProps> = ({ allWords, sessions, onComplete, onCancel, coinBalance = Infinity, onInsufficientCoins, onCoinsSpent, onNotify }) => {
  const dayIndex = new Date().getDay();
  const monsterImg = `/monsterImages/M${dayIndex}.webp`;
  const monsterName = MONSTER_NAMES[dayIndex] || MONSTER_NAMES[0];

  const [phase, setPhase] = useState<SceneGamePhase>('INTRO');
  const [wordCount, setWordCount] = useState<number>(() => {
    const stored = typeof window !== 'undefined' ? Number(window.localStorage.getItem(WORD_COUNT_KEY)) : NaN;
    return Number.isInteger(stored) && stored >= MIN_SCENE_WORDS && stored <= MAX_SCENE_WORDS ? stored : 6;
  });

  const [selectedWords, setSelectedWords] = useState<WordEntry[]>([]);
  const [selectionMode, setSelectionMode] = useState<'smart' | 'random'>('random');
  const [overlapRate, setOverlapRate] = useState(0);
  const [rankingEligible, setRankingEligible] = useState(true);
  const [rankingIneligibleReason, setRankingIneligibleReason] = useState<string | null>(null);

  const [asset, setAsset] = useState<SceneAsset | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [preparingElapsed, setPreparingElapsed] = useState(0);
  const [preparingStage, setPreparingStage] = useState(0);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [showCostConfirm, setShowCostConfirm] = useState(false);
  /** Storyboard text surfaced during PREPARING so the player can preview the
   *  scene idea before play. Mirrors the AI-authored `storyboard` field sent on
   *  the `designed` event. Reset at the start of every run. */
  const [storyboard, setStoryboard] = useState<string | null>(null);
  /** Structured PREPARING failure (orchestration vs render vs save vs timeout).
   *  When set, the PREPARING card shows a precise reason in place instead of
   *  bouncing back to INTRO with a generic error string. */
  const [preparingError, setPreparingError] = useState<PreparingError | null>(null);
  /** Soft (non-blocking) notice that the director fell back to the deterministic
   *  arrangement — gameplay still proceeds. Surfaced from the `designed` event's
   *  fallbackReason. */
  const [directorDegraded, setDirectorDegraded] = useState<string | null>(null);
  /** Refund handle for the charge that paid for the currently-displayed asset.
   *  Set when `finalize` charges (roundRef present), consumed (nulled) on a
   *  successful image load, and used to refund on an image load failure. */
  const chargeRef = useRef<{ roundRef: string; wordSetHash: string; dayIndex: number; language: string } | null>(null);

  const [countdownValue, setCountdownValue] = useState(3);
  const [timeLeft, setTimeLeft] = useState(0);

  const [wordStates, setWordStates] = useState<WordState[]>([]);
  const [activeWordIndex, setActiveWordIndex] = useState<number | null>(null);

  /** Transient status (correct/wrong) for the active row, cleared on advance. */
  const [flashStatus, setFlashStatus] = useState<'idle' | 'correct' | 'wrong'>('idle');

  const [result, setResult] = useState<SceneGameSummary | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  /** Local toggle for the PREPARING-stage storyboard card (expanded vs. collapsed). */
  const [storyboardExpanded, setStoryboardExpanded] = useState(false);

  /** Map of lowercase word → blob URL for that word's sentence TTS audio.
   *  Populated during PREPARING (parallel with image render). Empty entries
   *  mean TTS failed for that word after one retry — the speaker icon is
   *  simply hidden for that row. */
  const [sentenceAudios, setSentenceAudios] = useState<Record<string, string>>({});
  /** Progress for the "Generating audio" row in the PREPARING stage. */
  const [audioProgress, setAudioProgress] = useState<{ done: number; total: number; failed: number }>({ done: 0, total: 0, failed: 0 });
  /** Tracks every blob URL we create so we can revoke on unmount / new round. */
  const blobUrlsRef = useRef<string[]>([]);

  /** Shared <audio> element for sentence playback — owned here so it can also
   *  be triggered from the Enter key (via submitActive), not just the speaker
   *  button. Lowercase word key → "currently playing this word's audio". */
  const sharedAudioRef = useRef<HTMLAudioElement | null>(null);
  const [playingWord, setPlayingWord] = useState<string | null>(null);

  const gameStartTimeRef = useRef<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  const finalizeGuardRef = useRef(false);
  const wordStatesRef = useRef<WordState[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const finishGameRef = useRef<(timedOut: boolean) => Promise<void>>(async () => {});
  // Fix for the stale-closure bug: startPlay is invoked via setTimeout from
  // inside runGeneration (memoized via useCallback). Without a ref, startPlay
  // would capture the FIRST render's selectedWords (= []) and seed wordStates
  // with an empty array, making the input permanently empty. Reading from
  // selectedWordsRef always gives us the latest list.
  const selectedWordsRef = useRef<WordEntry[]>([]);

  useEffect(() => { wordStatesRef.current = wordStates; }, [wordStates]);
  useEffect(() => { selectedWordsRef.current = selectedWords; }, [selectedWords]);

  const candidateCount = useMemo(() => getSceneCandidateWords(allWords).length, [allWords]);
  const canPrepare = candidateCount >= MIN_SCENE_WORDS;

  const totalDuration = useMemo(
    () => sceneDurationSeconds(selectedWords.length || wordCount),
    [selectedWords.length, wordCount],
  );

  // ---------------------------------------------------------------
  // TTS prefetch — fired as soon as the `designed` event arrives with the
  // per-element sentences. Runs in parallel with the (slow) image render.
  // Never throws; failures are recorded in audioProgress.failed and the
  // speaker icon simply stays hidden for that row.
  // ---------------------------------------------------------------
  /**
   * Try once; on any failure wait 300 ms and try once more; if the retry also
   * fails, throw. Per the user's decision — one retry, then skip.
   */
  const fetchSceneTtsWithRetry = async (sentence: string): Promise<Blob> => {
    try {
      return await fetchSceneTts(sentence);
    } catch (err) {
      console.warn('[SceneGameMode] TTS first attempt failed, retrying once:', err);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return await fetchSceneTts(sentence);
    }
  };

  const prefetchSentenceAudios = useCallback(async (sentences: { word: string; sentence: string }[]) => {
    // Reset progress tracker for this round.
    setAudioProgress({ done: 0, total: sentences.length, failed: 0 });
    const results = await Promise.allSettled(
      sentences.map(({ sentence }) => fetchSceneTtsWithRetry(sentence)),
    );
    const next: Record<string, string> = {};
    let done = 0;
    let failed = 0;
    results.forEach((r, i) => {
      const { word } = sentences[i];
      if (r.status === 'fulfilled') {
        try {
          const url = URL.createObjectURL(r.value);
          blobUrlsRef.current.push(url);
          next[word] = url;
        } catch (err) {
          // createObjectURL can throw on weird environments — treat as failure.
          console.warn('[SceneGameMode] blob URL creation failed', err);
          failed += 1;
        }
      } else {
        failed += 1;
      }
      done += 1;
    });
    setSentenceAudios(next);
    setAudioProgress({ done, total: sentences.length, failed });
  }, []);

  /**
   * Play (or pause) the TTS audio for `word` via the shared <audio> element.
   *
   * - Same word + currently playing → pause.
   * - Otherwise → rewind to 0 and play (switches src if needed).
   *
   * Centralized here so BOTH the speaker button (per-row) AND the Enter key
   * (via submitActive) can trigger playback through the same element.
   */
  const playSentenceAudio = useCallback((word: string) => {
    const el = sharedAudioRef.current;
    if (!el) return;
    const key = word.toLowerCase();
    const url = sentenceAudios[key];
    if (!url) return;
    // Toggle pause if clicking the same row that's already playing.
    if (playingWord === key && !el.paused) {
      el.pause();
      return;
    }
    // Switch source when playing a different row.
    if (el.getAttribute('src') !== url) {
      el.src = url;
    }
    try { el.currentTime = 0; } catch { /* not loaded yet */ }
    const p = el.play();
    if (p && typeof p.then === 'function') {
      p.then(() => setPlayingWord(key)).catch(() => setPlayingWord(null));
    } else {
      setPlayingWord(key);
    }
  }, [sentenceAudios, playingWord]);

  // ---------------------------------------------------------------
  // PREPARING: select words + request scene generation
  // ---------------------------------------------------------------
  const runGeneration = useCallback(async (n: number, force: boolean) => {
    setGenError(null);
    setPhase('PREPARING');
    setPreparingElapsed(0);
    setPreparingStage(0);
    setAsset(null);
    setDegraded(false);
    setStoryboard(null);
    setPreparingError(null);
    setDirectorDegraded(null);
    chargeRef.current = null;
    // Reset TTS state for the new round and revoke any stale blob URLs.
    setSentenceAudios({});
    setAudioProgress({ done: 0, total: 0, failed: 0 });
    for (const url of blobUrlsRef.current) {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }
    blobUrlsRef.current = [];

    // Tracked outside the useCallback deps so the closure can mutate it
    // without triggering a re-render. The `designed` event handler kicks off
    // TTS prefetch in parallel with the image render; we then await this
    // promise before transitioning to COUNTDOWN.
    let ttsPromise: Promise<void> | null = null;
    // Local mirror of preparingStage for the catch block (the React state closure
    // is stale inside the memoized callback). Used to infer which leg a timeout hit.
    let reachedStage = 0;

    const smart = typeof window !== 'undefined' && window.localStorage.getItem('vibe_ai_selection') === 'true';
    const selection = selectSceneWords(allWords, sessions, smart, n);
    setSelectionMode(selection.selectionMode);
    setOverlapRate(selection.overlapRate);
    setRankingEligible(selection.rankingEligible);
    setRankingIneligibleReason(selection.rankingIneligibleReason || null);

    if (selection.words.length < MIN_SCENE_WORDS) {
      setGenError('Not enough words in your library to build a scene.');
      setPhase('INTRO');
      return;
    }

    setSelectedWords(selection.words);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const meta = gatherWordMeta(selection.words);
      const res = await requestSceneGeneration(
        meta,
        dayIndex,
        'en',
        controller.signal,
        {
          onStage: (stage, payload) => {
            console.log('[SceneGameMode] onStage', stage);
            if (stage === 'designed') {
              reachedStage = 1;
              setPreparingStage(1);
              // Capture the AI-authored storyboard (or fallback storyboard) for
              // the PREPARING stage preview card.
              const sb = typeof payload?.storyboard === 'string' ? payload.storyboard.trim() : '';
              if (sb) setStoryboard(sb);
              // Soft (non-blocking) notice when the director degraded to the
              // deterministic fallback. Not a failure — gameplay proceeds.
              const fr = typeof payload?.fallbackReason === 'string' ? payload.fallbackReason.trim() : '';
              setDirectorDegraded(fr || null);
              // Kick off parallel TTS prefetch as soon as we have sentences.
              // The image render (stage 'rendered' → 'done') is slow, so TTS
              // usually finishes first; we still await ttsPromise below
              // before transitioning to COUNTDOWN.
              const sentences = Array.isArray(payload?.elements)
                ? (payload.elements as any[])
                    .map((e) => ({ word: String(e.word || '').toLowerCase(), sentence: String(e.sentence || '').trim() }))
                    .filter((x) => x.word && x.sentence)
                : [];
              if (sentences.length) {
                ttsPromise = prefetchSentenceAudios(sentences);
              }
            } else if (stage === 'rendered') {
              reachedStage = 2;
              setPreparingStage(2);
            }
          },
        },
      );
      if (controller.signal.aborted) return;
      console.log('[SceneGameMode] asset received', { source: res.source, imageUrl: res.asset.imageUrl, regionCount: res.asset.regions.length });
      setAsset(res.asset);
      setDegraded(res.degraded);
      // Kick the image download into the browser cache the INSTANT its URL is
      // known — in parallel with TTS prefetch and the charge bookkeeping below
      // — so by the time we reach the 3-2-1 countdown the picture is already
      // local and renders instantly when PLAYING mounts the <img>.
      const imgLoadPromise = preloadSceneImage(res.asset.imageUrl);
      // Option C: the charge landed inside `finalize`. Stash the refund handle
      // (consumed on first successful image load, refunded on load failure) and
      // refresh the header balance. A cache hit has no commitRef (free) — leave
      // any prior chargeRef untouched so a regenerated-then-replayed asset can
      // still be refunded if it fails to load.
      if (res.commitRef) {
        chargeRef.current = {
          roundRef: res.commitRef,
          wordSetHash: res.asset.wordSetHash,
          dayIndex: res.asset.dayIndex,
          language: res.asset.language,
        };
      }
      if (res.newBalance !== undefined) onCoinsSpent?.(res.newBalance);
      // Wait for TTS to finish before COUNTDOWN. Usually already done since
      // image gen is the slow leg — but never block gameplay on TTS failure
      // (prefetchSentenceAudios never throws).
      if (ttsPromise) {
        try { await ttsPromise; } catch { /* unreachable — prefetch never throws */ }
      }
      // The image preload was started the moment the asset URL arrived, in
      // parallel with TTS — so by now it is almost always already in the
      // browser cache. Await it as the final gate before COUNTDOWN: the 3-2-1
      // (and thus the timer) must not start until the picture is genuinely local.
      const imgLoaded = await imgLoadPromise;
      if (controller.signal.aborted) return;
      if (!imgLoaded) {
        // Generation succeeded but the image wouldn't render. Refund the charge
        // (it was deducted at finalize) and surface the failure in PREPARING
        // instead of starting a blind round with a blank panel.
        handleImageError();
        setPreparingError({
          stageKey: 'rendered',
          titleZh: '画面加载失败 — 图片未能成功加载，已自动退款，请重试',
          titleEn: 'The scene image failed to load. Your coins were refunded. Please retry.',
          detail: '',
        });
        return;
      }
      // No MODE_SELECT any more — go straight to COUNTDOWN → PLAYING.
      setPhase('COUNTDOWN');
      setCountdownValue(3);
      if (countdownTimerRef.current) window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = window.setInterval(() => {
        setCountdownValue((current) => {
          if (current <= 1) {
            if (countdownTimerRef.current) window.clearInterval(countdownTimerRef.current);
            window.setTimeout(() => startPlay(), 250);
            return 0;
          }
          return current - 1;
        });
      }, 900);
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error('[SceneGameMode] generation failed', err);
      // Edge function coin gate: surface the insufficient-coins modal
      // instead of a generic error string.
      const code = (err as any)?.code;
      if (code === 'insufficient_balance') {
        onInsufficientCoins?.();
        setPhase('INTRO');
        return;
      }
      // Stay in PREPARING and surface a precise failure reason (orchestration vs
      // render vs save vs timeout) — no coins were charged, so there is nothing
      // to refund; the Retry button re-runs generation with the same word count.
      setPreparingError(describePreparingError(err, reachedStage));
    }
  }, [allWords, sessions, dayIndex, prefetchSentenceAudios, onCoinsSpent]);

  useEffect(() => {
    if (phase !== 'PREPARING') return;
    const start = Date.now();
    const t = window.setInterval(() => {
      setPreparingElapsed(Math.floor((Date.now() - start) / 1000));
    }, 500);
    return () => window.clearInterval(t);
  }, [phase]);

  // PLAYING image-load outcomes drive the charge (option C): a successful load
  // "consumes" the refund handle (the user saw what they paid for); a load
  // failure refunds it. Both are no-ops when there is no pending charge (cache
  // hit / already consumed). chargeRef is set fresh on each finalize and cleared
  // on first load, so a non-null value always corresponds to the asset currently
  // on screen.
  const handleImageLoaded = useCallback(() => {
    chargeRef.current = null;
  }, []);

  const handleImageError = useCallback(() => {
    const c = chargeRef.current;
    if (!c) return;
    chargeRef.current = null; // one refund per charge
    void (async () => {
      try {
        const r = await refundSceneCharge(c.roundRef, c.wordSetHash, c.dayIndex, c.language);
        if (r.ok && r.refunded) {
          onNotify?.('图片加载失败，已自动退还 25 金币', 'warning');
        } else if (!r.ok) {
          console.error('[SceneGameMode] refundSceneCharge failed:', r.code);
          onNotify?.('图片加载失败，自动退款未成功，请联系客服', 'error');
        }
        if (r.newBalance !== undefined) onCoinsSpent?.(r.newBalance);
        else onCoinsSpent?.();
      } catch (e) {
        console.error('[SceneGameMode] refundSceneCharge exception:', e);
      }
    })();
  }, [onNotify, onCoinsSpent]);

  const beginScene = () => {
    if (!canPrepare) return;
    // Client-side pre-gate: fast UX feedback before hitting the server.
    // Skip when coinBalance < 0 (wallet still loading) — the edge function's
    // server-side gate is authoritative and will catch a true insufficiency.
    if (coinBalance >= 0 && coinBalance < SCENE_GAME_COST) {
      onInsufficientCoins?.();
      return;
    }
    // Show the cost confirmation dialog before spending coins.
    setShowCostConfirm(true);
  };

  const confirmSceneStart = () => {
    setShowCostConfirm(false);
    const n = Math.min(Math.max(wordCount, MIN_SCENE_WORDS), Math.min(MAX_SCENE_WORDS, candidateCount));
    void runGeneration(n, false);
  };

  const regenerateImage = async () => {
    if (!selectedWords.length || isRegenerating) return;
    setIsRegenerating(true);
    setGenError(null);
    setPhase('PREPARING');
    setPreparingElapsed(0);
    setPreparingStage(0);
    setStoryboard(null);
    setPreparingError(null);
    setDirectorDegraded(null);
    chargeRef.current = null;
    let reachedStage = 0;
    try {
      const meta = gatherWordMeta(selectedWords);
      const res = await requestSceneRegeneration(meta, dayIndex, 'en', undefined, {
        onStage: (stage, payload) => {
          if (stage === 'designed') {
            reachedStage = 1;
            setPreparingStage(1);
            const sb = typeof payload?.storyboard === 'string' ? payload.storyboard.trim() : '';
            if (sb) setStoryboard(sb);
            const fr = typeof payload?.fallbackReason === 'string' ? payload.fallbackReason.trim() : '';
            setDirectorDegraded(fr || null);
          } else if (stage === 'rendered') {
            reachedStage = 2;
            setPreparingStage(2);
          }
        },
      });
      setAsset(res.asset);
      setDegraded(res.degraded);
      // Regeneration charges at finalize too (new roundRef). Stash the refund
      // handle + refresh the header.
      if (res.commitRef) {
        chargeRef.current = {
          roundRef: res.commitRef,
          wordSetHash: res.asset.wordSetHash,
          dayIndex: res.asset.dayIndex,
          language: res.asset.language,
        };
      }
      if (res.newBalance !== undefined) onCoinsSpent?.(res.newBalance);
      // After regeneration, return to INTRO so the player can press LOAD SCENE
      // again to start the round (no mode select any more).
      setPhase('INTRO');
    } catch (err) {
      const code = (err as any)?.code;
      if (code === 'insufficient_balance') {
        onInsufficientCoins?.();
        setPhase('INTRO');
      } else {
        // Mirror runGeneration: show a precise PREPARING failure reason in place.
        setPreparingError(describePreparingError(err, reachedStage));
      }
    } finally {
      setIsRegenerating(false);
    }
  };

  // ---------------------------------------------------------------
  // startPlay — called from COUNTDOWN completion
  // ---------------------------------------------------------------
  const startPlay = () => {
    finalizeGuardRef.current = false;
    // Read selectedWords from the ref, NOT the closure variable — this
    // function is invoked via setTimeout from inside runGeneration
    // (useCallback memoized), so the closure's `selectedWords` may be stale.
    const words = selectedWordsRef.current;
    const states = words.map((w, i) => {
      const s = createWordState();
      if (i === 0) s.activatedAtMs = 0;
      return s;
    });
    setWordStates(states);
    wordStatesRef.current = states;
    setActiveWordIndex(0);
    setFlashStatus('idle');
    gameStartTimeRef.current = Date.now();
    setTimeLeft(sceneDurationSeconds(words.length));
    setPhase('PLAYING');
  };

  // ---------------------------------------------------------------
  // Game timer
  // ---------------------------------------------------------------
  useEffect(() => {
    if (phase !== 'PLAYING') return;
    const timer = window.setInterval(() => {
      if (gameStartTimeRef.current == null) return;
      const elapsedSeconds = Math.floor((Date.now() - gameStartTimeRef.current) / 1000);
      const next = Math.max(totalDuration - elapsedSeconds, 0);
      setTimeLeft(next);
      if (next <= 0) {
        window.clearInterval(timer);
        void finishGameRef.current(true);
      }
    }, 250);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, totalDuration]);

  // ---------------------------------------------------------------
  // Active-row input + submit
  // ---------------------------------------------------------------
  const activeWord = activeWordIndex != null ? selectedWords[activeWordIndex] : null;
  const activeInput = activeWordIndex != null ? wordStates[activeWordIndex]?.inputValue || '' : '';

  const setActiveInput = useCallback((value: string) => {
    if (activeWordIndex == null) return;
    setWordStates((prev) => {
      const copy = prev.map((s, i) => (i === activeWordIndex ? { ...s, inputValue: value } : s));
      wordStatesRef.current = copy;
      return copy;
    });
  }, [activeWordIndex]);

  // ----------------------------------------------------------------
  // Cloze ROWS — render by group, navigate by word.
  //
  // `asset.clozeGroups` carries one row per sentence; a 2-word group is a
  // merged pair (one row, two blanks). We keep `activeWordIndex`/`wordStates`
  // PER WORD (so scoring/timing are unchanged), but RENDER one ClozeSentence per
  // group. Words not in any group (picture-only) render as solo 1-blank rows.
  // ----------------------------------------------------------------
  const clozeRows = useMemo(() => {
    const groups = asset?.clozeGroups || [];
    const indexByText = new Map<string, number>();
    selectedWords.forEach((w, i) => {
      const k = w.text.toLowerCase();
      if (!indexByText.has(k)) indexByText.set(k, i);
    });
    // Assign each selectedWord index to the first group that claims it.
    const groupOf = new Array(selectedWords.length).fill(-1);
    const groupRows: { sentence: string; indices: number[] }[] = [];
    groups.forEach((g) => {
      const indices: number[] = [];
      g.words.forEach((w) => {
        const wi = indexByText.get(String(w).toLowerCase());
        if (typeof wi === 'number' && groupOf[wi] === -1) {
          groupOf[wi] = groupRows.length;
          indices.push(wi);
        }
      });
      if (indices.length > 0) groupRows.push({ sentence: g.sentence, indices });
    });
    // Build the render list in selectedWords order (a group renders at the
    // position of its earliest word).
    type Row =
      | { kind: 'group'; sentence: string; indices: number[] }
      | { kind: 'solo'; index: number };
    const rows: Row[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < selectedWords.length; i++) {
      if (seen.has(i)) continue;
      const gi = groupOf[i];
      if (gi >= 0) {
        const gr = groupRows[gi];
        rows.push({ kind: 'group', sentence: gr.sentence, indices: gr.indices });
        gr.indices.forEach((wi) => seen.add(wi));
      } else {
        rows.push({ kind: 'solo', index: i });
        seen.add(i);
      }
    }
    return { rows, groupOf, groupRows };
  }, [asset?.clozeGroups, selectedWords]);

  const statusForWord = useCallback((wi: number): ClozeStatus => {
    const s = wordStates[wi];
    if (!s) return 'idle';
    if (s.solved) return 'correct';
    if (wi === activeWordIndex) {
      return flashStatus === 'correct' ? 'correct' : flashStatus === 'wrong' ? 'wrong' : 'active';
    }
    if (s.revealed) return 'revealed';
    return 'idle';
  }, [wordStates, activeWordIndex, flashStatus]);

  const wordIsVisible = (wi: number): boolean => {
    const s = wordStates[wi];
    return !!(s && (s.solved || s.revealed));
  };

  // ---------------------------------------------------------------
  // Move active row up / down
  // ---------------------------------------------------------------
  const moveToIndex = useCallback((next: number) => {
    if (next < 0 || next >= selectedWords.length) return;
    const now = gameStartTimeRef.current ? Date.now() - gameStartTimeRef.current : 0;
    setWordStates((prev) => {
      // Stamp activation time on the row we're leaving ONLY if it has none yet
      // (so we don't reset its timer when re-entering).
      const copy = prev.map((s, i) => {
        if (i === next) return { ...s, activatedAtMs: s.activatedAtMs ?? now };
        return s;
      });
      wordStatesRef.current = copy;
      return copy;
    });
    setActiveWordIndex(next);
    setFlashStatus('idle');
  }, [selectedWords.length]);

  const advance = useCallback(() => {
    if (activeWordIndex == null) return;
    // Prefer the next unsolved word IN THE SAME GROUP — so filling blank 1 of a
    // two-blank row auto-advances to blank 2 of the same row (owner-approved UX).
    const gi = clozeRows.groupOf[activeWordIndex];
    if (gi >= 0) {
      const sameGroup = clozeRows.groupRows[gi]?.indices || [];
      for (const wi of sameGroup) {
        const s = wordStatesRef.current[wi];
        if (wi !== activeWordIndex && s && !s.solved && !s.locked) { moveToIndex(wi); return; }
      }
    }
    // Pick the next non-locked, non-solved row. If none, finish.
    let next = -1;
    for (let i = activeWordIndex + 1; i < selectedWords.length; i++) {
      const s = wordStatesRef.current[i];
      if (s && !s.solved && !s.locked) { next = i; break; }
    }
    if (next === -1) {
      // Try from the beginning (some earlier row may still be playable).
      for (let i = 0; i < activeWordIndex; i++) {
        const s = wordStatesRef.current[i];
        if (s && !s.solved && !s.locked) { next = i; break; }
      }
    }
    if (next === -1) {
      void finishGameRef.current(false);
      return;
    }
    moveToIndex(next);
  }, [activeWordIndex, selectedWords.length, moveToIndex, clozeRows]);

  const submitActive = useCallback(() => {
    if (activeWordIndex == null || phase !== 'PLAYING') return;
    const current = wordStatesRef.current[activeWordIndex];
    if (!current || current.solved || current.locked || timeLeft <= 0) return;

    const guess = current.inputValue.trim().toLowerCase().replace(/\s+/g, ' ');
    const answer = selectedWords[activeWordIndex].text.trim().toLowerCase().replace(/\s+/g, ' ');
    const nextAttempts = current.attemptsUsed + 1;
    const now = gameStartTimeRef.current ? Date.now() - gameStartTimeRef.current : 0;

    if (guess === answer) {
      playDing();
      setFlashStatus('correct');
      // Reflect the canonical answer in the input so the slots display the
      // correct letters before we advance.
      setWordStates((prev) => {
        const copy = prev.map((s, i) => (i === activeWordIndex
          ? { ...s, solved: true, locked: true, attemptsUsed: nextAttempts, solvedAtMs: now, inputValue: selectedWords[activeWordIndex].text }
          : s));
        wordStatesRef.current = copy;
        return copy;
      });
      window.setTimeout(advance, 800);
      return;
    }

    playBuzzer();
    setFlashStatus('wrong');
    const willLock = nextAttempts >= 3;
    setWordStates((prev) => {
      const copy = prev.map((s, i) => (i === activeWordIndex
        ? { ...s, attemptsUsed: nextAttempts, locked: willLock, revealed: willLock }
        : s));
      wordStatesRef.current = copy;
      return copy;
    });
    window.setTimeout(() => {
      // Clear input only if the row is still active (i.e. not locked).
      if (!willLock) {
        setWordStates((prev) => {
          const copy = prev.map((s, i) => (i === activeWordIndex ? { ...s, inputValue: '' } : s));
          wordStatesRef.current = copy;
          return copy;
        });
      }
      setFlashStatus('idle');
      if (willLock) advance();
    }, 600);
  }, [activeWordIndex, phase, timeLeft, selectedWords, advance]);

  // ---------------------------------------------------------------
  // Global keyboard handler — ArrowUp/ArrowDown for row navigation,
  // Space for "play active sentence audio". Letter/Backspace/Enter
  // input is handled natively by LargeWordInput's <input> (so focus,
  // mobile keyboards, IME, etc. all work).
  // ---------------------------------------------------------------
  useEffect(() => {
    if (phase !== 'PLAYING') return;
    const onKey = (e: KeyboardEvent) => {
      // Space → play active sentence audio (prevents typing a literal space
      // into the input, since target words in this game are single tokens).
      if (e.key === ' ' || e.code === 'Space') {
        if (activeWordIndex == null) return;
        const word = selectedWords[activeWordIndex];
        if (!word) return;
        e.preventDefault();
        playSentenceAudio(word.text);
        return;
      }
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (activeWordIndex == null) return;
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      // Find next playable row in this direction (skip solved/locked).
      let idx = activeWordIndex + dir;
      while (idx >= 0 && idx < selectedWords.length) {
        const s = wordStatesRef.current[idx];
        if (s && !s.solved && !s.locked) {
          moveToIndex(idx);
          return;
        }
        idx += dir;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, activeWordIndex, selectedWords, moveToIndex, playSentenceAudio]);

  // ---------------------------------------------------------------
  // finishGame
  // ---------------------------------------------------------------
  const finishGame = useCallback(async (timedOut: boolean) => {
    if (finalizeGuardRef.current) return;
    finalizeGuardRef.current = true;

    const now = Date.now();
    const elapsedMs = gameStartTimeRef.current ? now - gameStartTimeRef.current : (totalDuration - timeLeft) * 1000;
    const states = wordStatesRef.current;

    const results: SceneCardResult[] = selectedWords.map((word, i) => {
      const s = states[i] || createWordState();
      const isRevealed = timedOut && !s.solved;
      return {
        wordId: word.id,
        wordText: word.text,
        correct: s.solved && !isRevealed,
        attemptsUsed: s.attemptsUsed,
        hintUsed: false,
        solvedAtMs: s.solvedAtMs,
        activatedAtMs: s.activatedAtMs,
      };
    });

    const summary = calculateSceneGameSummary({
      results,
      elapsedMs,
      selectionMode,
      dayIndex,
      wordCount: selectedWords.length,
      overlapRate,
      rankingEligible,
      rankingIneligibleReason,
      sceneAssetId: asset?.id || null,
    });

    setWordStates((prev) => prev.map((s) => (s.solved ? s : { ...s, revealed: true })));

    // Always go to REVIEW first — the user wants to recap every round, whether
    // all-correct or not. Score is recorded only when the user advances from
    // REVIEW → RESULT via proceedToResult (avoids a spoiler notification
    // during the recap).
    setResult(summary);
    setPhase('REVIEW');
  }, [selectedWords, selectionMode, dayIndex, overlapRate, rankingEligible, rankingIneligibleReason, asset, totalDuration, timeLeft, onComplete]);

  /** Advance from REVIEW → RESULT and record the score. */
  const proceedToResult = async () => {
    if (!result) return;
    setPhase('RESULT');
    setIsSubmitting(true);
    try {
      await onComplete(result);
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * Replay the SAME scene (same asset, same words, same cached TTS audio).
   *
   * - Keeps: `asset`, `selectedWords`, `sentenceAudios` (blob URLs still valid)
   * - Resets: `wordStates`, `activeWordIndex`, `result`, `flashStatus`,
   *   `finalizeGuardRef`
   * - Skips PREPARING entirely (asset is already loaded) → COUNTDOWN → PLAYING
   *
   * The current round's score is NOT recorded — if the user is in REVIEW,
   * proceeding to RESULT never happened, so `onComplete` was never called.
   * If the user is in RESULT, the score was already recorded; the replay
   * will record a NEW score when the user eventually advances from REVIEW →
   * RESULT again. This is the "score keeps refreshing" behavior: each replay
   * is a fresh attempt at the same scene, and each completed attempt writes
   * a new row to the leaderboard.
   */
  const replaySameScene = async () => {
    // Stop any audio that's currently playing.
    if (sharedAudioRef.current) {
      sharedAudioRef.current.pause();
      try { sharedAudioRef.current.currentTime = 0; } catch { /* not loaded */ }
    }
    setPlayingWord(null);

    // Reset round state — but keep asset, selectedWords, and sentenceAudios.
    setResult(null);
    setWordStates([]);
    wordStatesRef.current = [];
    setActiveWordIndex(null);
    setFlashStatus('idle');
    finalizeGuardRef.current = false;

    // Same gate as the fresh-generation path: ensure the image is actually
    // loaded before countdown. On replay the browser usually has it cached, so
    // this resolves near-instantly; if it was evicted and won't reload, don't
    // start a blind round with a blank panel.
    const replayUrl = asset?.imageUrl;
    if (replayUrl && !(await preloadSceneImage(replayUrl))) {
      onNotify?.('画面重新加载失败，请重试', 'error');
      return;
    }
    // Jump straight to COUNTDOWN — no PREPARING since the asset is already loaded.
    setPhase('COUNTDOWN');
    setCountdownValue(3);
    if (countdownTimerRef.current) window.clearInterval(countdownTimerRef.current);
    countdownTimerRef.current = window.setInterval(() => {
      setCountdownValue((current) => {
        if (current <= 1) {
          if (countdownTimerRef.current) window.clearInterval(countdownTimerRef.current);
          window.setTimeout(() => startPlay(), 250);
          return 0;
        }
        return current - 1;
      });
    }, 900);
  };

  useEffect(() => { finishGameRef.current = finishGame; });

  // Auto-finish when every row is solved or locked.
  useEffect(() => {
    if (phase !== 'PLAYING') return;
    if (!wordStates.length) return;
    if (wordStates.every((s) => s.solved || s.locked)) {
      void finishGameRef.current(false);
    }
  }, [wordStates, phase]);

  // Cleanup
  useEffect(() => () => {
    if (countdownTimerRef.current) window.clearInterval(countdownTimerRef.current);
    abortRef.current?.abort();
    // Revoke any blob URLs we created so the browser can free the memory.
    for (const url of blobUrlsRef.current) {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }
    blobUrlsRef.current = [];
  }, []);

  const solvedCount = useMemo(() => wordStates.filter((s) => s.solved).length, [wordStates]);

  const summaryCards = result
    ? [
        { labelEn: 'Total Score', labelZh: '总分', value: Math.round(result.totalScore) },
        { labelEn: 'Accuracy', labelZh: '正确率', value: `${Math.round(result.accuracyRate * 100)}%` },
        { labelEn: 'Time Used', labelZh: '用时', value: `${result.timeUsedSeconds}s` },
        { labelEn: 'Solved', labelZh: '答对', value: `${result.wordsCorrect}/${result.wordsTotal}` },
      ]
    : [];

  return (
    <div className="fixed inset-0 z-[90] overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(168,85,247,0.14),_transparent_30%),linear-gradient(180deg,_rgba(9,12,16,0.96),_rgba(12,14,18,1))]">
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(180deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:26px_26px] opacity-30" />

      {phase === 'RESULT' && result && (
        <Confetti variant="purple" title="Scene Complete" subtitle="完形填空完成" />
      )}

      {/* Shared <audio> element for sentence TTS playback. Owned here so the
          speaker button (per-row) and the Space key (in PLAYING) both drive
          the same element, and the icon state stays in sync. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={sharedAudioRef}
        preload="auto"
        onEnded={() => setPlayingWord(null)}
        onPause={() => setPlayingWord(null)}
        onPlay={() => { /* playingWord set by playSentenceAudio for correctness */ }}
      />

      <div className="relative flex h-[100dvh] flex-col px-4 pb-4 pt-20 md:px-8 md:pb-6 md:pt-24">
        <div className="sticky top-16 z-30 mb-4 flex shrink-0 items-start justify-between gap-4 bg-[linear-gradient(180deg,rgba(12,14,18,0.94),rgba(12,14,18,0.72),transparent)] pb-3 backdrop-blur-sm">
          <div>
            <div className="font-mono text-xs uppercase tracking-[0.35em] text-purple-400/80">OPTION 4</div>
            <h2 className="font-headline text-3xl text-white md:text-4xl">
              <HoverTranslationText text="Scene Fusion Game" translation="场景融合游戏" />
            </h2>
          </div>
          <button
            onClick={onCancel}
            className="rounded-2xl border border-mid-charcoal bg-dark-charcoal/70 px-4 py-2 font-mono text-xs uppercase tracking-[0.25em] text-text-light transition-colors hover:border-white hover:text-white"
          >
            <HoverTranslationText text="Exit" translation="退出" />
          </button>
        </div>

        {/* ---------------- INTRO ---------------- */}
        {phase === 'INTRO' && (
          <div className="flex flex-1 items-center justify-center overflow-y-auto py-2">
            <div className="w-full max-w-3xl rounded-[32px] border border-mid-charcoal bg-dark-charcoal/80 p-8 shadow-2xl backdrop-blur-md md:p-10">
              <div className="grid gap-8 md:grid-cols-[1.15fr_0.85fr]">
                <div className="space-y-5">
                  <p className="max-w-2xl text-sm leading-7 text-text-light md:text-base">
                    <HoverTranslationText
                      text="Pick 5-10 words. AI fuses them into ONE isometric cartoon scene with today's monster and writes a cloze sentence per word. All sentences appear on the right — use ↑/↓ or click to switch. Fill the blank for each one."
                      translation="挑选 5-10 个单词，AI 把它们融合成一张等轴透视卡通场景图（含当日小怪兽），并为每个单词生成一句填空描述。右侧会显示全部句子，用 ↑/↓ 键或点击切换。把每个句子中挖空的词填出来。"
                    />
                  </p>

                  <div>
                    <div className="mb-2 font-mono text-xs uppercase tracking-[0.3em] text-text-dark">
                      <HoverTranslationText text="Word Count" translation="单词数量" />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {Array.from({ length: MAX_SCENE_WORDS - MIN_SCENE_WORDS + 1 }, (_, i) => MIN_SCENE_WORDS + i).map((n) => (
                        <button
                          key={n}
                          onClick={() => { setWordCount(n); window.localStorage.setItem(WORD_COUNT_KEY, String(n)); }}
                          disabled={n > candidateCount}
                          className={`h-11 w-11 rounded-2xl border font-headline text-lg transition-colors ${
                            wordCount === n
                              ? 'border-purple-400 bg-purple-500/15 text-purple-300'
                              : n > candidateCount
                                ? 'cursor-not-allowed border-mid-charcoal/50 bg-mid-charcoal/30 text-text-dark/50'
                                : 'border-mid-charcoal bg-light-charcoal/20 text-text-light hover:border-purple-400/50'
                          }`}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-3xl border border-mid-charcoal bg-light-charcoal/30 p-4">
                    <div className="font-mono text-xs uppercase tracking-[0.3em] text-text-dark"><HoverTranslationText text="Cloze Round" translation="完形填空" /></div>
                    <div className="mt-2 font-headline text-xl text-white">{wordCount}×30s</div>
                    <div className="mt-1 text-[11px] text-text-dark">
                      <HoverTranslationText
                        text="One picture + N sentences. Switch rows with ↑/↓, click, or just type."
                        translation="一张图 + N 个句子。用 ↑/↓ 键、鼠标点击或直接输入切换句子。"
                      />
                    </div>
                  </div>
                </div>

                <div className="rounded-[28px] border border-purple-400/25 bg-[linear-gradient(180deg,rgba(168,85,247,0.12),rgba(168,85,247,0.03))] p-6">
                  <div className="flex items-center gap-3">
                    <img src={monsterImg} alt="monster" className="h-14 w-14 rounded-2xl border border-mid-charcoal object-cover" />
                    <div>
                      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-purple-400/70"><HoverTranslationText text="Today's Monster Theme" translation="今日小怪兽主题" /></div>
                      <div className="mt-1 text-sm text-white"><HoverTranslationText text={monsterName.en} translation={monsterName.zh} /></div>
                    </div>
                  </div>
                  <div className="mt-4 text-sm leading-7 text-text-light">
                    <HoverTranslationText
                      text={`Available words: ${candidateCount}. Need at least ${MIN_SCENE_WORDS} to start.`}
                      translation={`当前可用单词：${candidateCount}。至少需要 ${MIN_SCENE_WORDS} 个才能开始。`}
                    />
                  </div>
                  <button
                    onClick={beginScene}
                    disabled={!canPrepare}
                    className={`mt-6 w-full rounded-2xl px-5 py-4 font-headline text-sm uppercase tracking-[0.3em] transition-all ${
                      canPrepare
                        ? 'bg-purple-500 text-white hover:-translate-y-1 hover:shadow-[0_0_30px_rgba(168,85,247,0.3)]'
                        : 'cursor-not-allowed bg-mid-charcoal text-text-dark'
                    }`}
                  >
                    <span className="inline-flex items-center gap-2">
                      <HoverTranslationText text="Load Scene" translation="生成场景" />
                      <span className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-black/30 px-2 py-0.5 text-xs tracking-normal opacity-90">
                        <CoinIcon fontSize="14px" /> {SCENE_GAME_COST}
                      </span>
                    </span>
                  </button>
                  {!canPrepare && (
                    <div className="mt-3 font-mono text-xs text-red-300">
                      <HoverTranslationText text="Add at least 5 words to unlock this mode." translation="请先添加至少 5 个单词以解锁此模式。" />
                    </div>
                  )}
                  {genError && (
                    <div className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">{genError}</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ---------------- COST CONFIRMATION DIALOG ---------------- */}
        {showCostConfirm && (
          <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setShowCostConfirm(false)}></div>
            <div className="relative bg-dark-charcoal border-2 border-amber-400/50 rounded-3xl p-8 max-w-sm w-full text-center shadow-[0_0_40px_rgba(251,191,36,0.2)]">
              <div className="mb-3 flex justify-center"><CoinIcon fontSize="40px" /></div>
              <h2 className="text-lg font-headline tracking-wide text-amber-300 mb-2 uppercase">
                <HoverTranslationText text="Confirm Spend" translation="确认消费" />
              </h2>
              <p className="text-text-light text-sm leading-relaxed mb-5">
                <HoverTranslationText
                  text={`Starting this scene costs ${SCENE_GAME_COST} coins.`}
                  translation={`开始场景模式将消耗 ${SCENE_GAME_COST} 金币。`}
                />
              </p>
              {coinBalance >= 0 && (
                <div className="mb-5 space-y-1 font-mono text-xs">
                  <div className="flex justify-between text-text-light/70">
                    <span><HoverTranslationText text="Current balance" translation="当前余额" /></span>
                    <span className="inline-flex items-center gap-1 text-amber-300"><CoinIcon fontSize="14px" /> {coinBalance}</span>
                  </div>
                  <div className="flex justify-between text-text-light/70">
                    <span><HoverTranslationText text="After this round" translation="结束后剩余" /></span>
                    <span className="inline-flex items-center gap-1 text-amber-300/70"><CoinIcon fontSize="14px" /> {coinBalance - SCENE_GAME_COST}</span>
                  </div>
                </div>
              )}
              <div className="flex gap-3">
                <button
                  onClick={() => setShowCostConfirm(false)}
                  className="flex-1 rounded-xl border border-mid-charcoal bg-mid-charcoal/50 px-4 py-3 font-headline text-xs uppercase tracking-[0.2em] text-text-light hover:bg-mid-charcoal transition-colors"
                >
                  <HoverTranslationText text="Cancel" translation="取消" />
                </button>
                <button
                  onClick={confirmSceneStart}
                  className="flex-1 rounded-xl bg-purple-500 px-4 py-3 font-headline text-xs uppercase tracking-[0.2em] text-white hover:-translate-y-0.5 hover:shadow-[0_0_20px_rgba(168,85,247,0.4)] transition-all"
                >
                  <HoverTranslationText text="Start" translation="开始" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ---------------- PREPARING ---------------- */}
        {phase === 'PREPARING' && (
          <div className="flex flex-1 items-center justify-center">
            <div className="w-full max-w-xl rounded-[32px] border border-mid-charcoal bg-dark-charcoal/80 p-8 text-center shadow-2xl backdrop-blur-md md:p-10">
              <div className="inline-flex rounded-full border border-purple-400/30 bg-purple-500/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.3em] text-purple-300">
                <HoverTranslationText text="Building Your Scene" translation="正在构建场景" />
              </div>
              <h3 className="mt-6 font-headline text-2xl text-white md:text-3xl">
                <HoverTranslationText text="Fusing words into one scene" translation="把单词融合进同一张图" />
              </h3>
              {/* Soft (non-blocking) notice: the director degraded to the fallback
                  arrangement. Gameplay still proceeds normally — this is NOT a failure. */}
              {directorDegraded && !preparingError && (
                <div className="mx-auto mt-4 max-w-md rounded-2xl border border-amber-400/40 bg-amber-500/10 px-4 py-2 text-left text-[12px] leading-5 text-amber-200">
                  <HoverTranslationText
                    text="The director model degraded — using a fallback scene arrangement. Gameplay is unaffected."
                    translation="导演模型降级，已使用兜底场景编排（玩法不受影响）。"
                  />
                </div>
              )}
              <div className="mx-auto mt-6 max-w-md space-y-2.5 text-left">
                {([
                  { stage: 0, icon: 'checklist', en: 'Selecting words', zh: '抽取单词', hint: 'Smart/random pick from your library' },
                  { stage: 1, icon: 'auto_awesome', en: 'Designing scene', zh: '场景导演构思', hint: 'LLM arranges words into one scene + prompt' },
                  { stage: 2, icon: 'image', en: 'Rendering image', zh: '渲染场景图', hint: 'Image model draws the isometric scene' },
                ] as const).map((step) => {
                  const done = preparingStage > step.stage;
                  const active = preparingStage === step.stage;
                  // Highlight the failed step red (1=orchestration, 2=render) so
                  // the user can see at a glance whether 编排 or 生图 broke.
                  const failed = preparingError
                    ? (preparingError.stageKey === 'designed' && step.stage === 1)
                      || (preparingError.stageKey === 'rendered' && step.stage === 2)
                    : false;
                  return (
                    <div
                      key={step.stage}
                      className={`flex items-center gap-3 rounded-2xl border px-4 py-3 transition-all duration-300 ${
                        failed
                          ? 'border-red-500/60 bg-red-500/10'
                          : active
                            ? 'border-purple-400/50 bg-purple-500/10'
                            : done
                              ? 'border-green-500/30 bg-green-500/5'
                              : 'border-mid-charcoal bg-light-charcoal/10 opacity-50'
                      }`}
                    >
                      <span className={`material-symbols-outlined text-xl ${failed ? 'text-red-400' : active ? 'animate-spin text-purple-300' : done ? 'text-green-400' : 'text-text-dark'}`}>
                        {failed ? 'error' : done ? 'check_circle' : step.icon}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className={`text-sm font-medium ${failed ? 'text-red-200' : active ? 'text-white' : done ? 'text-text-light' : 'text-text-dark'}`}>
                          <HoverTranslationText text={step.en} translation={step.zh} />
                        </div>
                        <div className="truncate text-[11px] text-text-dark">{step.hint}</div>
                      </div>
                      {failed ? (
                        <span className="font-mono text-[11px] uppercase tracking-widest text-red-400">
                          <HoverTranslationText text="failed" translation="失败" />
                        </span>
                      ) : active ? (
                        <span className="font-mono text-[11px] uppercase tracking-widest text-purple-300">
                          <HoverTranslationText text="working" translation="进行中" />
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {/* Failure panel — shown in place (we stay in PREPARING on failure
                  rather than bouncing to INTRO). Names the broken leg (orchestration
                  vs render vs save vs timeout) and offers Retry / Back. No coins
                  were charged on these failures, so there is nothing to refund. */}
              {preparingError && (
                <div className="mx-auto mt-4 max-w-md rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-left">
                  <div className="flex items-start gap-3">
                    <span className="material-symbols-outlined text-xl text-red-400">error</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold leading-6 text-red-100">
                        <HoverTranslationText text={preparingError.titleEn} translation={preparingError.titleZh} />
                      </div>
                      <details className="mt-1">
                        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-widest text-red-300/70">
                          <HoverTranslationText text="Details" translation="详情" />
                        </summary>
                        <div className="mt-1 break-words text-[11px] leading-5 text-red-200/80">{preparingError.detail}</div>
                      </details>
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => {
                        setPreparingError(null);
                        const n = Math.min(Math.max(wordCount, MIN_SCENE_WORDS), Math.min(MAX_SCENE_WORDS, candidateCount));
                        void runGeneration(n, false);
                      }}
                      className="flex-1 rounded-xl bg-purple-500 px-4 py-2 font-headline text-xs uppercase tracking-[0.2em] text-white transition-all hover:-translate-y-0.5 hover:shadow-[0_0_20px_rgba(168,85,247,0.4)]"
                    >
                      <HoverTranslationText text="Retry" translation="重试" />
                    </button>
                    <button
                      onClick={() => { abortRef.current?.abort(); setPreparingError(null); setPhase('INTRO'); }}
                      className="flex-1 rounded-xl border border-mid-charcoal bg-light-charcoal/20 px-4 py-2 font-headline text-xs uppercase tracking-[0.2em] text-text-light transition-colors hover:border-red-500/50 hover:text-red-300"
                    >
                      <HoverTranslationText text="Back" translation="返回" />
                    </button>
                  </div>
                </div>
              )}

              {/* Audio generation progress — runs in parallel with the image
                  render, so it appears after the director stage completes and
                  usually finishes well before image render. Hidden until the
                  first `designed` event kicks off the TTS batch. */}
              {audioProgress.total > 0 && (
                <div className="mx-auto mt-3 flex max-w-md items-center gap-3 rounded-2xl border border-purple-400/20 bg-purple-500/5 px-4 py-2 text-left">
                  <span className="material-symbols-outlined text-lg text-purple-300">
                    campaign
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-text-light">
                      <HoverTranslationText text="Generating audio" translation="合成语音" />
                    </div>
                  </div>
                  <span className="font-mono text-[11px] uppercase tracking-widest text-purple-300">
                    {audioProgress.done}/{audioProgress.total}
                  </span>
                  {audioProgress.failed > 0 && (
                    <span className="font-mono text-[11px] text-amber-300">
                      ({audioProgress.failed} failed)
                    </span>
                  )}
                </div>
              )}

              {/* Storyboard preview — surfaces the AI-authored scene skeleton
                  once the director stage completes. Collapsed by default to
                  avoid spoiling the cloze answers in the PLAYING phase. */}
              {storyboard && (
                <div className="mx-auto mt-5 max-w-md text-left">
                  <button
                    type="button"
                    onClick={() => setStoryboardExpanded((v) => !v)}
                    aria-expanded={storyboardExpanded}
                    className="flex w-full items-center justify-between gap-3 rounded-2xl border border-purple-400/20 bg-purple-500/5 px-4 py-2 text-left transition-colors hover:border-purple-400/40 hover:bg-purple-500/10"
                  >
                    <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-purple-300">
                      <HoverTranslationText text="AI Scene Idea" translation="场景构思" />
                    </span>
                    <span className="material-symbols-outlined text-base text-purple-300">
                      {storyboardExpanded ? 'expand_less' : 'expand_more'}
                    </span>
                  </button>
                  {storyboardExpanded && (
                    <div className="mt-2 max-h-44 overflow-y-auto rounded-2xl border border-purple-400/20 bg-dark-charcoal/70 p-3 text-[12px] leading-6 text-text-light">
                      {storyboard}
                    </div>
                  )}
                </div>
              )}

              <div className="mt-6 flex items-center justify-center gap-3 text-text-dark">
                <span className="font-mono text-sm tracking-widest text-purple-300">{preparingElapsed}s</span>
                <span className="text-[11px] text-text-dark">
                  <HoverTranslationText text="elapsed" translation="已用时" />
                </span>
              </div>

              <button
                onClick={() => { abortRef.current?.abort(); setPhase('INTRO'); }}
                className="mt-8 rounded-2xl border border-mid-charcoal bg-light-charcoal/20 px-5 py-3 font-mono text-xs uppercase tracking-[0.25em] text-text-light transition-colors hover:border-red-500/50 hover:text-red-300"
              >
                <HoverTranslationText text="Cancel" translation="取消" />
              </button>
            </div>
          </div>
        )}

        {/* ---------------- COUNTDOWN ---------------- */}
        {phase === 'COUNTDOWN' && (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <div className="font-mono text-xs uppercase tracking-[0.4em] text-purple-400/80">Countdown</div>
              <div className="mt-6 font-headline text-[clamp(72px,16vw,180px)] leading-none text-white">
                {countdownValue > 0 ? countdownValue : 'GO!'}
              </div>
              <div className="mt-4 text-sm text-text-light">
                <HoverTranslationText text="Cloze Round" translation="完形填空" />
              </div>
            </div>
          </div>
        )}

        {/* ---------------- PLAYING ---------------- */}
        {phase === 'PLAYING' && (
          <div className="grid min-h-0 flex-1 gap-4 overflow-hidden" style={{ gridTemplateRows: 'auto minmax(0, 1fr)' }}>
            {/* Header: clock + progress */}
            <div className="grid shrink-0 gap-3 rounded-[30px] border border-mid-charcoal bg-dark-charcoal/70 p-4 md:grid-cols-[1fr_auto_auto] md:items-center">
              <div>
                <div className="font-mono text-xs uppercase tracking-[0.3em] text-text-dark">
                  <HoverTranslationText text="Cloze Clock" translation="完形计时" />
                </div>
                <div className={`mt-1 font-headline text-4xl ${timeLeft <= 5 ? 'text-red-400' : 'text-white'}`}>{formatClock(timeLeft)}</div>
              </div>
              <div className="rounded-2xl border border-mid-charcoal bg-light-charcoal/30 px-4 py-3 text-center">
                <div className="font-mono text-xs uppercase tracking-[0.3em] text-text-dark"><HoverTranslationText text="Active" translation="当前" /></div>
                <div className="mt-1 font-headline text-2xl text-purple-300">
                  {(activeWordIndex ?? 0) + 1}/{selectedWords.length}
                </div>
              </div>
              <div className="rounded-2xl border border-mid-charcoal bg-light-charcoal/30 px-4 py-3 text-center">
                <div className="font-mono text-xs uppercase tracking-[0.3em] text-text-dark"><HoverTranslationText text="Solved" translation="已答对" /></div>
                <div className="mt-1 font-headline text-2xl text-electric-green">{solvedCount}/{selectedWords.length}</div>
              </div>
            </div>

            {/* Body: image gets its natural size (height-limited, 1:1), cloze takes ALL remaining width */}
            <div className="flex min-h-0 gap-4 md:overflow-hidden">
              {/* Left: picture — flex-none so it takes only its natural width
                  (driven by available height since the image is 1:1). The cloze
                  area on the right gets all remaining width via flex-1. */}
              <div className="flex min-h-0 shrink-0 items-center justify-center">
                <SceneImageWithRegions
                  imageUrl={asset?.imageUrl || ''}
                  regions={asset?.regions || []}
                  activeWordIndex={null}
                  solvedWordIndices={[]}
                  revealedWordIndices={[]}
                  blinkNonce={0}
                  fullSize
                  showOverlays={false}
                  onImageLoaded={handleImageLoaded}
                  onImageError={handleImageError}
                />
              </div>

              {/* Right: sentence list + LargeWordInput — flex-1 takes ALL remaining width */}
              <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 md:overflow-hidden">
                {/* Sentence list — scrollable */}
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-[28px] border border-mid-charcoal bg-dark-charcoal/50 p-3 md:p-4">
                  <div className="flex items-center justify-between px-1 pb-1">
                    <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-text-dark">
                      <HoverTranslationText text="Sentences" translation="句子列表" />
                    </div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-text-dark">
                      <HoverTranslationText text="↑/↓ switch · Space play · Enter submit" translation="↑/↓ 切换 · 空格 听音 · Enter 提交" />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {clozeRows.rows.map((row) => {
                      if (row.kind === 'group') {
                        // One row, N blanks (1 or 2). A 2-word group is a merged
                        // pair — rendered once so the two words can't leak each
                        // other's answer across two identical single-blank rows.
                        const idxs = row.indices;
                        const isActive = idxs.includes(activeWordIndex ?? -1);
                        const firstUnsolved = idxs.find((wi) => {
                          const st = wordStates[wi];
                          return st && !st.solved && !st.locked;
                        });
                        const target = idxs[0] != null ? selectedWords[idxs[0]].text : '';
                        return (
                          <ClozeSentence
                            key={`g-${idxs[0]}`}
                            sentence={row.sentence}
                            targetWords={idxs.map((wi) => selectedWords[wi].text)}
                            statuses={idxs.map((wi) => statusForWord(wi))}
                            revealedFlags={idxs.map((wi) => wordIsVisible(wi))}
                            isActive={isActive}
                            audioUrl={sentenceAudios[target.toLowerCase()] || null}
                            isAudioPlaying={playingWord === target.toLowerCase()}
                            onPlayAudio={() => playSentenceAudio(target)}
                            onSelect={() => { if (firstUnsolved != null) moveToIndex(firstUnsolved); }}
                          />
                        );
                      }
                      const i = row.index;
                      const word = selectedWords[i];
                      const s = wordStates[i] || createWordState();
                      const isActive = i === activeWordIndex;
                      const sentence = sentenceForWord(word, asset);
                      // No real sentence → graceful "picture only" placeholder.
                      const displaySentence = sentence || `Picture only — guess word #${i + 1}.`;
                      return (
                        <ClozeSentence
                          key={word.id}
                          sentence={displaySentence}
                          targetWords={[word.text]}
                          statuses={[statusForWord(i)]}
                          revealedFlags={[wordIsVisible(i)]}
                          isActive={isActive}
                          audioUrl={sentence ? (sentenceAudios[word.text.toLowerCase()] || null) : null}
                          isAudioPlaying={playingWord === word.text.toLowerCase()}
                          onPlayAudio={() => playSentenceAudio(word.text)}
                          onSelect={() => {
                            if (!s.solved && !s.locked) moveToIndex(i);
                          }}
                        />
                      );
                    })}
                  </div>
                </div>

                {/* Input — the standard LargeWordInput from CLASSIC mode */}
                {activeWord && (
                  <div className="shrink-0 rounded-[28px] border border-mid-charcoal bg-dark-charcoal/70 p-2">
                    <LargeWordInput
                      key={`input-${activeWord.id}-${activeWordIndex}`}
                      value={activeInput}
                      onChange={setActiveInput}
                      onEnter={submitActive}
                      disabled={!!(activeWordIndex != null && (wordStates[activeWordIndex]?.solved || wordStates[activeWordIndex]?.locked)) || timeLeft <= 0}
                      status={flashStatus}
                      showWordBlocks
                      targetWord={activeWord.text}
                      placeholder="spell here"
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ---------------- REVIEW (error review before RESULT) ---------------- */}
        {phase === 'REVIEW' && result && (
          <div className="flex flex-1 items-center justify-center overflow-y-auto py-2">
            <div className="w-full max-w-3xl rounded-[32px] border border-mid-charcoal bg-dark-charcoal/85 p-8 shadow-2xl backdrop-blur-md md:p-10">
              <div className="font-mono text-xs uppercase tracking-[0.35em] text-purple-400/80">
                <HoverTranslationText text="Review Your Answers" translation="复习错题" />
              </div>
              <h3 className="mt-3 font-headline text-3xl text-white md:text-4xl">
                <HoverTranslationText text="Take a look — then see your score." translation="先看看错题，再查看得分。" />
              </h3>

              <div className="mt-6 space-y-2">
                {selectedWords.map((word, i) => {
                  const s = wordStates[i];
                  if (!s) return null;
                  // Show EVERY sentence (not just wrong ones) so REVIEW is
                  // meaningful even when the user aces the round. Correct rows
                  // get the green treatment; wrong/locked rows get the gray
                  // reveal. Both reuse the exact ClozeSentence component the
                  // player saw during PLAYING — UNLESS there is no real
                  // sentence (picture-only / legacy fallback template), in
                  // which case we show just the word itself.
                  const wasCorrect = !!result.results[i]?.correct;
                  const sentence = sentenceForWord(word, asset);
                  const audioUrl = sentence ? (sentenceAudios[word.text.toLowerCase()] || null) : null;
                  const attemptLabel = wasCorrect
                    ? (s.attemptsUsed === 1 ? 'solved first try' : `solved in ${s.attemptsUsed}`)
                    : s.locked
                      ? (s.attemptsUsed > 0 ? `${s.attemptsUsed} wrong attempt${s.attemptsUsed === 1 ? '' : 's'}` : 'not answered')
                      : 'time ran out';
                  const cardBorder = wasCorrect
                    ? 'border-electric-green/30 bg-electric-green/5'
                    : 'border-mid-charcoal bg-light-charcoal/20';

                  if (!sentence) {
                    // No real sentence — show just the word. No ClozeSentence,
                    // no speaker icon, no fallback template text. This is the
                    // "picture only" case: the learner guessed from the image.
                    return (
                      <div
                        key={word.id}
                        className={`rounded-2xl border p-3 ${cardBorder}`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className={`font-headline text-xl ${wasCorrect ? 'text-electric-green' : 'text-text-light'}`}>
                            {word.text}
                          </span>
                          <span className="font-mono text-[10px] uppercase tracking-widest text-text-dark">
                            <HoverTranslationText text="picture only" translation="仅看图" />
                          </span>
                        </div>
                        <div className={`mt-1 text-right font-mono text-[10px] uppercase tracking-widest ${
                          wasCorrect ? 'text-electric-green/80' : 'text-red-300/80'
                        }`}>
                          {attemptLabel}
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={word.id}
                      className={`rounded-2xl border p-2 ${cardBorder}`}
                    >
                      <ClozeSentence
                        sentence={sentence}
                        targetWords={[word.text]}
                        statuses={[wasCorrect ? 'correct' : 'revealed']}
                        revealedFlags={[true]}
                        isActive={false}
                        audioUrl={audioUrl}
                        isAudioPlaying={playingWord === word.text.toLowerCase()}
                        onPlayAudio={() => playSentenceAudio(word.text)}
                      />
                      <div className={`px-3 pb-1 text-right font-mono text-[10px] uppercase tracking-widest ${
                        wasCorrect ? 'text-electric-green/80' : 'text-red-300/80'
                      }`}>
                        {attemptLabel}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-6 flex flex-wrap gap-2">
                <button
                  onClick={() => { void proceedToResult(); }}
                  disabled={isSubmitting}
                  className="rounded-2xl bg-purple-500 px-5 py-3 font-headline text-sm uppercase tracking-[0.25em] text-white transition-transform hover:-translate-y-1 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <HoverTranslationText text="Next Step" translation="下一步" />
                </button>
                <button
                  onClick={replaySameScene}
                  disabled={isSubmitting}
                  className="rounded-2xl border border-purple-400/40 bg-purple-500/10 px-4 py-3 font-headline text-sm uppercase tracking-[0.25em] text-purple-300 transition-colors hover:border-purple-400 hover:bg-purple-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <HoverTranslationText text="Replay" translation="重玩此局" />
                </button>
                <button
                  onClick={onCancel}
                  disabled={isSubmitting}
                  className="rounded-2xl border border-mid-charcoal bg-light-charcoal/20 px-4 py-3 font-headline text-sm uppercase tracking-[0.25em] text-text-light transition-colors hover:border-white hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <HoverTranslationText text="Exit" translation="退出" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ---------------- RESULT ---------------- */}
        {phase === 'RESULT' && result && (
          <div className="flex flex-1 items-center justify-center overflow-y-auto py-2">
            <div className="w-full max-w-5xl rounded-[34px] border border-mid-charcoal bg-dark-charcoal/85 p-8 shadow-2xl backdrop-blur-md md:p-10">
              <div className="grid gap-8 md:grid-cols-[1.2fr_0.8fr]">
                <div>
                  <div className="font-mono text-xs uppercase tracking-[0.35em] text-purple-400/80">
                    <HoverTranslationText text="Round Complete" translation="本局完成" />
                  </div>
                  <h3 className="mt-3 font-headline text-3xl text-white md:text-4xl">
                    <HoverTranslationText text="Cloze round archived." translation="完形填空成绩已归档。" />
                  </h3>
                  <div className="mt-6 grid gap-3 sm:grid-cols-2">
                    {summaryCards.map((item) => (
                      <div key={item.labelEn} className="rounded-3xl border border-mid-charcoal bg-light-charcoal/25 p-4">
                        <div className="font-mono text-xs uppercase tracking-[0.3em] text-text-dark"><HoverTranslationText text={item.labelEn} translation={item.labelZh} /></div>
                        <div className="mt-2 font-headline text-3xl text-white">{item.value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-6 rounded-[28px] border border-mid-charcoal bg-light-charcoal/20 p-5 text-sm leading-7 text-text-light">
                    <HoverTranslationText
                      text={`Score ${Math.round(result.totalScore)} · accuracy ${Math.round(result.accuracyRate * 100)}% · time ${result.timeUsedSeconds}s. ${result.rankingEligible ? '' : 'Overlap too high — not ranked.'}`}
                      translation={`总分 ${Math.round(result.totalScore)} · 正确率 ${Math.round(result.accuracyRate * 100)}% · 用时 ${result.timeUsedSeconds} 秒。${result.rankingEligible ? '' : '重复率过高，不计入排行榜。'}`}
                    />
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      onClick={replaySameScene}
                      className="rounded-2xl border border-purple-400/40 bg-purple-500/10 px-4 py-3 font-headline text-sm uppercase tracking-[0.25em] text-purple-300 transition-colors hover:border-purple-400 hover:bg-purple-500/20"
                    >
                      <HoverTranslationText text="Replay Scene" translation="重玩此场景" />
                    </button>
                    <button
                      onClick={() => {
                        setResult(null);
                        setWordStates([]);
                        wordStatesRef.current = [];
                        setActiveWordIndex(null);
                        finalizeGuardRef.current = false;
                        setPhase('INTRO');
                      }}
                      className="rounded-2xl bg-purple-500 px-4 py-3 font-headline text-sm uppercase tracking-[0.25em] text-white transition-transform hover:-translate-y-1"
                    >
                      <HoverTranslationText text="Play another round" translation="再来一局" />
                    </button>
                    <button
                      onClick={onCancel}
                      className="rounded-2xl border border-mid-charcoal bg-light-charcoal/20 px-4 py-3 font-headline text-sm uppercase tracking-[0.25em] text-text-light transition-colors hover:border-white hover:text-white"
                    >
                      <HoverTranslationText text="Return to Dashboard" translation="返回主界面" />
                    </button>
                  </div>
                </div>

                <div className="min-h-[280px]">
                  <SceneLeaderboardPanel playMode="cloze" />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SceneGameMode;
