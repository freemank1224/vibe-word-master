import React, { useEffect, useMemo, useRef, useState } from 'react';
import { HoverTranslationText } from './HoverTranslationText';
import { preloadAudio, playWordPronunciation, stopCurrentAudio } from '../services/pronunciationService';
import { playBuzzer, playDing } from '../utils/audioFeedback';
import {
  InputSession,
  PuzzleCardResult,
  PuzzleGameCardState,
  PuzzleGamePhase,
  PuzzleGameSelectionMode,
  PuzzleGameSummary,
  WordEntry,
} from '../types';
import {
  calculatePuzzleGameSummary,
  getPuzzleCandidateWords,
  getPuzzleImageUrl,
  normalizePuzzleAnswer,
  selectPuzzleWords,
} from '../services/puzzleGame';

interface PuzzleGameModeProps {
  allWords: WordEntry[];
  sessions: InputSession[];
  onComplete: (summary: PuzzleGameSummary) => Promise<void> | void;
  onCancel: () => void;
}

const TOTAL_SECONDS = 90;

const createCardState = (word: WordEntry): PuzzleGameCardState => ({
  word,
  imageUrl: getPuzzleImageUrl(word),
  attemptsUsed: 0,
  hintUsed: false,
  inputValue: '',
  isInputOpen: false,
  isSolved: false,
  isLocked: false,
  activatedAtMs: null,
  solvedAtMs: null,
});

const formatClock = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const PuzzleGameMode: React.FC<PuzzleGameModeProps> = ({ allWords, sessions, onComplete, onCancel }) => {
  const [phase, setPhase] = useState<PuzzleGamePhase>('INTRO');
  const [selectionMode, setSelectionMode] = useState<PuzzleGameSelectionMode>('random');
  const [selectionOverlapRate, setSelectionOverlapRate] = useState(0);
  const [rankingEligible, setRankingEligible] = useState(true);
  const [rankingIneligibleReason, setRankingIneligibleReason] = useState<string | null>(null);
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [selectedWords, setSelectedWords] = useState<WordEntry[]>([]);
  const [cards, setCards] = useState<PuzzleGameCardState[]>([]);
  const [audioProgress, setAudioProgress] = useState({ current: 0, total: 0 });
  const [selectionMessage, setSelectionMessage] = useState('');
  const [preparationError, setPreparationError] = useState<string | null>(null);
  const [countdownValue, setCountdownValue] = useState(3);
  const [timeLeft, setTimeLeft] = useState(TOTAL_SECONDS);
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [result, setResult] = useState<PuzzleGameSummary | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [boardHeight, setBoardHeight] = useState(() => Math.max(420, window.innerHeight - 210));

  const gameStartTimeRef = useRef<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  const thirtySecondAlertRef = useRef(false);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const finalizeGuardRef = useRef(false);

  const candidateCount = useMemo(() => getPuzzleCandidateWords(allWords).length, [allWords]);
  const canPrepare = candidateCount >= 9;

  useEffect(() => {
    const handleResize = () => {
      setBoardHeight(Math.max(420, window.innerHeight - 210));
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (phase !== 'PLAYING') {
      return;
    }

    const timer = window.setInterval(() => {
      if (gameStartTimeRef.current == null) return;
      const elapsedSeconds = Math.floor((Date.now() - gameStartTimeRef.current) / 1000);
      const nextTimeLeft = Math.max(TOTAL_SECONDS - elapsedSeconds, 0);
      setTimeLeft(nextTimeLeft);

      if (!thirtySecondAlertRef.current && nextTimeLeft <= 30) {
        thirtySecondAlertRef.current = true;
        setBannerMessage('30 seconds remaining');
      }

      if (nextTimeLeft <= 0) {
        window.clearInterval(timer);
        void finishGame(true);
      }
    }, 250);

    return () => window.clearInterval(timer);
  }, [phase, cards]);

  useEffect(() => {
    if (!bannerMessage) return;
    const timeout = window.setTimeout(() => setBannerMessage(null), 1400);
    return () => window.clearTimeout(timeout);
  }, [bannerMessage]);

  useEffect(() => {
    return () => {
      if (countdownTimerRef.current) {
        window.clearInterval(countdownTimerRef.current);
      }
      void stopCurrentAudio();
    };
  }, []);

  useEffect(() => {
    if (phase !== 'PLAYING') {
      return;
    }

    if (activeCardId && cards.some((card) => card.word.id === activeCardId && !card.isSolved && !card.isLocked)) {
      return;
    }

    const nextPlayableCard = cards.find((card) => !card.isSolved && !card.isLocked);
    setActiveCardId(nextPlayableCard?.word.id || null);
  }, [activeCardId, cards, phase]);

  useEffect(() => {
    if (phase !== 'PLAYING' || !activeCardId) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTextInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
      if (isTextInput) {
        return;
      }

      if (event.key !== ' ' && event.key !== 'Enter') {
        return;
      }

      event.preventDefault();
      const nextCard = cards.find((card) => card.word.id === activeCardId);
      if (!nextCard || nextCard.isSolved || nextCard.isLocked) {
        return;
      }

      void activateCard(nextCard);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeCardId, cards, phase]);

  const prepareGame = async () => {
    if (!canPrepare) return;

    setPreparationError(null);
    setPhase('PREPARING');

    const smartSelectionEnabled = localStorage.getItem('vibe_ai_selection') === 'true';
    setSelectionMessage(smartSelectionEnabled ? 'Smart Selection Assistant is choosing 9 image words...' : 'Random selection is choosing 9 image words...');

    const selection = selectPuzzleWords(allWords, sessions, smartSelectionEnabled, 9);
    setSelectionMode(selection.selectionMode);
    setSelectionOverlapRate(selection.overlapRate);
    setRankingEligible(selection.rankingEligible);
    setRankingIneligibleReason(selection.rankingIneligibleReason || null);

    if (selection.words.length < 9) {
      setPreparationError('Not enough image-backed words in your library yet.');
      setPhase('INTRO');
      return;
    }

    setSelectedWords(selection.words);
    setCards(selection.words.map(createCardState));
    setSelectionMessage(`Selected ${selection.words.length} words. Loading pronunciation assets...`);
    setAudioProgress({ current: 0, total: selection.words.length });

    let completed = 0;

    for (const word of selection.words) {
      const lang = word.language || 'en';
      try {
        await preloadAudio(word.text, lang);
      } catch (error) {
        console.warn('[PuzzleGameMode] preload failed for', word.text, error);
      }

      if (word.image_url) {
        await new Promise<void>((resolve) => {
          const image = new Image();
          image.onload = () => resolve();
          image.onerror = () => resolve();
          image.src = word.image_url || '';
        });
      }

      completed += 1;
      setAudioProgress({ current: completed, total: selection.words.length });
    }

    setSelectionMessage(`All ${selection.words.length} audio files are ready.`);
    setPhase('READY');
  };

  const startCountdown = () => {
    setPhase('COUNTDOWN');
    setCountdownValue(3);

    if (countdownTimerRef.current) {
      window.clearInterval(countdownTimerRef.current);
    }

    countdownTimerRef.current = window.setInterval(() => {
      setCountdownValue((current) => {
        if (current <= 1) {
          if (countdownTimerRef.current) {
            window.clearInterval(countdownTimerRef.current);
          }
          setTimeout(() => {
            finalizeGuardRef.current = false;
            thirtySecondAlertRef.current = false;
            gameStartTimeRef.current = Date.now();
            setTimeLeft(TOTAL_SECONDS);
            setBannerMessage('GO!');
            setPhase('PLAYING');
          }, 250);
          return 0;
        }
        return current - 1;
      });
    }, 900);
  };

  const updateCard = (wordId: string, updater: (card: PuzzleGameCardState) => PuzzleGameCardState) => {
    setCards((previous) => previous.map((card) => (card.word.id === wordId ? updater(card) : card)));
  };

  const activateCard = async (card: PuzzleGameCardState) => {
    if (phase !== 'PLAYING' || card.isSolved || card.isLocked) return;

    setActiveCardId(card.word.id);
    const activatedAtMs = card.activatedAtMs ?? (gameStartTimeRef.current ? Date.now() - gameStartTimeRef.current : 0);
    updateCard(card.word.id, (current) => ({
      ...current,
      isInputOpen: true,
      activatedAtMs,
    }));

    setTimeout(() => inputRefs.current[card.word.id]?.focus(), 0);
    await playWordPronunciation(card.word.text, card.word.language || 'en');
  };

  const useHint = (card: PuzzleGameCardState) => {
    if (phase !== 'PLAYING' || card.hintUsed || card.isSolved || card.isLocked) return;
    setActiveCardId(card.word.id);
    updateCard(card.word.id, (current) => ({ ...current, hintUsed: true }));
  };

  const findNextPlayableCard = (currentWordId: string) => {
    if (cards.length === 0) {
      return null;
    }

    const currentIndex = cards.findIndex((card) => card.word.id === currentWordId);
    const orderedCards = currentIndex >= 0
      ? [...cards.slice(currentIndex + 1), ...cards.slice(0, currentIndex)]
      : cards;

    return orderedCards.find((nextCard) => !nextCard.isSolved && !nextCard.isLocked && nextCard.word.id !== currentWordId) || null;
  };

  const submitAnswer = (card: PuzzleGameCardState) => {
    if (phase !== 'PLAYING' || card.isSolved || card.isLocked) return;

    const normalizedInput = normalizePuzzleAnswer(card.inputValue);
    const normalizedAnswer = normalizePuzzleAnswer(card.word.text);
    const nextAttempts = card.attemptsUsed + 1;
    const nextPlayableCard = findNextPlayableCard(card.word.id);

    if (normalizedInput === normalizedAnswer) {
      const solvedAtMs = gameStartTimeRef.current ? Date.now() - gameStartTimeRef.current : 0;
      updateCard(card.word.id, (current) => ({
        ...current,
        attemptsUsed: nextAttempts,
        isSolved: true,
        isLocked: true,
        isInputOpen: false,
        solvedAtMs,
        inputValue: current.word.text,
      }));
      setActiveCardId(nextPlayableCard?.word.id || null);
      playDing();
      return;
    }

    playBuzzer();
    updateCard(card.word.id, (current) => ({
      ...current,
      attemptsUsed: nextAttempts,
      isLocked: nextAttempts >= 3,
      isInputOpen: false,
      inputValue: '',
    }));
    setActiveCardId(nextPlayableCard?.word.id || (nextAttempts >= 3 ? null : card.word.id));
  };

  const finishGame = async (timedOut: boolean = false) => {
    if (finalizeGuardRef.current) return;
    finalizeGuardRef.current = true;

    await stopCurrentAudio();

    const now = Date.now();
    const elapsedMs = gameStartTimeRef.current ? now - gameStartTimeRef.current : (TOTAL_SECONDS - timeLeft) * 1000;
    const results: PuzzleCardResult[] = cards.map((card) => ({
      wordId: card.word.id,
      wordText: card.word.text,
      correct: card.isSolved,
      attemptsUsed: card.attemptsUsed,
      hintUsed: card.hintUsed,
      solvedAtMs: card.solvedAtMs,
      activatedAtMs: card.activatedAtMs,
    }));

    const summary = calculatePuzzleGameSummary(
      results,
      elapsedMs,
      selectionMode,
      selectionOverlapRate,
      rankingEligible,
      rankingIneligibleReason,
    );
    setResult(summary);
    setPhase('RESULT');

    if (timedOut) {
      setBannerMessage('Time up');
    }

    setIsSubmitting(true);
    try {
      await onComplete(summary);
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    if (phase !== 'PLAYING') return;
    if (cards.length > 0 && cards.every((card) => card.isSolved || card.isLocked)) {
      void finishGame(false);
    }
  }, [cards, phase]);

  const updateInput = (wordId: string, value: string) => {
    if (phase !== 'PLAYING') return;
    updateCard(wordId, (current) => ({ ...current, inputValue: value }));
  };

  const summaryCards = result
    ? [
        { labelEn: 'Total Score', labelZh: '总分', value: Math.round(result.totalScore) },
        { labelEn: 'Accuracy', labelZh: '正确率', value: `${Math.round(result.accuracyRate * 100)}%` },
        { labelEn: 'Time Used', labelZh: '用时', value: `${result.timeUsedSeconds}s` },
        { labelEn: 'Hint Usage', labelZh: '提示使用', value: `${result.hintsUsed}/${result.wordsTotal}` },
      ]
    : [];

  const playingStatus =
    phase === 'PLAYING'
      ? bannerMessage || (timeLeft <= 5 ? `${timeLeft}` : null)
      : null;

  const playingStatusTranslation =
    playingStatus === 'Time up'
      ? '时间到'
      : playingStatus === 'GO!'
        ? '开始！'
        : playingStatus === '30 seconds remaining'
          ? '还剩 30 秒'
          : timeLeft <= 5 && phase === 'PLAYING'
            ? `最后 ${timeLeft} 秒`
            : '';

  return (
    <div className="fixed inset-0 z-[90] overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(163,255,0,0.12),_transparent_28%),linear-gradient(180deg,_rgba(9,12,16,0.96),_rgba(12,14,18,1))]">
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(180deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:26px_26px] opacity-30" />
      <div className="relative flex h-[100dvh] flex-col px-4 pb-4 pt-20 md:px-8 md:pb-6 md:pt-24">
        <div className="sticky top-16 z-30 mb-4 flex shrink-0 items-start justify-between gap-4 bg-[linear-gradient(180deg,rgba(12,14,18,0.94),rgba(12,14,18,0.72),transparent)] pb-3 backdrop-blur-sm">
          <div>
            <div className="text-xs font-mono uppercase tracking-[0.35em] text-electric-green/80">OPTION 3</div>
            <h2 className="font-headline text-3xl text-white md:text-4xl">
              <HoverTranslationText text="Puzzle Game" translation="字谜游戏" />
            </h2>
          </div>
          <button
            onClick={onCancel}
            className="rounded-2xl border border-mid-charcoal bg-dark-charcoal/70 px-4 py-2 text-xs font-mono uppercase tracking-[0.25em] text-text-light transition-colors hover:border-white hover:text-white"
          >
            <HoverTranslationText text="Exit" translation="退出" />
          </button>
        </div>

        {bannerMessage && phase !== 'RESULT' && phase !== 'PLAYING' && (
          <div className="mb-3 rounded-2xl border border-electric-green/40 bg-electric-green/10 px-4 py-3 text-center font-mono text-sm text-electric-green">
            <HoverTranslationText text={bannerMessage.toUpperCase()} translation={bannerMessage === 'Time up' ? '时间到' : bannerMessage === 'GO!' ? '开始！' : '还剩 30 秒'} />
          </div>
        )}

        {phase === 'INTRO' && (
          <div className="flex flex-1 items-center justify-center">
            <div className="w-full max-w-3xl rounded-[32px] border border-mid-charcoal bg-dark-charcoal/80 p-8 shadow-2xl backdrop-blur-md md:p-10">
              <div className="grid gap-8 md:grid-cols-[1.15fr_0.85fr]">
                <div className="space-y-5">
                  <p className="max-w-2xl text-sm leading-7 text-text-light md:text-base">
                    <HoverTranslationText
                      text="Listen first, then type the exact word. Each card hides its image behind an extreme blur, gives you one visual hint, and locks after three failed attempts."
                      translation="先听发音，再输入完整单词。每张卡都以极强模糊遮住图片，只提供一次视觉提示，三次答错后锁定。"
                    />
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-3xl border border-mid-charcoal bg-light-charcoal/30 p-4">
                      <div className="text-xs font-mono uppercase tracking-[0.3em] text-text-dark">Grid</div>
                      <div className="mt-2 text-2xl font-headline text-white">3 x 3</div>
                    </div>
                    <div className="rounded-3xl border border-mid-charcoal bg-light-charcoal/30 p-4">
                      <div className="text-xs font-mono uppercase tracking-[0.3em] text-text-dark">Timer</div>
                      <div className="mt-2 text-2xl font-headline text-white">90s</div>
                    </div>
                    <div className="rounded-3xl border border-mid-charcoal bg-light-charcoal/30 p-4">
                      <div className="text-xs font-mono uppercase tracking-[0.3em] text-text-dark">Attempts</div>
                      <div className="mt-2 text-2xl font-headline text-white">3 / word</div>
                    </div>
                    <div className="rounded-3xl border border-mid-charcoal bg-light-charcoal/30 p-4">
                      <div className="text-xs font-mono uppercase tracking-[0.3em] text-text-dark">Hint</div>
                      <div className="mt-2 text-2xl font-headline text-white">1 visual</div>
                    </div>
                  </div>
                </div>

                <div className="rounded-[28px] border border-electric-green/25 bg-[linear-gradient(180deg,rgba(163,255,0,0.10),rgba(163,255,0,0.03))] p-6">
                  <div className="text-xs font-mono uppercase tracking-[0.3em] text-electric-green/70">
                    <HoverTranslationText text="Preparation" translation="准备状态" />
                  </div>
                  <div className="mt-4 text-sm leading-7 text-text-light">
                    <HoverTranslationText
                      text={`Image-ready words available: ${candidateCount}. You need at least 9 to start.`}
                      translation={`当前可用于字谜游戏的带图单词：${candidateCount}。至少需要 9 个才能开始。`}
                    />
                  </div>
                  <button
                    onClick={prepareGame}
                    disabled={!canPrepare}
                    className={`mt-8 w-full rounded-2xl px-5 py-4 font-headline text-sm uppercase tracking-[0.3em] transition-all ${
                      canPrepare
                        ? 'bg-electric-green text-charcoal hover:-translate-y-1 hover:shadow-[0_0_30px_rgba(163,255,0,0.25)]'
                        : 'cursor-not-allowed bg-mid-charcoal text-text-dark'
                    }`}
                  >
                    <HoverTranslationText text="Load Puzzle Run" translation="开始准备游戏" />
                  </button>
                  {!canPrepare && (
                    <div className="mt-4 text-xs font-mono text-red-300">
                      <HoverTranslationText text="Add more image-backed words to unlock this mode." translation="请先给更多单词配图后再解锁此模式。" />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {phase === 'PREPARING' && (
          <div className="flex flex-1 items-center justify-center">
            <div className="w-full max-w-2xl rounded-[32px] border border-mid-charcoal bg-dark-charcoal/80 p-8 shadow-2xl backdrop-blur-md md:p-10">
              <div className="text-center">
                <div className="inline-flex rounded-full border border-electric-blue/30 bg-electric-blue/10 px-4 py-2 text-xs font-mono uppercase tracking-[0.3em] text-electric-blue">
                  <HoverTranslationText text="Preparing Puzzle Run" translation="正在准备字谜游戏" />
                </div>
                <h3 className="mt-6 font-headline text-3xl text-white">
                  <HoverTranslationText text="Selecting Words + Loading Audio" translation="单词遴选 + 音频加载" />
                </h3>
                <p className="mx-auto mt-4 max-w-xl text-sm leading-7 text-text-light">{selectionMessage}</p>
              </div>

              <div className="mt-8 space-y-6 rounded-[28px] border border-mid-charcoal bg-light-charcoal/30 p-6">
                <div>
                  <div className="flex items-center justify-between text-xs font-mono uppercase tracking-[0.28em] text-text-dark">
                    <span><HoverTranslationText text="Selection Strategy" translation="选词策略" /></span>
                    <span>{selectionMode === 'smart' ? 'SMART' : 'RANDOM'}</span>
                  </div>
                  <div className="mt-3 text-sm text-white">
                    <HoverTranslationText
                      text={selectionMode === 'smart' ? 'Smart Selection Assistant is prioritizing the most valuable image-backed words.' : 'Random selection is pulling 9 image-backed words from your library.'}
                      translation={selectionMode === 'smart' ? '智能选择助手正在优先抽取最值得练习的带图单词。' : '系统正从你的带图词库中随机抽取 9 个单词。'}
                    />
                  </div>
                </div>

                <div>
                  <div className="mb-3 flex items-center justify-between text-xs font-mono uppercase tracking-[0.28em] text-text-dark">
                    <span><HoverTranslationText text="Audio Loading" translation="音频加载" /></span>
                    <span>{audioProgress.current}/{audioProgress.total}</span>
                  </div>
                  <div className="h-3 overflow-hidden rounded-full bg-dark-charcoal">
                    <div
                      className="h-full rounded-full bg-electric-green transition-all duration-300"
                      style={{ width: `${(audioProgress.current / Math.max(audioProgress.total, 1)) * 100}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {phase === 'READY' && (
          <div className="flex flex-1 items-center justify-center">
            <div className="w-full max-w-3xl rounded-[32px] border border-mid-charcoal bg-dark-charcoal/80 p-8 shadow-2xl backdrop-blur-md md:p-10">
              <div className="grid gap-6 md:grid-cols-[1.1fr_0.9fr] md:items-center">
                <div>
                  <div className="text-xs font-mono uppercase tracking-[0.3em] text-electric-green/80">
                    <HoverTranslationText text="Resources Ready" translation="资源已就绪" />
                  </div>
                  <h3 className="mt-3 font-headline text-3xl text-white">
                    <HoverTranslationText text="Nine cards are locked in." translation="九张卡片已就位。" />
                  </h3>
                  <p className="mt-4 text-sm leading-7 text-text-light">
                    <HoverTranslationText
                      text="When the countdown ends, your 90-second timer starts immediately. Tap the speaker to hear the word, type it correctly, and save your hints for the hardest images."
                      translation="倒计时结束后，90 秒主计时会立刻开始。点击喇叭听发音，输入正确单词，把提示留给最难的图片。"
                    />
                  </p>
                </div>

                <button
                  onClick={startCountdown}
                  className="rounded-[28px] border border-electric-green/30 bg-electric-green/10 px-6 py-10 text-center text-charcoal animate-pulse shadow-[0_0_40px_rgba(163,255,0,0.15)]"
                >
                  <div className="font-headline text-3xl uppercase tracking-[0.28em] text-electric-green">
                    <HoverTranslationText text="Start Game" translation="开始游戏" />
                  </div>
                  <div className="mt-3 text-xs font-mono uppercase tracking-[0.28em] text-electric-green/80">
                    <HoverTranslationText text="Breathing button means everything is loaded." translation="按钮呼吸闪烁表示资源已全部就绪。" />
                  </div>
                </button>
              </div>
            </div>
          </div>
        )}

        {phase === 'COUNTDOWN' && (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <div className="text-xs font-mono uppercase tracking-[0.4em] text-electric-green/80">Countdown</div>
              <div className="mt-6 font-headline text-[clamp(72px,16vw,180px)] leading-none text-white">
                {countdownValue > 0 ? countdownValue : 'GO!'}
              </div>
            </div>
          </div>
        )}

        {phase === 'PLAYING' && (
          <div className="flex flex-1 flex-col gap-4 overflow-hidden">
            <div className="grid shrink-0 gap-3 rounded-[30px] border border-mid-charcoal bg-dark-charcoal/70 p-4 md:grid-cols-[1fr_auto_auto_auto] md:items-center">
              <div>
                <div className="text-xs font-mono uppercase tracking-[0.3em] text-text-dark">
                  <HoverTranslationText text="Puzzle Clock" translation="游戏计时" />
                </div>
                <div className={`mt-1 font-headline text-4xl ${timeLeft <= 5 ? 'text-red-400' : 'text-white'}`}>{formatClock(timeLeft)}</div>
              </div>
              <div className={`rounded-2xl border px-4 py-3 text-center ${
                playingStatus
                  ? timeLeft <= 5 || playingStatus === 'Time up'
                    ? 'border-red-500/40 bg-red-500/10'
                    : 'border-electric-green/30 bg-electric-green/10'
                  : 'border-mid-charcoal bg-light-charcoal/20'
              }`}>
                <div className="text-xs font-mono uppercase tracking-[0.3em] text-text-dark">
                  <HoverTranslationText text="Alert" translation="提醒" />
                </div>
                <div className={`mt-1 font-headline text-lg ${timeLeft <= 5 || playingStatus === 'Time up' ? 'text-red-300' : 'text-electric-green'}`}>
                  {playingStatus ? (
                    <HoverTranslationText text={playingStatus.toUpperCase()} translation={playingStatusTranslation} />
                  ) : (
                    <HoverTranslationText text="Focused" translation="进行中" />
                  )}
                </div>
              </div>
              <div className="rounded-2xl border border-mid-charcoal bg-light-charcoal/30 px-4 py-3 text-center">
                <div className="text-xs font-mono uppercase tracking-[0.3em] text-text-dark">Solved</div>
                <div className="mt-1 font-headline text-2xl text-electric-green">{cards.filter((card) => card.isSolved).length}/9</div>
              </div>
              <div className="rounded-2xl border border-mid-charcoal bg-light-charcoal/30 px-4 py-3 text-center">
                <div className="text-xs font-mono uppercase tracking-[0.3em] text-text-dark">Mode</div>
                <div className="mt-1 font-headline text-xl text-white">{selectionMode === 'smart' ? 'SMART' : 'RANDOM'}</div>
              </div>
            </div>

            <div className="grid flex-1 grid-cols-3 gap-3" style={{ height: boardHeight }}>
              {cards.map((card) => {
                const inputDisabled = phase !== 'PLAYING' || card.isLocked || card.isSolved || timeLeft <= 0;
                const isActiveCard = activeCardId === card.word.id && !card.isSolved && !card.isLocked;

                return (
                  <div
                    key={card.word.id}
                    className={`relative grid min-h-0 overflow-hidden rounded-[28px] border p-3 ${
                      card.isSolved
                        ? 'border-green-400 bg-green-500/10'
                        : card.isLocked
                          ? 'border-red-500/40 bg-red-500/10'
                          : isActiveCard
                            ? 'border-electric-blue bg-electric-blue/8 shadow-[0_0_0_1px_rgba(96,165,250,0.35),0_0_22px_rgba(96,165,250,0.18)]'
                          : 'border-mid-charcoal bg-dark-charcoal/70'
                    }`}
                    style={{ gridTemplateRows: '1fr auto' }}
                  >
                    <button
                      onClick={() => useHint(card)}
                      disabled={card.hintUsed || card.isSolved || card.isLocked}
                      className={`absolute right-3 top-3 z-20 flex h-10 w-10 items-center justify-center rounded-full border text-sm transition-colors ${
                        card.hintUsed || card.isSolved || card.isLocked
                          ? 'cursor-not-allowed border-mid-charcoal bg-mid-charcoal/50 text-text-dark'
                          : 'border-electric-green/30 bg-dark-charcoal/70 text-electric-green hover:border-electric-green hover:bg-electric-green/10'
                      }`}
                    >
                      <span className="material-symbols-outlined">lightbulb</span>
                    </button>

                    <div className="relative min-h-0 overflow-hidden rounded-[22px] border border-mid-charcoal bg-black/30">
                      {card.imageUrl ? (
                        <img
                          src={card.imageUrl}
                          alt={card.word.text}
                          className={`h-full w-full object-cover transition-all duration-500 ${card.hintUsed || card.isSolved ? 'scale-100 blur-0' : 'scale-125 blur-[26px]'}`}
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center bg-mid-charcoal text-text-dark">
                          <span className="material-symbols-outlined text-5xl">image</span>
                        </div>
                      )}

                      {!card.isSolved && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/35">
                          <button
                            onClick={() => void activateCard(card)}
                            className="flex h-16 w-16 items-center justify-center rounded-full border border-white/20 bg-white/10 text-white shadow-2xl backdrop-blur-md transition-transform hover:scale-105 hover:bg-white/15"
                          >
                            <span className="material-symbols-outlined text-3xl">volume_up</span>
                          </button>
                        </div>
                      )}

                      {card.isSolved && (
                        <div className="absolute inset-0 flex items-center justify-center bg-green-500/10 backdrop-blur-[1px]">
                          <div className="rounded-full border border-green-300/30 bg-green-500/20 p-5 text-5xl">✅</div>
                        </div>
                      )}

                    </div>

                    <div className="mt-3 space-y-2">
                      <div className="flex items-center gap-1.5">
                        {Array.from({ length: 3 }).map((_, index) => {
                          const successfulAttemptIndex = card.isSolved ? Math.max(card.attemptsUsed - 1, 0) : null;
                          const isSuccessfulAttempt = successfulAttemptIndex !== null && index === successfulAttemptIndex;
                          const failedAttemptsCount = card.isSolved ? Math.max(card.attemptsUsed - 1, 0) : card.attemptsUsed;
                          const isFailedAttempt = index < failedAttemptsCount;
                          const isRemainingAttempt = !isSuccessfulAttempt && !isFailedAttempt;

                          return (
                            <span
                              key={`${card.word.id}-attempt-${index}`}
                              className={`h-1.5 flex-1 rounded-full transition-colors ${
                                isSuccessfulAttempt
                                  ? 'bg-electric-green shadow-[0_0_10px_rgba(34,197,94,0.55)]'
                                  : isFailedAttempt
                                  ? 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.55)]'
                                  : isRemainingAttempt
                                    ? 'bg-electric-blue/55 shadow-[0_0_8px_rgba(96,165,250,0.35)]'
                                    : 'bg-mid-charcoal'
                              }`}
                            />
                          );
                        })}
                      </div>
                      {card.isInputOpen && !card.isSolved && !card.isLocked ? (
                        <div className="rounded-2xl border border-electric-blue/30 bg-dark-charcoal/80 p-2 shadow-[0_0_20px_rgba(96,165,250,0.15)]">
                          <input
                            ref={(node) => {
                              inputRefs.current[card.word.id] = node;
                            }}
                            value={card.inputValue}
                            disabled={inputDisabled}
                            onChange={(event) => updateInput(card.word.id, event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                submitAnswer(card);
                              }
                            }}
                            className="w-full bg-transparent px-3 py-2 text-center font-serif text-lg tracking-[0.04em] text-white outline-none placeholder:text-text-dark"
                            placeholder="type here"
                          />
                          <div className="mt-2 text-center text-[10px] font-mono uppercase tracking-[0.24em] text-text-dark">
                            <HoverTranslationText text="Press Enter To Submit" translation="按回车键提交" />
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-2xl border border-mid-charcoal bg-light-charcoal/20 px-3 py-3 text-center text-[11px] font-mono text-text-dark">
                          {card.isSolved ? (
                            <HoverTranslationText text="Solved" translation="已答对" />
                          ) : card.isLocked ? (
                            <HoverTranslationText text="Locked" translation="已锁定" />
                          ) : (
                            <HoverTranslationText text="Tap speaker to answer" translation="点击喇叭开始作答" />
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {phase === 'RESULT' && result && (
          <div className="flex flex-1 items-center justify-center overflow-y-auto py-4">
            <div className="w-full max-w-4xl rounded-[34px] border border-mid-charcoal bg-dark-charcoal/85 p-8 shadow-2xl backdrop-blur-md md:p-10">
              <div className="grid gap-8 md:grid-cols-[1.2fr_0.8fr]">
                <div>
                  <div className="text-xs font-mono uppercase tracking-[0.35em] text-electric-green/80">
                    <HoverTranslationText text="Round Complete" translation="本局完成" />
                  </div>
                  <h3 className="mt-3 font-headline text-4xl text-white">
                    <HoverTranslationText text="Puzzle run archived." translation="字谜成绩已归档。" />
                  </h3>
                  <div className="mt-6 grid gap-3 sm:grid-cols-2">
                    {summaryCards.map((item) => (
                      <div key={item.labelEn} className="rounded-3xl border border-mid-charcoal bg-light-charcoal/25 p-4">
                        <div className="text-xs font-mono uppercase tracking-[0.3em] text-text-dark">
                          <HoverTranslationText text={item.labelEn} translation={item.labelZh} />
                        </div>
                        <div className="mt-2 font-headline text-3xl text-white">{item.value}</div>
                      </div>
                    ))}
                  </div>

                  <div className="mt-6 rounded-[28px] border border-mid-charcoal bg-light-charcoal/20 p-5 text-sm leading-7 text-text-light">
                    <div>
                      <HoverTranslationText
                        text={`Leaderboard metrics: total ${Math.round(result.totalScore)}, accuracy ${Math.round(result.accuracyRate * 100)}%, speed ${result.speedScore}, hint-free ${result.noHintScore}.`}
                        translation={`排行榜指标：总分 ${Math.round(result.totalScore)}，正确率 ${Math.round(result.accuracyRate * 100)}%，速度分 ${result.speedScore}，无提示分 ${result.noHintScore}。`}
                      />
                    </div>
                    <div className="mt-2">
                      <HoverTranslationText
                        text={`Selection mode: ${result.selectionMode.toUpperCase()} · remaining time ${result.secondsRemaining}s · solved without hint ${result.solvedWithoutHint}/${result.wordsTotal}.`}
                        translation={`本局选词模式：${result.selectionMode === 'smart' ? '智能' : '随机'} · 剩余时间 ${result.secondsRemaining} 秒 · 无提示答对 ${result.solvedWithoutHint}/${result.wordsTotal}。`}
                      />
                    </div>
                    <div className="mt-2">
                      <HoverTranslationText
                        text={`Highest overlap with today's earlier puzzle runs: ${Math.round(result.overlapRate * 100)}%.${result.rankingEligible ? '' : ' This round is not eligible for ranking.'}`}
                        translation={`与今天更早字谜局的最高重复率：${Math.round(result.overlapRate * 100)}%。${result.rankingEligible ? '' : ' 本局不计入排行榜成绩。'}`}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex flex-col justify-between rounded-[30px] border border-electric-blue/20 bg-electric-blue/5 p-6">
                  <div>
                    <div className="text-xs font-mono uppercase tracking-[0.3em] text-electric-blue/70">
                      <HoverTranslationText text="Submission" translation="提交状态" />
                    </div>
                    <div className="mt-4 text-sm leading-7 text-text-light">
                      <HoverTranslationText
                        text={
                          !result.rankingEligible
                            ? 'Overlap is above 80%, so this round stays visible locally but will not be submitted to the puzzle leaderboard.'
                            : isSubmitting
                              ? 'Writing round data to the independent puzzle leaderboard...'
                              : 'Round data has been sent to the independent puzzle leaderboard pipeline.'
                        }
                        translation={
                          !result.rankingEligible
                            ? '由于重复率超过 80%，本局结果只保留在当前页面中，不提交到字谜排行榜。'
                            : isSubmitting
                              ? '正在将本局成绩写入独立的字谜排行榜...'
                              : '本局成绩已提交到独立的字谜排行榜链路。'
                        }
                      />
                    </div>
                  </div>

                  <button
                    onClick={onCancel}
                    className="mt-8 rounded-2xl bg-electric-green px-4 py-4 font-headline text-sm uppercase tracking-[0.3em] text-charcoal transition-transform hover:-translate-y-1"
                  >
                    <HoverTranslationText text="Return to Dashboard" translation="返回主界面" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {preparationError && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-2xl border border-red-500/40 bg-red-500/15 px-4 py-3 text-sm text-red-200 shadow-2xl">
            {preparationError}
          </div>
        )}
      </div>
    </div>
  );
};

export default PuzzleGameMode;