import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HoverTranslationText } from './HoverTranslationText';
import { SceneImageWithRegions } from './SceneImageWithRegions';
import { SceneLeaderboardPanel } from './SceneLeaderboardPanel';
import { LargeWordInput } from './LargeWordInput';
import { Confetti } from './Confetti';
import { playBuzzer, playCheer, playDing } from '../utils/audioFeedback';
import {
  InputSession,
  SceneAsset,
  SceneCardResult,
  SceneGamePhase,
  SceneGameSummary,
  ScenePlayMode,
  WordEntry,
} from '../types';
import {
  MAX_SCENE_WORDS,
  MIN_SCENE_WORDS,
  buildHaystackCandidates,
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
  wrongPicks?: string[]; // haystack: distractor word ids already picked wrong
}

const createWordState = (): WordState => ({
  solved: false,
  locked: false,
  attemptsUsed: 0,
  activatedAtMs: null,
  solvedAtMs: null,
  revealed: false,
  wrongPicks: [],
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
  // Pipeline stages surfaced to the user during PREPARING.
  // 0 = selecting words, 1 = designing scene (LLM), 2 = rendering image, 3 = ready.
  const [preparingStage, setPreparingStage] = useState(0);
  const [isRegenerating, setIsRegenerating] = useState(false);

  const [playMode, setPlayMode] = useState<ScenePlayMode>('spell');
  const [countdownValue, setCountdownValue] = useState(3);
  const [timeLeft, setTimeLeft] = useState(0);

  const [wordStates, setWordStates] = useState<WordState[]>([]);
  const [activeWordIndex, setActiveWordIndex] = useState<number | null>(null);
  const [blinkNonce, setBlinkNonce] = useState(0);

  const [spellInput, setSpellInput] = useState('');
  const [spellStatus, setSpellStatus] = useState<'idle' | 'correct' | 'wrong'>('idle');

  const [result, setResult] = useState<SceneGameSummary | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const gameStartTimeRef = useRef<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  const finalizeGuardRef = useRef(false);
  const wordStatesRef = useRef<WordState[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  // Always-latest finishGame — call sites route through this ref to avoid
  // stale closures (e.g. advance/timer capturing an outdated `asset`).
  const finishGameRef = useRef<(timedOut: boolean) => Promise<void>>(async () => {});

  useEffect(() => { wordStatesRef.current = wordStates; }, [wordStates]);

  const candidateCount = useMemo(() => getSceneCandidateWords(allWords).length, [allWords]);
  const canPrepare = candidateCount >= MIN_SCENE_WORDS;

  const totalDuration = useMemo(
    () => sceneDurationSeconds(playMode, selectedWords.length || wordCount),
    [playMode, selectedWords.length, wordCount],
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
          // Real-evidence stage progression: each tick is gated by an actual
          // event from the edge function, not a wall-clock guess.
          //   stage 0 (selecting words) is set synchronously above
          //   stage 1 (designing) only ticks when director LLM truly returns
          //   stage 2 (rendering) only ticks when image bytes truly arrive
          onStage: (stage) => {
            console.log('[SceneGameMode] onStage', stage);
            if (stage === 'designed') setPreparingStage(1);
            else if (stage === 'rendered') setPreparingStage(2);
          },
        },
      );
      if (controller.signal.aborted) return;
      console.log('[SceneGameMode] asset received', { source: res.source, imageUrl: res.asset.imageUrl, regionCount: res.asset.regions.length });
      setAsset(res.asset);
      setDegraded(res.degraded);
      setPhase('MODE_SELECT');
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error('[SceneGameMode] generation failed', err);
      setGenError(err instanceof Error ? err.message : 'Scene generation failed. Please try again.');
      setPhase('INTRO');
    }
  }, [allWords, sessions, dayIndex]);

  // Preparing elapsed-time display ONLY (no longer drives stage progression —
  // stage ticks come from real NDJSON events via requestSceneGeneration's
  // onStage callback above).
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
    try {
      const meta = gatherWordMeta(selectedWords);
      const res = await requestSceneRegeneration(meta, dayIndex, 'en', undefined, {
        onStage: (stage) => {
          if (stage === 'designed') setPreparingStage(1);
          else if (stage === 'rendered') setPreparingStage(2);
        },
      });
      setAsset(res.asset);
      setDegraded(res.degraded);
      setPhase('MODE_SELECT');
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Regeneration failed.');
      setPhase('MODE_SELECT');
    } finally {
      setIsRegenerating(false);
    }
  };

  // ---------------------------------------------------------------
  // MODE_SELECT → COUNTDOWN
  // ---------------------------------------------------------------
  const chooseMode = (mode: ScenePlayMode) => {
    setPlayMode(mode);
    setPhase('COUNTDOWN');
    setCountdownValue(3);
    if (countdownTimerRef.current) window.clearInterval(countdownTimerRef.current);
    countdownTimerRef.current = window.setInterval(() => {
      setCountdownValue((current) => {
        if (current <= 1) {
          if (countdownTimerRef.current) window.clearInterval(countdownTimerRef.current);
          window.setTimeout(() => startPlay(mode), 250);
          return 0;
        }
        return current - 1;
      });
    }, 900);
  };

  const startPlay = (mode: ScenePlayMode) => {
    finalizeGuardRef.current = false;
    const states = selectedWords.map(createWordState);
    states[0].activatedAtMs = 0;
    setWordStates(states);
    wordStatesRef.current = states;
    setActiveWordIndex(0);
    setBlinkNonce((n) => n + 1);
    setSpellInput('');
    setSpellStatus('idle');
    gameStartTimeRef.current = Date.now();
    setTimeLeft(sceneDurationSeconds(mode, selectedWords.length));
    setPhase(mode === 'spell' ? 'PLAYING_SPELL' : 'PLAYING_HAYSTACK');
  };

  // ---------------------------------------------------------------
  // Game timer
  // ---------------------------------------------------------------
  useEffect(() => {
    if (phase !== 'PLAYING_SPELL' && phase !== 'PLAYING_HAYSTACK') return;
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
  // Advance to the next word
  // ---------------------------------------------------------------
  const advance = () => {
    if (activeWordIndex == null) return;
    const next = activeWordIndex + 1;
    if (next >= selectedWords.length) {
      void finishGameRef.current(false);
      return;
    }
    // stamp activation time for the next word
    const activatedAtMs = gameStartTimeRef.current ? Date.now() - gameStartTimeRef.current : 0;
    setWordStates((prev) => {
      const copy = prev.map((s, i) => (i === next ? { ...s, activatedAtMs } : s));
      wordStatesRef.current = copy;
      return copy;
    });
    setActiveWordIndex(next);
    setBlinkNonce((n) => n + 1);
    setSpellInput('');
    setSpellStatus('idle');
  };

  // ---------------------------------------------------------------
  // SPELL submit
  // ---------------------------------------------------------------
  const submitSpell = () => {
    if (activeWordIndex == null || phase !== 'PLAYING_SPELL') return;
    const current = wordStates[activeWordIndex];
    if (!current || current.solved || current.locked || timeLeft <= 0) return;

    const guess = spellInput.trim().toLowerCase().replace(/\s+/g, ' ');
    const answer = selectedWords[activeWordIndex].text.trim().toLowerCase().replace(/\s+/g, ' ');
    const nextAttempts = current.attemptsUsed + 1;
    const now = gameStartTimeRef.current ? Date.now() - gameStartTimeRef.current : 0;

    if (guess === answer) {
      playDing();
      setSpellStatus('correct');
      setSpellInput(selectedWords[activeWordIndex].text);
      setWordStates((prev) => {
        const copy = prev.map((s, i) => (i === activeWordIndex ? { ...s, solved: true, locked: true, attemptsUsed: nextAttempts, solvedAtMs: now } : s));
        wordStatesRef.current = copy;
        return copy;
      });
      window.setTimeout(advance, 800);
      return;
    }

    playBuzzer();
    setSpellStatus('wrong');
    setWordStates((prev) => {
      const willLock = nextAttempts >= 3;
      const copy = prev.map((s, i) => (i === activeWordIndex ? { ...s, attemptsUsed: nextAttempts, locked: willLock } : s));
      wordStatesRef.current = copy;
      return copy;
    });
    window.setTimeout(() => {
      setSpellInput('');
      setSpellStatus('idle');
      if (nextAttempts >= 3) advance();
    }, 600);
  };

  // ---------------------------------------------------------------
  // HAYSTACK pick
  // ---------------------------------------------------------------
  const haystackCandidates = useMemo(() => {
    if (phase !== 'PLAYING_HAYSTACK' || activeWordIndex == null) return null;
    return buildHaystackCandidates(selectedWords[activeWordIndex], allWords);
  }, [phase, activeWordIndex, selectedWords, allWords]);

  const pickHaystack = (word: WordEntry) => {
    if (activeWordIndex == null || phase !== 'PLAYING_HAYSTACK') return;
    const current = wordStates[activeWordIndex];
    if (!current || current.solved || current.locked || timeLeft <= 0) return;
    if (current.wrongPicks?.includes(word.id)) return;

    const isCorrect = word.id === selectedWords[activeWordIndex].id;
    const now = gameStartTimeRef.current ? Date.now() - gameStartTimeRef.current : 0;
    const nextAttempts = current.attemptsUsed + 1;

    if (isCorrect) {
      playDing();
      setWordStates((prev) => {
        const copy = prev.map((s, i) => (i === activeWordIndex ? { ...s, solved: true, locked: true, attemptsUsed: nextAttempts, solvedAtMs: now } : s));
        wordStatesRef.current = copy;
        return copy;
      });
      window.setTimeout(advance, 700);
      return;
    }

    playBuzzer();
    const willReveal = nextAttempts >= 3;
    setWordStates((prev) => {
      const copy = prev.map((s, i) => {
        if (i !== activeWordIndex) return s;
        return {
          ...s,
          attemptsUsed: nextAttempts,
          wrongPicks: [...(s.wrongPicks || []), word.id],
          locked: willReveal,
          revealed: willReveal, // reveal the word text in the region (NOT solved — no ✅)
        };
      });
      wordStatesRef.current = copy;
      return copy;
    });
    if (willReveal) window.setTimeout(advance, 900);
  };

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
      // Words never reached count as incorrect + revealed on timeout.
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
      playMode,
      dayIndex,
      wordCount: selectedWords.length,
      overlapRate,
      rankingEligible,
      rankingIneligibleReason,
      sceneAssetId: asset?.id || null,
    });

    // Reveal any unsolved words in the UI.
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
  }, [selectedWords, selectionMode, playMode, dayIndex, overlapRate, rankingEligible, rankingIneligibleReason, asset, totalDuration, timeLeft, onComplete]);

  // Keep finishGameRef in sync every render so advance/timer call the latest.
  useEffect(() => { finishGameRef.current = finishGame; });

  // All words resolved → finish (non-timeout).
  useEffect(() => {
    if (phase !== 'PLAYING_SPELL' && phase !== 'PLAYING_HAYSTACK') return;
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

  const playOtherMode = () => {
    setResult(null);
    setWordStates([]);
    wordStatesRef.current = [];
    setActiveWordIndex(null);
    setSpellInput('');
    setSpellStatus('idle');
    finalizeGuardRef.current = false;
    setPhase('MODE_SELECT');
  };

  const solvedIndices = useMemo(
    () => wordStates.map((s, i) => (s.solved ? i : -1)).filter((i) => i >= 0),
    [wordStates],
  );
  const revealedIndices = useMemo(
    () => wordStates.map((s, i) => (s.revealed && !s.solved ? i : -1)).filter((i) => i >= 0),
    [wordStates],
  );

  const activeWord = activeWordIndex != null ? selectedWords[activeWordIndex] : null;

  const summaryCards = result
    ? [
        { labelEn: 'Total Score', labelZh: '总分', value: Math.round(result.totalScore) },
        { labelEn: 'Accuracy', labelZh: '正确率', value: `${Math.round(result.accuracyRate * 100)}%` },
        { labelEn: 'Time Used', labelZh: '用时', value: `${result.timeUsedSeconds}s` },
        { labelEn: 'Solved', labelZh: '答对', value: `${result.wordsCorrect}/${result.wordsTotal}` },
      ]
    : [];

  const otherModeLabel = playMode === 'spell'
    ? { en: 'Play 大海捞针 (Haystack) with this image', zh: '用这张图玩「大海捞针」' }
    : { en: 'Play 看图拼写 (Picture-Spell) with this image', zh: '用这张图玩「看图拼写」' };

  return (
    <div className="fixed inset-0 z-[90] overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(168,85,247,0.14),_transparent_30%),linear-gradient(180deg,_rgba(9,12,16,0.96),_rgba(12,14,18,1))]">
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(180deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:26px_26px] opacity-30" />

      {phase === 'RESULT' && result && (
        <Confetti variant="purple" title="Scene Complete" subtitle={playMode === 'spell' ? '看图拼写完成' : '大海捞针完成'} />
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
                      text="Pick 5-10 words. AI fuses them into ONE isometric cartoon scene that also includes today's monster. Then choose: watch a region blink and spell the word, or pick the right word from 5 candidates."
                      translation="挑选 5-10 个单词，AI 把它们融合成一张等轴透视卡通场景图，图中还包含当日主题小怪兽。随后选择玩法：看区域闪烁拼写单词，或从 5 个候选词中挑出正确的那个。"
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

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-3xl border border-mid-charcoal bg-light-charcoal/30 p-4">
                      <div className="font-mono text-xs uppercase tracking-[0.3em] text-text-dark"><HoverTranslationText text="Spell Mode" translation="看图拼写" /></div>
                      <div className="mt-2 font-headline text-xl text-white">{wordCount}×30s</div>
                    </div>
                    <div className="rounded-3xl border border-mid-charcoal bg-light-charcoal/30 p-4">
                      <div className="font-mono text-xs uppercase tracking-[0.3em] text-text-dark"><HoverTranslationText text="Haystack Mode" translation="大海捞针" /></div>
                      <div className="mt-2 font-headline text-xl text-white">{wordCount}×15s</div>
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

        {/* ---------------- MODE_SELECT ---------------- */}
        {phase === 'MODE_SELECT' && asset && (
          <div className="flex flex-1 items-center justify-center overflow-y-auto py-2">
            <div className="w-full max-w-5xl rounded-[32px] border border-mid-charcoal bg-dark-charcoal/80 p-6 shadow-2xl backdrop-blur-md md:p-8">
              <div className="grid gap-6 md:grid-cols-[1fr_0.9fr] md:items-center">
                <div className="flex flex-col items-center">
                  <SceneImageWithRegions
                    imageUrl={asset.imageUrl}
                    regions={asset.regions}
                    activeWordIndex={null}
                    solvedWordIndices={[]}
                    revealedWordIndices={[]}
                    blinkNonce={0}
                    onRegenerate={regenerateImage}
                  />
                  <div className="mt-4 flex items-center gap-2 rounded-2xl border border-mid-charcoal bg-light-charcoal/20 px-3 py-2">
                    <img src={monsterImg} alt="monster" className="h-7 w-7 rounded-lg object-cover" />
                    <span className="text-xs text-text-light"><HoverTranslationText text={monsterName.en} translation={monsterName.zh} /></span>
                  </div>
                  {degraded && (
                    <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200">
                      <HoverTranslationText text="Some word regions were unclear; affected words will pulse the whole image." translation="部分单词区域未能识别，这些词将以整图脉冲提示。" />
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <h3 className="font-headline text-2xl text-white md:text-3xl">
                    <HoverTranslationText text="Choose how to play" translation="选择玩法" />
                  </h3>
                  <button
                    onClick={() => chooseMode('spell')}
                    className="w-full rounded-2xl border border-purple-400/30 bg-purple-500/10 p-5 text-left transition-all hover:-translate-y-0.5 hover:bg-purple-500/20"
                  >
                    <div className="font-headline text-xl text-white"><HoverTranslationText text="看图拼写 · Picture-Spell" translation="看图拼写" /></div>
                    <div className="mt-1 text-xs text-text-light"><HoverTranslationText text={`Region blinks 3×, spell it with a letter-count hint. ${wordCount}×30s.`} translation={`区域闪烁 3 次，根据字母数提示拼写。${wordCount}×30 秒。`} /></div>
                  </button>
                  <button
                    onClick={() => chooseMode('haystack')}
                    className="w-full rounded-2xl border border-purple-400/30 bg-purple-500/10 p-5 text-left transition-all hover:-translate-y-0.5 hover:bg-purple-500/20"
                  >
                    <div className="font-headline text-xl text-white"><HoverTranslationText text="大海捞针 · Needle-in-Haystack" translation="大海捞针" /></div>
                    <div className="mt-1 text-xs text-text-light"><HoverTranslationText text={`Pick the right word from 5 candidates. ${wordCount}×15s.`} translation={`从 5 个候选词中挑出正确的。${wordCount}×15 秒。`} /></div>
                  </button>
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={regenerateImage}
                      disabled={isRegenerating}
                      className="flex-1 rounded-xl border border-mid-charcoal bg-light-charcoal/20 px-3 py-2.5 font-mono text-[11px] uppercase tracking-[0.2em] text-text-light transition-colors hover:border-purple-400/50 disabled:opacity-50"
                    >
                      <HoverTranslationText text="Regenerate image" translation="重新生成图片" />
                    </button>
                    <button
                      onClick={() => { setAsset(null); setSelectedWords([]); setPhase('INTRO'); }}
                      className="flex-1 rounded-xl border border-mid-charcoal bg-light-charcoal/20 px-3 py-2.5 font-mono text-[11px] uppercase tracking-[0.2em] text-text-light transition-colors hover:border-purple-400/50"
                    >
                      <HoverTranslationText text="Reroll words" translation="重新选词" />
                    </button>
                  </div>
                  {genError && (
                    <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">{genError}</div>
                  )}
                </div>
              </div>
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
                {playMode === 'spell' ? <HoverTranslationText text="Picture-Spell" translation="看图拼写" /> : <HoverTranslationText text="Needle-in-Haystack" translation="大海捞针" />}
              </div>
            </div>
          </div>
        )}

        {/* ---------------- PLAYING (shared header) ---------------- */}
        {(phase === 'PLAYING_SPELL' || phase === 'PLAYING_HAYSTACK') && (
          <div className="grid min-h-0 flex-1 gap-4 overflow-hidden" style={{ gridTemplateRows: 'auto minmax(0, 1fr)' }}>
            <div className="grid shrink-0 gap-3 rounded-[30px] border border-mid-charcoal bg-dark-charcoal/70 p-4 md:grid-cols-[1fr_auto_auto] md:items-center">
              <div>
                <div className="font-mono text-xs uppercase tracking-[0.3em] text-text-dark">
                  {playMode === 'spell' ? <HoverTranslationText text="Spell Clock" translation="拼写计时" /> : <HoverTranslationText text="Haystack Clock" translation="捞针计时" />}
                </div>
                <div className={`mt-1 font-headline text-4xl ${timeLeft <= 5 ? 'text-red-400' : 'text-white'}`}>{formatClock(timeLeft)}</div>
              </div>
              <div className="rounded-2xl border border-mid-charcoal bg-light-charcoal/30 px-4 py-3 text-center">
                <div className="font-mono text-xs uppercase tracking-[0.3em] text-text-dark"><HoverTranslationText text="Word" translation="单词" /></div>
                <div className="mt-1 font-headline text-2xl text-purple-300">
                  {(activeWordIndex ?? 0) + 1}/{selectedWords.length}
                </div>
              </div>
              <div className="rounded-2xl border border-mid-charcoal bg-light-charcoal/30 px-4 py-3 text-center">
                <div className="font-mono text-xs uppercase tracking-[0.3em] text-text-dark"><HoverTranslationText text="Solved" translation="已答对" /></div>
                <div className="mt-1 font-headline text-2xl text-electric-green">{solvedIndices.length}/{selectedWords.length}</div>
              </div>
            </div>

            <div className="grid min-h-0 gap-4 overflow-y-auto md:grid-cols-[1.1fr_0.9fr] md:overflow-hidden">
              {/* Image with regions */}
              <div className="flex min-h-0 items-center justify-center">
                <SceneImageWithRegions
                  imageUrl={asset?.imageUrl || ''}
                  regions={asset?.regions || []}
                  activeWordIndex={activeWordIndex}
                  solvedWordIndices={solvedIndices}
                  revealedWordIndices={revealedIndices}
                  blinkNonce={blinkNonce}
                  fullSize
                />
              </div>

              {/* Input / candidates */}
              <div className="flex min-h-0 flex-col justify-center">
                {phase === 'PLAYING_SPELL' && activeWord && (
                  <LargeWordInput
                    value={spellInput}
                    onChange={setSpellInput}
                    onEnter={submitSpell}
                    disabled={!!(activeWordIndex != null && (wordStates[activeWordIndex]?.solved || wordStates[activeWordIndex]?.locked)) || timeLeft <= 0}
                    status={spellStatus}
                    showWordBlocks
                    targetWord={activeWord.text}
                    placeholder="spell here"
                  />
                )}
                {phase === 'PLAYING_HAYSTACK' && haystackCandidates && activeWord && (
                  <div className="space-y-3">
                    <div className="text-center text-xs text-text-light">
                      <HoverTranslationText text="Which word matches the highlighted region?" translation="哪个单词对应高亮的区域？" />
                    </div>
                    <div className="grid gap-2.5">
                      {haystackCandidates.candidates.map((cand) => {
                        const wrong = wordStates[activeWordIndex ?? -1]?.wrongPicks?.includes(cand.id);
                        return (
                          <button
                            key={cand.id}
                            onClick={() => pickHaystack(cand)}
                            disabled={wrong || timeLeft <= 0}
                            className={`w-full rounded-2xl border px-4 py-3.5 text-left font-headline text-lg transition-all ${
                              wrong
                                ? 'cursor-not-allowed border-red-500/40 bg-red-500/10 text-red-300/60 line-through'
                                : 'border-mid-charcoal bg-light-charcoal/30 text-white hover:-translate-y-0.5 hover:border-purple-400/50 hover:bg-purple-500/10'
                            }`}
                          >
                            {cand.text}
                          </button>
                        );
                      })}
                    </div>
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
                    {playMode === 'spell' ? <HoverTranslationText text="Picture-Spell archived." translation="看图拼写成绩已归档。" /> : <HoverTranslationText text="Haystack archived." translation="大海捞针成绩已归档。" />}
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
                      onClick={playOtherMode}
                      className="rounded-2xl bg-purple-500 px-4 py-3 font-headline text-sm uppercase tracking-[0.25em] text-white transition-transform hover:-translate-y-1"
                    >
                      <HoverTranslationText text={otherModeLabel.en} translation={otherModeLabel.zh} />
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
                  <SceneLeaderboardPanel playMode={playMode} />
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
