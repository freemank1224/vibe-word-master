import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, LayoutGroup } from 'motion/react';
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
  lastWrongInput: null,
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
  const [hasStarted, setHasStarted] = useState(false);
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
  const [showExitConfirm, setShowExitConfirm] = useState(false);

  const gameStartTimeRef = useRef<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  const thirtySecondAlertRef = useRef(false);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const finalizeGuardRef = useRef(false);
  const resultSubmittedRef = useRef(false);

  const candidateCount = useMemo(() => getPuzzleCandidateWords(allWords).length, [allWords]);
  const canPrepare = candidateCount >= 9;
  const activeCard = useMemo(() => cards.find((card) => card.word.id === activeCardId) || null, [cards, activeCardId]);

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

    setHasStarted(true);
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
      lastWrongInput: current.inputValue.trim() || current.lastWrongInput,
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
    setPhase('REVIEW');

    if (timedOut) {
      setBannerMessage('Time up');
    }
  };

  // Called when the user advances past the REVIEW screen. This is what actually
  // fires onComplete → which (in App.tsx) bumps error_count += 1 for every missed
  // word via syncGameResultsToWordStats, then records the round + awards coins.
  const proceedToResult = async () => {
    if (resultSubmittedRef.current || !result) return;
    resultSubmittedRef.current = true;
    setIsSubmitting(true);
    setPhase('RESULT');
    try {
      await onComplete(result);
    } finally {
      setIsSubmitting(false);
    }
  };

  // From the REVIEW screen, exiting would discard an unsubmitted round (score +
  // error-weight bumps never get recorded). Warn the user and let them choose.
  const handleExitClick = () => {
    if (phase === 'REVIEW') {
      setShowExitConfirm(true);
    } else {
      onCancel();
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

  // A single card renderer used in BOTH layouts (3×3 preview + expanded/compact split).
  // Because every card carries a stable `layoutId`, motion smoothly flies each card
  // between its 3×3 slot, the big left pane, and the 4×2 right grid on every change.
  const renderCard = (card: PuzzleGameCardState, expanded: boolean) => {
    const isActiveCard = activeCardId === card.word.id && !card.isSolved && !card.isLocked;
    const inputDisabled = phase !== 'PLAYING' || card.isLocked || card.isSolved || timeLeft <= 0;
    const revealImage = card.hintUsed || card.isSolved;

    const renderPips = (large: boolean) => (
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
              className={`flex-1 rounded-full transition-colors ${large ? 'h-1.5' : 'h-1'} ${
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
    );

    const containerClass = expanded
      ? `relative h-full w-full overflow-hidden rounded-[32px] border transition-colors ${
          card.isSolved
            ? 'border-green-400 bg-green-500/10'
            : card.isLocked
              ? 'border-red-500/40 bg-red-500/10'
              : 'border-electric-blue bg-electric-blue/8 shadow-[0_0_0_1px_rgba(96,165,250,0.42),0_0_28px_rgba(96,165,250,0.28)]'
        }`
      : `relative grid h-full w-full overflow-hidden rounded-[18px] border p-2 transition-colors duration-300 ${
          card.isSolved
            ? 'border-green-400/70 bg-green-500/10'
            : card.isLocked
              ? 'border-red-500/40 bg-red-500/10'
              : isActiveCard
                ? 'border-electric-blue/70 bg-electric-blue/5 shadow-[0_0_0_1px_rgba(96,165,250,0.30),0_0_18px_rgba(96,165,250,0.18)]'
                : 'border-mid-charcoal bg-dark-charcoal/70 hover:border-electric-blue/50 hover:bg-electric-blue/5'
        }`;

    return (
      <motion.div
        key={card.word.id}
        layoutId={`puzzle-card-${card.word.id}`}
        layout
        transition={{ layout: { duration: 0.45, ease: [0.22, 1, 0.36, 1] } }}
        className={containerClass}
        style={expanded ? undefined : { gridTemplateRows: '1fr auto' }}
      >
        {isActiveCard && (
          <div className="pointer-events-none absolute inset-0 z-10 rounded-[inherit] border border-electric-blue/70 animate-pulse shadow-[0_0_0_1px_rgba(96,165,250,0.55),0_0_22px_rgba(96,165,250,0.4),0_0_42px_rgba(96,165,250,0.22)]" />
        )}

        {expanded ? (
          <>
            <button
              onClick={() => useHint(card)}
              disabled={card.hintUsed || card.isSolved || card.isLocked}
              className={`absolute right-4 top-4 z-30 flex h-12 w-12 items-center justify-center rounded-full border backdrop-blur-sm transition-colors ${
                card.hintUsed || card.isSolved || card.isLocked
                  ? 'cursor-not-allowed border-mid-charcoal bg-mid-charcoal/60 text-text-dark'
                  : 'border-electric-green/40 bg-dark-charcoal/70 text-electric-green hover:border-electric-green hover:bg-electric-green/15'
              }`}
            >
              <span className="material-symbols-outlined">lightbulb</span>
            </button>

            {/* Image fills the entire card */}
            <div className="absolute inset-0">
              {card.imageUrl ? (
                <img
                  src={card.imageUrl}
                  alt={card.word.text}
                  className={`h-full w-full object-contain transition-all duration-500 ${revealImage ? 'scale-100 blur-0' : 'scale-150 blur-[52px]'}`}
                />
              ) : (
                <div className="flex h-full items-center justify-center bg-mid-charcoal text-text-dark">
                  <span className="material-symbols-outlined text-7xl">image</span>
                </div>
              )}

              {card.isSolved && (
                <div className="absolute inset-0 flex items-center justify-center bg-green-500/10 backdrop-blur-[1px]">
                  <div className="rounded-full border border-green-300/30 bg-green-500/20 p-6 text-6xl">✅</div>
                </div>
              )}
            </div>

            {/* Big input overlaid on the lower portion of the image (kept within roughly the bottom third) */}
            {!card.isSolved && !card.isLocked && (
              <div className="absolute inset-x-0 bottom-0 z-20 bg-[linear-gradient(to_top,rgba(0,0,0,0.92)_0%,rgba(0,0,0,0.78)_45%,rgba(0,0,0,0.35)_75%,transparent_100%)] px-5 pb-5 pt-14">
                {renderPips(true)}
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
                  className="mt-3 w-full rounded-2xl border border-electric-blue/50 bg-white/10 px-6 py-4 text-center font-serif text-[64px] leading-none tracking-[0.1em] text-white shadow-[0_0_24px_rgba(96,165,250,0.18)] outline-none backdrop-blur-md placeholder:text-white/40 focus:border-electric-blue focus:bg-white/15"
                  placeholder="type here"
                />
                <div className="mt-2 text-center text-[10px] font-mono uppercase tracking-[0.24em] text-white/55">
                  <HoverTranslationText text="Press Enter To Submit" translation="按回车键提交" />
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="relative min-h-0 overflow-hidden rounded-[12px] border border-mid-charcoal bg-black/30">
              {card.imageUrl ? (
                <img
                  src={card.imageUrl}
                  alt={card.word.text}
                  className={`h-full w-full object-cover transition-all duration-500 ${revealImage ? 'scale-100 blur-0' : 'scale-125 blur-[26px]'}`}
                />
              ) : (
                <div className="flex h-full items-center justify-center bg-mid-charcoal text-text-dark">
                  <span className="material-symbols-outlined text-3xl">image</span>
                </div>
              )}

              {!card.isSolved && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/35">
                  <button
                    onClick={() => void activateCard(card)}
                    className="flex h-12 w-12 items-center justify-center rounded-full border border-white/20 bg-white/10 text-white shadow-2xl backdrop-blur-md transition-transform hover:scale-105 hover:bg-white/15"
                  >
                    <span className="material-symbols-outlined text-2xl">volume_up</span>
                  </button>
                </div>
              )}

              {card.isSolved && (
                <div className="absolute inset-0 flex items-center justify-center bg-green-500/10 backdrop-blur-[1px]">
                  <div className="rounded-full border border-green-300/30 bg-green-500/20 p-2 text-xl">✅</div>
                </div>
              )}

              {card.isLocked && !card.isSolved && (
                <div className="absolute inset-0 flex items-center justify-center bg-red-500/10 backdrop-blur-[1px]">
                  <span className="material-symbols-outlined text-3xl text-red-300">lock</span>
                </div>
              )}
            </div>

            <div className="mt-1.5 space-y-1.5">
              {renderPips(false)}
              <div className="rounded-md border border-mid-charcoal/70 bg-light-charcoal/20 px-2 py-1 text-center text-[9px] font-mono uppercase tracking-[0.18em] text-text-dark">
                {card.isSolved ? '✓ solved' : card.isLocked ? 'locked' : 'tap ▶'}
              </div>
            </div>
          </>
        )}
      </motion.div>
    );
  };

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
            onClick={handleExitClick}
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
          <div className="grid flex-1 min-h-0 gap-4 overflow-hidden" style={{ gridTemplateRows: 'auto minmax(0, 1fr)' }}>
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

            <LayoutGroup>
              {(!hasStarted || !activeCard) ? (
                <div className="grid min-h-0 grid-cols-3 gap-3" style={{ gridTemplateRows: 'repeat(3, minmax(0, 1fr))' }}>
                  {cards.map((card) => renderCard(card, false))}
                </div>
              ) : (
                <div className="flex min-h-0 gap-3">
                  <div className="h-full shrink-0" style={{ aspectRatio: '1 / 1' }}>
                    {activeCard ? (
                      renderCard(activeCard, true)
                    ) : (
                      <div className="flex h-full w-full items-center justify-center rounded-[32px] border border-mid-charcoal bg-dark-charcoal/70 px-6 text-center text-xs font-mono uppercase tracking-[0.24em] text-text-dark">
                        <HoverTranslationText text="Selecting next word" translation="正在挑选下一个词" />
                      </div>
                    )}
                  </div>
                  <div className="grid min-h-0 flex-1 grid-cols-2 gap-2" style={{ gridTemplateRows: 'repeat(4, minmax(0, 1fr))' }}>
                    {cards
                      .filter((card) => card.word.id !== activeCard?.word.id)
                      .map((card) => renderCard(card, false))}
                  </div>
                </div>
              )}
            </LayoutGroup>
          </div>
        )}

        {phase === 'REVIEW' && result && (
          <div className="flex flex-1 flex-col items-center gap-5 overflow-y-auto py-2">
            <div className="shrink-0 text-center">
              <div className="text-xs font-mono uppercase tracking-[0.35em] text-electric-blue/80">
                <HoverTranslationText text="Round Review" translation="本局复盘" />
              </div>
              <h3 className="mt-2 font-headline text-3xl text-white md:text-4xl">
                <HoverTranslationText text="See every word" translation="九词全览" />
              </h3>
              <p className="mx-auto mt-1 max-w-xl text-xs leading-6 text-text-light md:text-sm">
                {cards.filter((c) => c.isSolved).length === cards.length ? (
                  <HoverTranslationText
                    text={`All ${cards.length} words solved — flawless run!`}
                    translation={`全部 ${cards.length} 个答对——完美通关！`}
                  />
                ) : (
                  <HoverTranslationText
                    text={`Images are now clear — ${cards.filter((c) => c.isSolved).length}/${cards.length} solved. Missed words (red) gain error weight and will be prioritized next time.`}
                    translation={`图片已清晰展示——本局答对 ${cards.filter((c) => c.isSolved).length}/${cards.length}。标红的词会增加错误权重，下次优先出现。`}
                  />
                )}
              </p>
            </div>

            <div className="grid w-full max-w-[min(58vh,500px)] h-[min(58vh,500px)] grid-cols-3 grid-rows-3 gap-3">
              {cards.map((card) => {
                const wrong = !card.isSolved;
                return (
                  <div
                    key={card.word.id}
                    className={`relative overflow-hidden rounded-[18px] border ${wrong ? 'border-red-500/60 bg-red-500/5' : 'border-green-400/60 bg-green-500/5'}`}
                  >
                    {card.imageUrl ? (
                      <img
                        src={card.imageUrl}
                        alt={card.word.text}
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center bg-mid-charcoal text-text-dark">
                        <span className="material-symbols-outlined text-4xl">image</span>
                      </div>
                    )}

                    <div className={`absolute left-2 top-2 z-20 flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold shadow-lg ${wrong ? 'bg-red-500/85 text-white' : 'bg-green-500/85 text-charcoal'}`}>
                      {wrong ? '✗' : '✓'}
                    </div>

                    <div className="absolute inset-x-0 bottom-0 z-10 bg-[linear-gradient(to_top,rgba(0,0,0,0.92)_0%,rgba(0,0,0,0.7)_50%,transparent_100%)] px-3 pb-2 pt-8">
                      <div className="font-serif text-lg leading-tight tracking-[0.04em] text-white md:text-xl">
                        {card.word.text}
                      </div>
                      {wrong ? (
                        <>
                          {card.lastWrongInput ? (
                            <div className="mt-0.5 truncate text-[11px] text-red-300 line-through">
                              {card.lastWrongInput}
                            </div>
                          ) : null}
                          <div className="mt-0.5 text-[9px] font-mono uppercase tracking-[0.18em] text-red-300/85">
                            <HoverTranslationText text="error_count +1" translation="错误权重 +1" />
                          </div>
                        </>
                      ) : (
                        <div className="mt-0.5 text-[9px] font-mono uppercase tracking-[0.18em] text-green-300/85">
                          {card.hintUsed ? <HoverTranslationText text="solved with hint" translation="提示答对" /> : <HoverTranslationText text="solved" translation="已答对" />}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <button
              onClick={() => void proceedToResult()}
              className="shrink-0 rounded-2xl bg-electric-green px-8 py-4 font-headline text-sm uppercase tracking-[0.3em] text-charcoal shadow-[0_0_30px_rgba(163,255,0,0.25)] transition-transform hover:-translate-y-1"
            >
              <HoverTranslationText text="Next: View Score" translation="下一步：查看成绩" />
            </button>
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

        {showExitConfirm && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-[28px] border border-mid-charcoal bg-dark-charcoal/95 p-6 shadow-2xl">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-amber-400/40 bg-amber-400/10 text-amber-300">
                  <span className="material-symbols-outlined">warning</span>
                </div>
                <h3 className="font-headline text-2xl text-white">
                  <HoverTranslationText text="Leave without saving?" translation="退出将不保留成绩？" />
                </h3>
              </div>
              <p className="mt-4 text-sm leading-6 text-text-light">
                <HoverTranslationText
                  text="If you exit now, this round's score and answer stats — including the error-weight bump for missed words — will NOT be saved. Go to the score screen to keep them."
                  translation="如果现在退出，本局得分与答题统计（含错词的错误权重提升）都不会保留。需进入成绩页才会保存。"
                />
              </p>
              <div className="mt-6 flex gap-3">
                <button
                  onClick={() => setShowExitConfirm(false)}
                  className="flex-1 rounded-2xl bg-electric-green px-4 py-3 font-headline text-sm uppercase tracking-[0.2em] text-charcoal transition-transform hover:-translate-y-0.5"
                >
                  <HoverTranslationText text="Keep Reviewing" translation="继续复盘" />
                </button>
                <button
                  onClick={() => {
                    setShowExitConfirm(false);
                    onCancel();
                  }}
                  className="flex-1 rounded-2xl border border-red-500/50 bg-red-500/15 px-4 py-3 font-headline text-sm uppercase tracking-[0.2em] text-red-200 transition-colors hover:bg-red-500/25"
                >
                  <HoverTranslationText text="Exit Anyway" translation="仍然退出" />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PuzzleGameMode;