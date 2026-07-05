import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HoverTranslationText } from './HoverTranslationText';
import { SceneImageWithRegions } from './SceneImageWithRegions';
import { SceneLeaderboardPanel } from './SceneLeaderboardPanel';
import { ClozeSentence, ClozeStatus } from './ClozeSentence';
import { LargeWordInput } from './LargeWordInput';
import { Confetti } from './Confetti';
import { playBuzzer, playCheer, playDing } from '../utils/audioFeedback';
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
  requestSceneGeneration,
  requestSceneRegeneration,
  sceneDurationSeconds,
  selectSceneWords,
} from '../services/sceneGame';

interface SceneGameModeProps {
  allWords: WordEntry[];
  sessions: InputSession[];
  onComplete: (summary: SceneGameSummary) => Promise<void> | void;
  onCancel: () => void;
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
 * Resolve the cloze sentence for a single word from the asset.
 * Falls back through:
 *   1. asset.sentences[word.toLowerCase()]  (built by normalizeAsset)
 *   2. asset.regions[word].sentence          (per-region field)
 *   3. null — the row renders in "no clue" degraded mode.
 */
const sentenceForWord = (word: WordEntry, asset: SceneAsset | null): string | null => {
  if (!asset) return null;
  const key = word.text.toLowerCase();
  const fromIndex = asset.sentences?.[key];
  if (fromIndex && fromIndex.trim()) return fromIndex;
  const fromRegion = asset.regions.find((r) => r.word.toLowerCase() === key)?.sentence;
  if (fromRegion && fromRegion.trim()) return fromRegion;
  return null;
};

const SceneGameMode: React.FC<SceneGameModeProps> = ({ allWords, sessions, onComplete, onCancel }) => {
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
  /** Storyboard text surfaced during PREPARING so the player can preview the
   *  scene idea before play. Mirrors the AI-authored `storyboard` field sent on
   *  the `designed` event. Reset at the start of every run. */
  const [storyboard, setStoryboard] = useState<string | null>(null);

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
              setPreparingStage(1);
              // Capture the AI-authored storyboard (or fallback storyboard) for
              // the PREPARING stage preview card.
              const sb = typeof payload?.storyboard === 'string' ? payload.storyboard.trim() : '';
              if (sb) setStoryboard(sb);
            } else if (stage === 'rendered') setPreparingStage(2);
          },
        },
      );
      if (controller.signal.aborted) return;
      console.log('[SceneGameMode] asset received', { source: res.source, imageUrl: res.asset.imageUrl, regionCount: res.asset.regions.length });
      setAsset(res.asset);
      setDegraded(res.degraded);
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
      setGenError(err instanceof Error ? err.message : 'Scene generation failed. Please try again.');
      setPhase('INTRO');
    }
  }, [allWords, sessions, dayIndex]);

  useEffect(() => {
    if (phase !== 'PREPARING') return;
    const start = Date.now();
    const t = window.setInterval(() => {
      setPreparingElapsed(Math.floor((Date.now() - start) / 1000));
    }, 500);
    return () => window.clearInterval(t);
  }, [phase]);

  const beginScene = () => {
    if (!canPrepare) return;
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
    try {
      const meta = gatherWordMeta(selectedWords);
      const res = await requestSceneRegeneration(meta, dayIndex, 'en', undefined, {
        onStage: (stage, payload) => {
          if (stage === 'designed') {
            setPreparingStage(1);
            const sb = typeof payload?.storyboard === 'string' ? payload.storyboard.trim() : '';
            if (sb) setStoryboard(sb);
          } else if (stage === 'rendered') setPreparingStage(2);
        },
      });
      setAsset(res.asset);
      setDegraded(res.degraded);
      // After regeneration, return to INTRO so the player can press LOAD SCENE
      // again to start the round (no mode select any more).
      setPhase('INTRO');
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Regeneration failed.');
      setPhase('INTRO');
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
  }, [activeWordIndex, selectedWords.length, moveToIndex]);

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
  // Global keyboard handler — ONLY for ArrowUp/ArrowDown navigation.
  // All letter / Backspace / Enter input is handled natively by the
  // LargeWordInput's real <input> element (so focus, mobile keyboards,
  // IME, etc. all work). We only intercept the arrow keys to switch the
  // active row.
  // ---------------------------------------------------------------
  useEffect(() => {
    if (phase !== 'PLAYING') return;
    const onKey = (e: KeyboardEvent) => {
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
  }, [phase, activeWordIndex, selectedWords.length, moveToIndex]);

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

    const allCorrect = results.every((r) => r.correct);
    setResult(summary);
    setPhase('RESULT');
    if (allCorrect) playCheer();

    setIsSubmitting(true);
    try {
      await onComplete(summary);
    } finally {
      setIsSubmitting(false);
    }
  }, [selectedWords, selectionMode, dayIndex, overlapRate, rankingEligible, rankingIneligibleReason, asset, totalDuration, timeLeft, onComplete]);

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
                    <HoverTranslationText text="Load Scene" translation="生成场景" />
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
              <div className="mx-auto mt-6 max-w-md space-y-2.5 text-left">
                {([
                  { stage: 0, icon: 'checklist', en: 'Selecting words', zh: '抽取单词', hint: 'Smart/random pick from your library' },
                  { stage: 1, icon: 'auto_awesome', en: 'Designing scene', zh: '场景导演构思', hint: 'LLM arranges words into one scene + prompt' },
                  { stage: 2, icon: 'image', en: 'Rendering image', zh: '渲染场景图', hint: 'Image model draws the isometric scene' },
                ] as const).map((step) => {
                  const done = preparingStage > step.stage;
                  const active = preparingStage === step.stage;
                  return (
                    <div
                      key={step.stage}
                      className={`flex items-center gap-3 rounded-2xl border px-4 py-3 transition-all duration-300 ${
                        active
                          ? 'border-purple-400/50 bg-purple-500/10'
                          : done
                            ? 'border-green-500/30 bg-green-500/5'
                            : 'border-mid-charcoal bg-light-charcoal/10 opacity-50'
                      }`}
                    >
                      <span className={`material-symbols-outlined text-xl ${active ? 'animate-spin text-purple-300' : done ? 'text-green-400' : 'text-text-dark'}`}>
                        {done ? 'check_circle' : step.icon}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className={`text-sm font-medium ${active ? 'text-white' : done ? 'text-text-light' : 'text-text-dark'}`}>
                          <HoverTranslationText text={step.en} translation={step.zh} />
                        </div>
                        <div className="truncate text-[11px] text-text-dark">{step.hint}</div>
                      </div>
                      {active && (
                        <span className="font-mono text-[11px] uppercase tracking-widest text-purple-300">
                          <HoverTranslationText text="working" translation="进行中" />
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

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

            {/* Body: image | (sentence list + input) */}
            <div className="grid min-h-0 gap-4 md:grid-cols-[1.05fr_0.95fr] md:overflow-hidden">
              {/* Left: picture */}
              <div className="flex min-h-0 items-center justify-center">
                <SceneImageWithRegions
                  imageUrl={asset?.imageUrl || ''}
                  regions={asset?.regions || []}
                  activeWordIndex={null}
                  solvedWordIndices={[]}
                  revealedWordIndices={[]}
                  blinkNonce={0}
                  fullSize
                  showOverlays={false}
                />
              </div>

              {/* Right: sentence list + LargeWordInput (CLASSIC-style input) */}
              <div className="flex min-h-0 flex-col gap-3 md:overflow-hidden">
                {/* Sentence list — scrollable */}
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-[28px] border border-mid-charcoal bg-dark-charcoal/50 p-3 md:p-4">
                  <div className="flex items-center justify-between px-1 pb-1">
                    <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-text-dark">
                      <HoverTranslationText text="Sentences" translation="句子列表" />
                    </div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-text-dark">
                      <HoverTranslationText text="↑/↓ switch · Enter submit" translation="↑/↓ 切换 · Enter 提交" />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {selectedWords.map((word, i) => {
                      const s = wordStates[i] || createWordState();
                      const isActive = i === activeWordIndex;
                      const sentence = sentenceForWord(word, asset);

                      let status: ClozeStatus = 'idle';
                      if (s.solved) status = 'correct';
                      else if (isActive) status = flashStatus === 'correct' ? 'correct' : flashStatus === 'wrong' ? 'wrong' : 'active';
                      else if (s.revealed) status = 'revealed';

                      // When the backend hasn't returned a sentence (e.g. old edge
                      // function deployed), show a graceful placeholder instead of
                      // the raw "(no cloze clue for ...)" template string.
                      const displaySentence = sentence || `Picture only — guess word #${i + 1}.`;

                      return (
                        <ClozeSentence
                          key={word.id}
                          sentence={displaySentence}
                          targetWord={word.text}
                          status={status}
                          revealed={s.revealed && !s.solved}
                          isActive={isActive}
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
