import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { preloadWordAudio, playWordPronunciation, stopCurrentAudio } from '../services/pronunciationService';
import { playPuzzleFeedback, stopPuzzleFeedbackAudio, unlockPuzzleFeedbackAudio, type PuzzleFeedbackKind } from '../utils/puzzleFeedback';
import './PuzzleGameMode.css';
import { useLanguage } from '../contexts/LanguageContext';
import { getPuzzleDefinition, puzzleText, type PuzzleText } from '../utils/puzzleLocale';
import type { InputSession, PuzzleGamePhase, PuzzleGameSummary, WordEntry } from '../types';
import { getPuzzleCandidateWords, getPuzzleImageUrl, recordCompletedPuzzleSelection, selectPuzzleWords } from '../services/puzzleGame';
import { applyPuzzleAnswer, calculatePuzzlePracticeSummary, getPuzzleBoardScore, getPuzzleCardResult, getPuzzleMismatchPositions, normalizePuzzleAnswer, PUZZLE_DURATION_SECONDS, PUZZLE_LINES, type PuzzlePracticeCard } from '../utils/puzzleRules';

interface PuzzleGameModeProps {
  allWords: WordEntry[];
  sessions: InputSession[];
  onComplete: (summary: PuzzleGameSummary) => Promise<void> | void;
  onCancel: () => void;
}
const createCard = (word: WordEntry): PuzzlePracticeCard => ({
  word, imageUrl: getPuzzleImageUrl(word), attemptsUsed: 0, hintUsed: false, inputValue: '',
  isInputOpen: false, isSolved: false, isLocked: false, activatedAtMs: null, solvedAtMs: null, lastWrongInput: null, skipped: false,
});
const playable = (card: PuzzlePracticeCard) => !card.isSolved && !card.isLocked && !card.skipped;
const formatClock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
const loadImage = (url: string | null) => new Promise<boolean>((resolve) => {
  if (!url) { resolve(false); return; }
  const image = new Image();
  const finish = (ready: boolean) => { window.clearTimeout(timer); image.onload = null; image.onerror = null; resolve(ready); };
  const timer = window.setTimeout(() => finish(false), 5000);
  image.onload = () => finish(true); image.onerror = () => finish(false); image.src = url;
});

const PuzzleGameMode: React.FC<PuzzleGameModeProps> = ({ allWords, sessions, onComplete, onCancel }) => {
  const { language, isZh } = useLanguage();
  const t = (en: string, zh: string) => isZh ? zh : en;
  const [phase, setPhase] = useState<PuzzleGamePhase>('INTRO');
  const [cards, setCards] = useState<PuzzlePracticeCard[]>([]);
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [activation, setActivation] = useState(0);
  const [timeLeft, setTimeLeft] = useState(PUZZLE_DURATION_SECONDS);
  const [countdown, setCountdown] = useState(3);
  const [paused, setPaused] = useState(false);
  const [feedback, setFeedback] = useState<PuzzleText | null>(null);
  const [preparationError, setPreparationError] = useState<PuzzleText | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 9 });
  const [result, setResult] = useState<PuzzleGameSummary | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(() => {
    try { return localStorage.getItem('vibe_puzzle_sound') !== 'false'; } catch { return true; }
  });
  const [impact, setImpact] = useState<{ sequence: number; cardId: string; kind: PuzzleFeedbackKind; points: number; newLines: number[] } | null>(null);
  const impactTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const impactSequenceRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef(cards);
  const phaseRef = useRef(phase);
  const activeRef = useRef<string | null>(null);
  const pausedRef = useRef(false);
  const composingRef = useRef(false);
  const startedAtRef = useRef(0);
  const pausedAtRef = useRef(0);
  const pausedMsRef = useRef(0);
  const durationRef = useRef(PUZZLE_DURATION_SECONDS);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const finalizedRef = useRef(false);
  const completedRef = useRef(onComplete);
  const submittingRoundRef = useRef(new Set<string>());
  const selectionRef = useRef({ mode: 'smart' as 'smart' | 'random', overlap: 0 });
  const roundIdRef = useRef('');
  const finishRef = useRef<() => void>(() => {});
  completedRef.current = onComplete;

  const candidates = useMemo(() => getPuzzleCandidateWords(allWords), [allWords]);
  const candidateCount = candidates.length;
  const previewCards = useMemo(() => candidates.slice(0, 9).map(createCard), [candidates]);
  const activeCard = cards.find((card) => card.word.id === activeCardId);
  const boardScore = getPuzzleBoardScore(cards.map(getPuzzleCardResult));
  const mismatches = activeCard?.lastWrongInput && activeCard.lastWrongInput === activeCard.inputValue
    ? getPuzzleMismatchPositions(activeCard.lastWrongInput, activeCard.word.text) : [];
  const changePhase = (next: PuzzleGamePhase) => { phaseRef.current = next; setPhase(next); };
  const commitCards = (next: PuzzlePracticeCard[]) => { cardsRef.current = next; setCards(next); };
  const elapsed = () => startedAtRef.current ? Math.max(0, (pausedRef.current ? pausedAtRef.current : Date.now()) - startedAtRef.current - pausedMsRef.current) : 0;
  const focusInput = () => {
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  };

  // Every selection path updates the same activation signal; audio and focus cannot diverge.
  const activateCard = useCallback((wordId: string) => {
    const card = cardsRef.current.find((item) => item.word.id === wordId);
    if (phaseRef.current !== 'PLAYING' || pausedRef.current || !card || !playable(card)) return;
    activeRef.current = wordId; setActiveCardId(wordId);
    commitCards(cardsRef.current.map((item) => item.word.id === wordId
      ? { ...item, isInputOpen: true, activatedAtMs: item.activatedAtMs ?? elapsed() } : item));
    setActivation((value) => value + 1); focusInput();
  }, []);

  const persistResult = async (summary: PuzzleGameSummary) => {
    const id = summary.roundId!;
    if (submittingRoundRef.current.has(id)) return;
    submittingRoundRef.current.add(id); setSaveStatus('saving');
    try {
      await completedRef.current(summary);
      if (mountedRef.current && roundIdRef.current === id) setSaveStatus('saved');
    } catch (error) {
      submittingRoundRef.current.delete(id);
      if (mountedRef.current && roundIdRef.current === id) setSaveStatus('failed');
      console.warn('[PuzzleGameMode] result save failed', error);
    }
  };
  const finishGame = () => {
    if (finalizedRef.current || phaseRef.current !== 'PLAYING') return;
    finalizedRef.current = true;
    const summary = calculatePuzzlePracticeSummary(cardsRef.current.map(getPuzzleCardResult), Math.min(durationRef.current * 1000, elapsed()), selectionRef.current.mode, selectionRef.current.overlap);
    summary.roundId = roundIdRef.current; summary.occurredAt = Date.now();
    summary.secondsRemaining = Math.max(0, durationRef.current - summary.timeUsedSeconds);
    changePhase('RESULT'); setResult(summary); void stopCurrentAudio();
    recordCompletedPuzzleSelection(cardsRef.current.map((card) => card.word));
    void persistResult(summary);
  };
  finishRef.current = finishGame;
  const canAct = () => {
    if (phaseRef.current !== 'PLAYING' || pausedRef.current || finalizedRef.current) return false;
    if (elapsed() >= durationRef.current * 1000) { finishRef.current(); return false; }
    return true;
  };
  const activateNext = (currentId: string) => {
    const current = cardsRef.current.findIndex((card) => card.word.id === currentId);
    const next = [...cardsRef.current.slice(current + 1), ...cardsRef.current.slice(0, current + 1)].find(playable);
    if (next) activateCard(next.word.id); else finishRef.current();
  };

  const prepareGame = async (practiceWords?: WordEntry[], reuseSelection = false) => {
    if (!practiceWords && !reuseSelection && candidateCount < 9) return;
    const generation = ++generationRef.current;
    changePhase('PREPARING'); setPreparationError(null); setResult(null); setSaveStatus('idle');
    if (impactTimerRef.current) clearTimeout(impactTimerRef.current);
    setImpact(null); stopPuzzleFeedbackAudio();
    let words: WordEntry[];
    if (reuseSelection) words = cardsRef.current.map((card) => card.word);
    else if (practiceWords) { words = practiceWords.slice(0, 3); selectionRef.current = { mode: 'smart', overlap: 0 }; }
    else {
      let smart = true;
      try { smart = localStorage.getItem('vibe_ai_selection') !== 'false'; } catch { /* Memory priority is the default. */ }
      const selection = selectPuzzleWords(allWords, sessions, smart, 9);
      words = selection.words; selectionRef.current = { mode: selection.selectionMode, overlap: selection.overlapRate };
    }
    if (!words.length) { setPreparationError(puzzleText('No words are ready. Add illustrated words to your library.', '没有可用单词，请返回词库补充图片。')); changePhase('INTRO'); return; }
    commitCards(words.map(createCard));
    durationRef.current = words.length < 9 ? 30 : PUZZLE_DURATION_SECONDS;
    setTimeLeft(durationRef.current); setProgress({ current: 0, total: words.length });
    let cursor = 0, completed = 0, failures = 0;
    const worker = async () => {
      while (cursor < words.length && generation === generationRef.current) {
        const word = words[cursor++];
        const [audio, image] = await Promise.allSettled([
          preloadWordAudio(word.text, word.language || 'en', 4000, word.audio_url), loadImage(getPuzzleImageUrl(word)),
        ]);
        if (audio.status !== 'fulfilled' || !audio.value || image.status !== 'fulfilled' || !image.value) failures++;
        completed++;
        if (mountedRef.current && generation === generationRef.current) setProgress({ current: completed, total: words.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, words.length) }, worker));
    if (!mountedRef.current || generation !== generationRef.current) return;
    if (failures) { setPreparationError(puzzleText(`Audio or images for ${failures} word${failures === 1 ? '' : 's'} are not ready. The timer has not started. Try loading again.`, `${failures} 个词的声音或图片尚未就绪。计时没有开始，请重试加载。`)); return; }
    roundIdRef.current = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `puzzle-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    finalizedRef.current = false; activeRef.current = null; setActiveCardId(null);
    pausedRef.current = false; setPaused(false); setFeedback(null); changePhase('READY');
  };
  const startCountdown = () => { unlockPuzzleFeedbackAudio(soundEnabled); setCountdown(3); changePhase('COUNTDOWN'); };
  useEffect(() => {
    if (phase !== 'COUNTDOWN') return;
    const timer = window.setTimeout(() => {
      if (countdown > 1) setCountdown(countdown - 1);
      else {
        startedAtRef.current = Date.now(); pausedMsRef.current = 0; changePhase('PLAYING');
        const first = cardsRef.current.find(playable); if (first) activateCard(first.word.id);
        if (document.hidden || !document.hasFocus()) {
          pausedAtRef.current = Date.now(); pausedRef.current = true; setPaused(true);
        }
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [phase, countdown, activateCard]);
  useEffect(() => {
    if (phase !== 'PLAYING' || paused) return;
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, durationRef.current - Math.floor(elapsed() / 1000));
      setTimeLeft(remaining); if (!remaining) finishRef.current();
    }, 200);
    return () => window.clearInterval(timer);
  }, [phase, paused]);
  useEffect(() => {
    if (phase !== 'PLAYING' || paused || !activeCardId) return;
    focusInput();
    const card = cardsRef.current.find((item) => item.word.id === activeCardId);
    let cancelled = false;
    if (card) void playWordPronunciation(card.word.text, card.word.language || 'en').then((playback) => {
      if (!cancelled && !playback.success) setFeedback(puzzleText('Audio could not play. Select Replay to try again.', '声音未能播放，请点击“重播”重试。'));
    }).catch(() => { if (!cancelled) setFeedback(puzzleText('Audio could not play. Select Replay to try again.', '声音未能播放，请点击“重播”重试。')); });
    return () => { cancelled = true; };
  }, [phase, paused, activeCardId, activation]);

  const pauseGame = useCallback(() => {
    if (phaseRef.current !== 'PLAYING' || pausedRef.current) return;
    pausedAtRef.current = Date.now(); pausedRef.current = true; setPaused(true); void stopCurrentAudio(); stopPuzzleFeedbackAudio();
  }, []);
  const resumeGame = () => {
    pausedMsRef.current += Date.now() - pausedAtRef.current;
    pausedRef.current = false; setPaused(false); focusInput();
  };
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) pauseGame(); };
    const onShortcut = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || composingRef.current) return;
      const target = event.target as HTMLElement | null;
      const typing = target?.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      // Option + number produces symbols on macOS; physical digit codes stay stable.
      const digit = event.altKey && /^Digit[1-9]$/.test(event.code) ? event.code.slice(-1) : event.key;
      if (/^[1-9]$/.test(digit) && (!typing || event.altKey)) {
        const card = cardsRef.current[Number(digit) - 1];
        if (card && phaseRef.current === 'PLAYING') { event.preventDefault(); activateCard(card.word.id); }
      }
    };
    document.addEventListener('visibilitychange', onVisibility); window.addEventListener('keydown', onShortcut); window.addEventListener('blur', pauseGame);
    return () => { document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('keydown', onShortcut); window.removeEventListener('blur', pauseGame); };
  }, [activateCard, pauseGame]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false; generationRef.current++;
      if (impactTimerRef.current) clearTimeout(impactTimerRef.current);
      void stopCurrentAudio(); stopPuzzleFeedbackAudio();
    };
  }, []);

  const showImpact = (cardId: string, kind: PuzzleFeedbackKind, points = 0, newLines: number[] = []) => {
    if (impactTimerRef.current) clearTimeout(impactTimerRef.current);
    setImpact({ sequence: ++impactSequenceRef.current, cardId, kind, points, newLines });
    impactTimerRef.current = setTimeout(() => setImpact(null), kind === 'complete' ? 1800 : 1100);
    playPuzzleFeedback(kind, soundEnabled);
  };
  const toggleSound = () => {
    const enabled = !soundEnabled;
    setSoundEnabled(enabled);
    try { localStorage.setItem('vibe_puzzle_sound', String(enabled)); } catch { /* Preference remains valid for this visit. */ }
    if (enabled) unlockPuzzleFeedbackAudio(); else stopPuzzleFeedbackAudio();
    if (phaseRef.current === 'PLAYING' && !pausedRef.current) focusInput();
  };

  const submitAnswer = () => {
    if (!canAct() || composingRef.current) return;
    const card = cardsRef.current.find((item) => item.word.id === activeRef.current);
    if (!card || !playable(card)) return;
    const input = inputRef.current?.value ?? card.inputValue;
    if (!normalizePuzzleAnswer(input)) { setFeedback(puzzleText('Type the word first. An empty answer uses no attempts.', '先输入听到的单词；空提交不会消耗机会。')); focusInput(); return; }
    const updated = applyPuzzleAnswer(card, input, elapsed());
    const before = getPuzzleBoardScore(cardsRef.current.map(getPuzzleCardResult));
    commitCards(cardsRef.current.map((item) => item.word.id === card.word.id ? updated : item));
    if (updated.isSolved) {
      const after = getPuzzleBoardScore(cardsRef.current.map(getPuzzleCardResult));
      const newLines = after.completedLineIds.filter((id) => !before.completedLineIds.includes(id));
      const lines = newLines.length;
      const complete = cardsRef.current.length === 9 && cardsRef.current.every((item) => item.isSolved);
      showImpact(card.word.id, complete ? 'complete' : lines ? 'line' : 'correct', after.totalScore - before.totalScore, newLines);
      setFeedback(lines
        ? puzzleText(`${lines} line${lines === 1 ? '' : 's'} completed! +${after.totalScore - before.totalScore} points`, `连成 ${lines} 条线！+${after.totalScore - before.totalScore} 分`)
        : puzzleText(`Correct! +${card.hintUsed || updated.attemptsUsed > 1 ? 70 : 100} points. Next tile is ready.`, `答对！+${card.hintUsed || updated.attemptsUsed > 1 ? 70 : 100} 分，下一格已就绪。`));
      activateNext(card.word.id);
    } else {
      showImpact(card.word.id, 'wrong');
      if (updated.isLocked) { setFeedback(puzzleText('All three attempts used. This word is saved for practice. On to the next tile.', '本格三次机会用完，已加入待巩固。继续下一格。')); activateNext(card.word.id); }
      else { setFeedback(puzzleText(`Almost. Check the marked positions. ${3 - updated.attemptsUsed} attempt${updated.attemptsUsed === 2 ? '' : 's'} left.`, `还差一点，检查下方标出的字母位置。还可尝试 ${3 - updated.attemptsUsed} 次。`)); focusInput(); }
    }
  };
  const hint = () => {
    if (!canAct()) return;
    const card = cardsRef.current.find((item) => item.word.id === activeRef.current);
    if (!card || !playable(card)) return;
    commitCards(cardsRef.current.map((item) => item.word.id === card.word.id ? { ...item, hintUsed: true } : item));
    setFeedback(puzzleText('Image revealed. A correct answer earns 70 points and can still complete a line.', '图片已揭晓；本格答对得 70 分，仍可连线。')); focusInput();
  };
  const skip = () => {
    if (!canAct()) return;
    const card = cardsRef.current.find((item) => item.word.id === activeRef.current);
    if (!card || !playable(card)) return;
    commitCards(cardsRef.current.map((item) => item.word.id === card.word.id ? { ...item, skipped: true } : item));
    setFeedback(puzzleText('Skipped for now. Unanswered words are not marked wrong.', '已跳过，结束后可补练；没有作答的词不会记为错误。')); activateNext(card.word.id);
  };
  const exit = () => { if (phaseRef.current === 'PLAYING') { pauseGame(); setShowExitConfirm(true); } else onCancel(); };
  const retryWords = result ? result.results.filter((item) => item.status !== 'unattempted' && (!item.correct || item.hintUsed || item.attemptsUsed > 1))
    .slice(0, 3).flatMap((item) => cards.find((card) => card.word.id === item.wordId)?.word || []) : [];

  const displayCards = phase === 'INTRO' ? previewCards : cards;
  const shortPractice = cards.length > 0 && cards.length < 9;
  const availableLineCount = shortPractice ? 1 : 8;
  const activeIndex = cards.findIndex((card) => card.word.id === activeCardId);
  const nearLines = cards.length === 9 ? PUZZLE_LINES.flatMap((line, id) => {
    const missing = line.filter((index) => !cards[index].isSolved);
    return missing.length === 1 && playable(cards[missing[0]]) ? [{ id, target: missing[0] }] : [];
  }) : [];
  const targets: number[] = [...new Set(nearLines.map((line) => line.target))];
  const icon = (name: string) => <span aria-hidden="true" className="puzzle-icon">{name}</span>;
  const phaseTitle = phase === 'INTRO' ? t('Listen. Spell. Connect.', '听见，拼出，连成线。')
    : phase === 'PREPARING' ? t('Getting ready', '准备这一盘')
    : phase === 'READY' || phase === 'COUNTDOWN' ? t('Ready to play', '准备出发')
    : phase === 'RESULT' ? t('Your memory map', '这一盘，点亮了多少？')
    : paused ? t('Take a breath', '休息一下') : t('Light up the next tile', '听音，点亮下一格');
  const mismatchPositions = mismatches.slice(0, 8).map((position) => position + 1).join(isZh ? '、' : ', ');
  const mismatchHint = mismatches.length
    ? t(`Check positions ${mismatchPositions}${mismatches.length > 8 ? ` (${mismatches.length} total)` : ''}, including missing or extra letters.`, `检查第 ${mismatchPositions} 位${mismatches.length > 8 ? `等 ${mismatches.length} 处` : '字母'}（含缺字或多字）。`)
    : activeCard?.hintUsed
      ? `${getPuzzleDefinition(activeCard.word, language) || t('Use the revealed image', '观察已揭晓的图片')} · ${Array.from(activeCard.word.text).length} ${t('characters', '个字符')}`
      : t('First try +100 · With an image hint +70', '独立拼对 +100 分 · 看图后答对 +70 分');

  return <div ref={surfaceRef} data-puzzle-game data-language={language} data-phase={phase} data-paused={paused} className="puzzle-game">
    <div className="puzzle-shell">
      <header className="puzzle-topbar">
        <div className="puzzle-brand"><p className="puzzle-eyebrow">{t('VOCAB ARCADE / 01', '词汇街机 / 01')}</p><h2>{t('NINE LINES', '九格连线')} <span>{t('Listen & connect', '听音拼写')}</span></h2></div>
        <div className="puzzle-hud" aria-label={t('Round status', '本局状态')}>
          <div className="puzzle-stat" data-timer="true" data-urgent={phase === 'PLAYING' && timeLeft <= 10}><span>{t('TIME LEFT', '剩余时间')}</span><strong aria-label={t('Time left', '剩余时间')}>{formatClock(phase === 'RESULT' && result ? result.secondsRemaining || 0 : timeLeft)}</strong><div className="puzzle-timer-track"><i style={{ width: `${100 * timeLeft / durationRef.current}%` }} /></div></div>
          <div className="puzzle-stat"><span>{t('SCORE', '本局得分')}</span><strong>{boardScore.totalScore}<small>{t('pts', '分')}</small></strong></div>
          <div className="puzzle-stat"><span>{t('LINES', '点亮连线')}</span><strong>{boardScore.completedLineIds.length}<small>/ {availableLineCount}</small></strong></div>
        </div>
        <div className="puzzle-tools">
          {phase === 'PLAYING' && <button type="button" onClick={paused ? resumeGame : pauseGame}>{paused ? t('Resume', '继续') : t('Pause', '暂停')}</button>}
          <button type="button" onClick={toggleSound} aria-pressed={soundEnabled} aria-label={soundEnabled ? t('Game sound on', '游戏音效已开启') : t('Game sound off', '游戏音效已关闭')} title={t('Toggle game effects. Word pronunciation stays on.', '仅切换游戏音效，单词发音保持开启')}>{icon('volume_up')}{soundEnabled ? t('Sound on', '音效开') : t('Sound off', '音效关')}</button>
          <button type="button" onClick={exit}>{t('Exit', '退出')}</button>
        </div>
      </header>
      <div className="puzzle-layout">
        <section className="puzzle-arena" aria-label={t('Nine Lines game board', '九格连线游戏区')}>
          <div className="puzzle-board-head"><div className="puzzle-board-caption">{phase === 'RESULT' ? t('Your memory map', '本局记忆地图') : shortPractice ? t('Three words. One more try.', '短补练 · 三个词，再记一次') : t('Listen & spell · Three in a line', '听音拼写 · 三格成线')}</div><span>{phase === 'RESULT' ? t('Picture + word. Remember again.', '图像 + 单词，再记一次') : shortPractice ? t('Complete the row', '完成一行，再连一线') : t('Rows / Columns / Diagonals', '横线 / 竖线 / 对角线')}</span></div>
          <div className="puzzle-board" role="group" aria-label={phase === 'RESULT' ? t('Round word review', '本局单词复盘') : t('Nine-tile board', '九宫格棋盘')}>
            {Array.from({ length: 9 }, (_, index) => {
              const card = displayCards[index];
              if (!card) return <div key={`empty-${index}`} className="puzzle-card" aria-hidden="true"><span className="puzzle-card-number">{String(index + 1).padStart(2, '0')}</span></div>;
              const isActive = phase === 'PLAYING' && activeCardId === card.word.id && playable(card);
              const revealed = card.hintUsed || card.isSolved || phase === 'RESULT';
              const charged = targets.includes(index);
              const definition = getPuzzleDefinition(card.word, language);
              const stateLabel = card.isSolved
                ? card.hintUsed ? t('Solved with a hint', '提示完成') : card.attemptsUsed > 1 ? t('Solved after retrying', '纠正后完成') : t('Solved independently', '独立完成')
                : card.skipped ? t('Skipped', '已跳过') : card.isLocked ? t('Needs practice', '待巩固')
                : phase === 'RESULT' ? t('Not attempted', '未尝试') : charged ? t('One tile to a line · +80', '差这一格，连线 +80')
                : isActive ? t('Listening · Type on the right', '正在聆听 · 输入右侧') : t('Select · Listen & spell', '点击选格 · 听音拼写');
              const cardImpact = impact?.cardId === card.word.id ? impact : null;
              const tileLabel = t(`Tile ${index + 1}`, `第 ${index + 1} 格`);
              return <button type="button" key={card.word.id} className="puzzle-card" data-testid={`puzzle-card-${index + 1}`} data-active={isActive} data-solved={card.isSolved} data-revealed={revealed} data-locked={card.isLocked && !card.isSolved} data-skipped={card.skipped} data-charged={charged} data-feedback={cardImpact ? cardImpact.kind === 'wrong' ? 'wrong' : 'correct' : undefined} disabled={phase !== 'PLAYING' || paused || !playable(card)} onClick={() => activateCard(card.word.id)} aria-pressed={isActive} aria-label={`${tileLabel}, ${stateLabel}${phase === 'RESULT' ? `, ${card.word.text}${definition ? `, ${definition}` : ''}` : ''}`} title={phase === 'RESULT' ? [card.word.text, definition, stateLabel].filter(Boolean).join(' · ') : `${tileLabel} · ${t(`${3 - card.attemptsUsed} attempts left`, `剩余 ${3 - card.attemptsUsed} 次机会`)}`}>
                {card.imageUrl && <img className="puzzle-card-image" src={card.imageUrl} alt="" />}
                <span className="puzzle-card-number">{String(index + 1).padStart(2, '0')}</span>
                <div className="puzzle-card-center" aria-hidden="true">
                  {card.isSolved ? icon('check') : card.skipped ? icon('keyboard_double_arrow_right') : card.isLocked ? icon('close') : !revealed && <><div className="puzzle-wave">{Array.from({ length: 5 }, (_, i) => <span key={i} />)}</div><small>{isActive ? t('LISTENING', '正在聆听') : t('LISTEN & SPELL', '听音拼写')}</small></>}
                </div>
                {(card.isSolved || phase === 'RESULT') && <span className="puzzle-card-word">{card.word.text}</span>}
                <span className="puzzle-card-status">{phase === 'RESULT' && definition ? `${stateLabel} · ${definition}` : stateLabel}</span>
                <span className="puzzle-attempts" aria-hidden="true">{Array.from({ length: 3 }, (_, i) => <i key={i} data-used={i < card.attemptsUsed} />)}</span>
                {cardImpact && <span key={`flash-${cardImpact.sequence}`} className="puzzle-card-flash" data-kind={cardImpact.kind === 'wrong' ? 'wrong' : 'correct'} />}
                {cardImpact && cardImpact.points > 0 && <span key={`score-${cardImpact.sequence}`} className="puzzle-score-pop" aria-hidden="true">+{cardImpact.points}</span>}
              </button>;
            })}
          </div>
          <div className="puzzle-arena-bottom"><div className="puzzle-line-dots" aria-label={t(`${boardScore.completedLineIds.length} lines completed`, `已连成 ${boardScore.completedLineIds.length} 条线`)}>{PUZZLE_LINES.slice(0, availableLineCount).map((_, id) => <i key={id} data-complete={boardScore.completedLineIds.includes(id)} />)}</div><span>{cards.filter((card) => card.isSolved).length} / {cards.length || 9} {t('tiles lit', '格已点亮')}</span></div>
          {(phase === 'COUNTDOWN' || (phase === 'PLAYING' && paused)) && <div className="puzzle-notice" role="status">
            {phase === 'COUNTDOWN' ? <><p>{t('Headphones ready. Listen to the first tile.', '戴好耳机，听第一格')}</p><strong key={countdown}>{countdown}</strong><p>{t('Hands on the keyboard. Enter to submit.', '手放键盘，Enter 提交')}</p></> : <><h3>{t('Paused', '已暂停')}</h3><p>{t('The timer is stopped. Continue when ready.', '时间已停，准备好再继续。')}</p><button type="button" className="puzzle-button" onClick={resumeGame}>{icon('play_arrow')}{t('Resume round', '继续这一盘')}</button></>}
          </div>}
          {impact && (impact.kind === 'line' || impact.kind === 'complete') && <div className="puzzle-burst" key={impact.sequence} aria-hidden="true"><small>{impact.kind === 'complete' ? t('ALL CLEAR', '全盘点亮') : t('LINE UP', '连线完成')}</small><strong>+{impact.points}</strong><span>{impact.kind === 'complete' ? t('All nine tiles lit!', '九格全亮！') : t(`${impact.newLines.length} line${impact.newLines.length === 1 ? '' : 's'} completed`, `点亮 ${impact.newLines.length} 条连线`)}</span></div>}
        </section>
        <aside className="puzzle-console" aria-label={t('Answer controls', '作答控制台')}>
          <div className="puzzle-console-heading"><small>{phase === 'RESULT' ? t('ROUND COMPLETE', '本局完成') : t('LISTEN · SPELL · CONNECT', '听音 · 拼写 · 连线')}</small><h3>{phaseTitle}</h3></div>
          <div className="puzzle-console-body">
            {phase === 'INTRO' && <>
              <div className="puzzle-intro-copy"><h3>{t('Nine words.', '九个词。')}<br />{t('Eight lines. 90 seconds.', '八条线。90 秒。')}</h3><p>{t('Choose a tile, listen, and spell to reveal its picture. Build a row, column, or diagonal.', '选一格听发音，拼对就揭开记忆图。自由选择路线，点亮横、竖或对角线。')}</p></div>
              <ul className="puzzle-rules"><li><small>{t('First try, no hint', '首次独立答对')}</small><strong>+100</strong></li><li><small>{t('With a hint or retry', '提示 / 纠正后答对')}</small><strong>+70</strong></li><li><small>{t('Each completed line', '每连成一条线')}</small><strong>+80</strong></li><li><small>{t('All nine tiles lit', '九格全部点亮')}</small><strong>+200</strong></li></ul>
              <button type="button" className="puzzle-button" disabled={candidateCount < 9} onClick={() => void prepareGame()}>{icon('play_arrow')}{t('Prepare round', '准备这一盘')}</button>
              <div className="puzzle-tips">{t(`${candidateCount} illustrated words available`, `可用带图单词 ${candidateCount} 个`)}{candidateCount < 9 ? t(' · At least 9 needed.', '，至少需要 9 个。') : t(' · Weaker memories first', ' · 优先复习薄弱记忆')}</div>
              {preparationError && <p role="alert">{preparationError[language]}</p>}
            </>}
            {phase === 'PREPARING' && <><div className="puzzle-intro-copy"><h3>{t('Getting sounds', '声音与记忆图')}<br />{t('and pictures ready.', '正在就位。')}</h3><p>{t(`${progress.current} / ${progress.total} words checked. The timer has not started.`, `${progress.current} / ${progress.total} 个词已检查，计时尚未开始。`)}</p></div><progress value={progress.current} max={progress.total} aria-label={t('Resource loading progress', '资源加载进度')} />{preparationError && <><p role="alert">{preparationError[language]}</p><button type="button" className="puzzle-button" onClick={() => void prepareGame(undefined, true)}>{t('Retry loading', '重试加载')}</button></>}</>}
            {(phase === 'READY' || phase === 'COUNTDOWN') && <><div className="puzzle-intro-copy"><h3>{cards.length === 9 ? t('Nine tiles ready.', '九格已就绪。') : t(`${cards.length} words. A quick retry.`, `${cards.length} 个词，短补练。`)}</h3><p>{t('The first tile plays automatically. Correct answers move you on. Choose any tile to build a line.', '开始后自动播放第一格。答对就接着听下一格，也可以自由选格争取连线。')}</p></div><ul className="puzzle-rules"><li><small>{t('Round time', '本局限时')}</small><strong>{durationRef.current} {t('sec', '秒')}</strong></li><li><small>{t('Attempts per tile', '每格作答机会')}</small><strong>3 {t('tries', '次')}</strong></li><li><small>{t('Replay / Pause', '重播 / 暂停')}</small><strong>{t('Unlimited', '不限次数')}</strong></li></ul><button type="button" className="puzzle-button" onClick={startCountdown} disabled={phase === 'COUNTDOWN'}>{icon('play_arrow')}{phase === 'COUNTDOWN' ? t('Starting…', '即将开始…') : t('Start', '开始')}</button><p>{t('Your answers save automatically. Start when ready.', '已作答结果自动保存。准备好就出发。')}</p></>}
            {phase === 'PLAYING' && <>
              <div className="puzzle-active-number"><strong>{String(activeIndex + 1).padStart(2, '0')}</strong><div><span>{t('CURRENT TILE', '当前作答格')}</span><small>{activeCard ? t(`${3 - activeCard.attemptsUsed} attempt${activeCard.attemptsUsed === 2 ? '' : 's'} left`, `剩余 ${3 - activeCard.attemptsUsed} 次机会`) : t('Almost finished', '这一盘即将完成')}</small></div></div>
              <section className="puzzle-entry" aria-label={t('Word answer area', '单词作答区')}><label htmlFor="puzzle-word-input">{t('What did you hear? Spell it.', '听到什么？把它拼出来。')}</label>
                <div className="puzzle-input-row"><input ref={inputRef} id="puzzle-word-input" data-testid="puzzle-input" type="text" inputMode="text" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="done" value={activeCard?.inputValue || ''} disabled={paused || !activeCard || !playable(activeCard)} placeholder={t('Type the word', '输入听到的单词')} aria-describedby="puzzle-feedback puzzle-mismatches" onChange={(event) => {
                  const value = event.target.value; commitCards(cardsRef.current.map((card) => card.word.id === activeRef.current ? { ...card, inputValue: value } : card));
                }} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return;
                  event.preventDefault(); if (!event.repeat) submitAnswer();
                }} /><button type="button" disabled={paused || !activeCard} onClick={submitAnswer}>{t('Submit', '提交')}</button></div>
                <p id="puzzle-mismatches" className="puzzle-mismatches" title={mismatches.length > 8 ? t(`Positions to check: ${mismatches.map((position) => position + 1).join(', ')}`, `需要检查的位置：${mismatches.map((position) => position + 1).join('、')}`) : undefined}>{mismatchHint}</p>
                <p id="puzzle-feedback" className="puzzle-feedback" data-kind={impact ? impact.kind === 'wrong' ? 'wrong' : 'correct' : undefined} role="status" aria-live="polite">{feedback?.[language] || t('Listen, then spell. Replay anytime without losing points.', '先听发音，再试着拼写。可以随时重播，不扣分。')}</p>
                <div className="puzzle-actions"><button type="button" disabled={paused} onClick={() => activeCard && activateCard(activeCard.word.id)}>{icon('volume_up')}{t('Replay', '重播')}</button><button type="button" disabled={paused || activeCard?.hintUsed} onClick={hint}>{icon('lightbulb')}{t('Image hint', '图片提示')}</button><button type="button" disabled={paused} onClick={skip}>{icon('keyboard_double_arrow_right')}{t('Skip', '跳过')}</button></div>
              </section>
              <div className="puzzle-tips"><p><kbd>Enter</kbd> {t('to submit · Correct? Next tile.', '提交，答对自动进入下一格')}</p><p><kbd>Alt</kbd> + <kbd>1–9</kbd> {t('to choose any tile', '自由选格')}</p></div>
              {cards.length === 9 && <div className="puzzle-next-line"><strong>{targets.length ? t(`Tile ${targets.map((i) => i + 1).join(' / ')}. One step closer!`, `第 ${targets.map((i) => i + 1).join(' / ')} 格，再进一步！`) : t('Choose your route. Build a line.', '先选路线，再连成线')}</strong>{targets.length ? t('Solve a purple-bordered tile to earn a line bonus.', '紫色描边的格子，答对即可获得连线奖励。') : t('Try the center first. It connects four possible lines.', '横、竖、对角线皆可。试着先攻下中心格，它连接着四条路线。')}</div>}
            </>}
            {phase === 'RESULT' && result && <>
              <div className="puzzle-result-summary"><h3>{result.wordsCorrect === 9 ? t('All nine lit. A brilliant round!', '九格全亮，漂亮的一盘！') : t('Every tile builds a stronger memory.', '每点亮一格，记忆就更深一点。')}</h3><div className="puzzle-result-score"><strong>{result.totalScore}</strong><small>{t('points', '分')}</small></div></div>
              <div className="puzzle-result-metrics"><div><span>{t('Tiles lit', '点亮格数')}</span><strong>{result.wordsCorrect}/{result.wordsTotal}</strong></div><div><span>{t('Lines', '完成连线')}</span><strong>{result.completedLines}</strong></div><div><span>{t('Time / sec', '用时 / 秒')}</span><strong>{result.timeUsedSeconds}</strong></div></div>
              <ul className="puzzle-result-breakdown"><li><label>{t('Word points', '单词得分')}</label><strong>+{result.totalScore - (result.lineBonus || 0) - (result.completionBonus || 0)}</strong></li><li><label>{t('Line bonus', '连线奖励')}</label><strong>+{result.lineBonus || 0}</strong></li><li><label>{t('All-clear bonus', '全盘奖励')}</label><strong>+{result.completionBonus || 0}</strong></li></ul>
              <p role="status">{saveStatus === 'saving' ? t('Saving your progress…', '正在保存学习记录…') : saveStatus === 'saved' ? t('Progress saved. Review the pictures on the left.', '学习记录已保存。看看左侧的记忆图，再记一次。') : saveStatus === 'failed' ? t('Could not save yet. Retry below; your round is kept here.', '暂未保存成功，可重试；本局仍保留在这里。') : ''}</p>
              <div className="puzzle-result-actions">{saveStatus === 'failed' && <button type="button" className="puzzle-button" onClick={() => void persistResult(result)}>{t('Retry saving', '重试保存')}</button>}{retryWords.length > 0 && <button type="button" className="puzzle-button" onClick={() => void prepareGame(retryWords)} disabled={saveStatus === 'saving' || saveStatus === 'failed'}>{t(`Retry ${retryWords.length} word${retryWords.length === 1 ? '' : 's'}`, `再练这 ${retryWords.length} 个词`)}</button>}<button type="button" className={`puzzle-button ${retryWords.length ? 'puzzle-button-secondary' : ''}`} onClick={() => void prepareGame()} disabled={candidateCount < 9 || saveStatus === 'saving' || saveStatus === 'failed'}>{t('New round', '新的一盘')}</button></div>
            </>}
          </div>
          <div className="puzzle-console-footer"><strong>{t('Practice round · Progress saved automatically', '练习局 · 进展自动保存')}</strong><br />{phase === 'PLAYING' ? t('Free replays · Hints still allow line bonuses', '重播不扣分 · 提示后仍可连线') : t('Build your memory. Practice scores stay off the leaderboard.', '巩固记忆，本局成绩不计入旧排行榜')}</div>
        </aside>
      </div>
    </div>
    {showExitConfirm && <div className="puzzle-dialog"><section role="dialog" aria-modal="true" aria-labelledby="puzzle-exit-title"><h3 id="puzzle-exit-title">{t('Finish this round?', '结束这一盘？')}</h3><p>{t('Your answers will be saved. Unattempted tiles are not marked wrong.', '已作答的单词会保存，未尝试的格子不会记为错误。')}</p><div><button type="button" className="puzzle-button puzzle-button-secondary" onClick={() => { setShowExitConfirm(false); resumeGame(); }}>{t('Keep playing', '继续练习')}</button><button type="button" className="puzzle-button" onClick={() => { setShowExitConfirm(false); finishGame(); }}>{t('Finish & review', '结束并查看')}</button></div></section></div>}
  </div>;
};
export default PuzzleGameMode;
