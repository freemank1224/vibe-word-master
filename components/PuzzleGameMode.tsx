import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { preloadWordAudio, playWordPronunciation, stopCurrentAudio } from '../services/pronunciationService';
import { playPuzzleFeedback, stopPuzzleFeedbackAudio, unlockPuzzleFeedbackAudio, type PuzzleFeedbackKind } from '../utils/puzzleFeedback';
import './PuzzleGameMode.css';
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
  const [phase, setPhase] = useState<PuzzleGamePhase>('INTRO');
  const [cards, setCards] = useState<PuzzlePracticeCard[]>([]);
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [activation, setActivation] = useState(0);
  const [timeLeft, setTimeLeft] = useState(PUZZLE_DURATION_SECONDS);
  const [countdown, setCountdown] = useState(3);
  const [paused, setPaused] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [preparationError, setPreparationError] = useState<string | null>(null);
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
    if (!words.length) { setPreparationError('没有可用单词，请返回词库补充图片。'); changePhase('INTRO'); return; }
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
    if (failures) { setPreparationError(`${failures} 个词的声音或图片尚未就绪。计时没有开始，请重试加载。`); return; }
    roundIdRef.current = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `puzzle-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    finalizedRef.current = false; activeRef.current = null; setActiveCardId(null);
    pausedRef.current = false; setPaused(false); setFeedback(''); changePhase('READY');
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
      if (!cancelled && !playback.success) setFeedback('声音未能播放，请点击“重播”重试。');
    }).catch(() => { if (!cancelled) setFeedback('声音未能播放，请点击“重播”重试。'); });
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
    if (!normalizePuzzleAnswer(input)) { setFeedback('先输入听到的单词；空提交不会消耗机会。'); focusInput(); return; }
    const updated = applyPuzzleAnswer(card, input, elapsed());
    const before = getPuzzleBoardScore(cardsRef.current.map(getPuzzleCardResult));
    commitCards(cardsRef.current.map((item) => item.word.id === card.word.id ? updated : item));
    if (updated.isSolved) {
      const after = getPuzzleBoardScore(cardsRef.current.map(getPuzzleCardResult));
      const newLines = after.completedLineIds.filter((id) => !before.completedLineIds.includes(id));
      const lines = newLines.length;
      const complete = cardsRef.current.length === 9 && cardsRef.current.every((item) => item.isSolved);
      showImpact(card.word.id, complete ? 'complete' : lines ? 'line' : 'correct', after.totalScore - before.totalScore, newLines);
      setFeedback(lines ? `连成 ${lines} 条线！+${after.totalScore - before.totalScore} 分` : `答对！+${card.hintUsed || updated.attemptsUsed > 1 ? 70 : 100} 分，下一格已就绪。`);
      activateNext(card.word.id);
    } else {
      showImpact(card.word.id, 'wrong');
      if (updated.isLocked) { setFeedback('本格三次机会用完，已加入待巩固。继续下一格。'); activateNext(card.word.id); }
      else { setFeedback(`还差一点，检查下方标出的字母位置。还可尝试 ${3 - updated.attemptsUsed} 次。`); focusInput(); }
    }
  };
  const hint = () => {
    if (!canAct()) return;
    const card = cardsRef.current.find((item) => item.word.id === activeRef.current);
    if (!card || !playable(card)) return;
    commitCards(cardsRef.current.map((item) => item.word.id === card.word.id ? { ...item, hintUsed: true } : item));
    setFeedback('图片已揭晓；本格答对得 70 分，仍可连线。'); focusInput();
  };
  const skip = () => {
    if (!canAct()) return;
    const card = cardsRef.current.find((item) => item.word.id === activeRef.current);
    if (!card || !playable(card)) return;
    commitCards(cardsRef.current.map((item) => item.word.id === card.word.id ? { ...item, skipped: true } : item));
    setFeedback('已跳过，结束后可补练；没有作答的词不会记为错误。'); activateNext(card.word.id);
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
  const phaseTitle = phase === 'INTRO' ? '听见，拼出，连成线。' : phase === 'PREPARING' ? '准备这一盘' : phase === 'READY' || phase === 'COUNTDOWN' ? '准备出发' : phase === 'RESULT' ? '这一盘，点亮了多少？' : paused ? '休息一下' : '听音，点亮下一格';

  return <div ref={surfaceRef} data-puzzle-game data-phase={phase} data-paused={paused} className="puzzle-game">
    <div className="puzzle-shell">
      <header className="puzzle-topbar">
        <div className="puzzle-brand"><p className="puzzle-eyebrow">VOCAB ARCADE / 01</p><h2>NINE LINES <span>九格连线</span></h2></div>
        <div className="puzzle-hud" aria-label="本局状态">
          <div className="puzzle-stat" data-timer="true" data-urgent={phase === 'PLAYING' && timeLeft <= 10}><span>剩余时间</span><strong aria-label="剩余时间">{formatClock(phase === 'RESULT' && result ? result.secondsRemaining || 0 : timeLeft)}</strong><div className="puzzle-timer-track"><i style={{ width: `${100 * timeLeft / durationRef.current}%` }} /></div></div>
          <div className="puzzle-stat"><span>本局得分</span><strong>{boardScore.totalScore}<small>分</small></strong></div>
          <div className="puzzle-stat"><span>点亮连线</span><strong>{boardScore.completedLineIds.length}<small>/ {availableLineCount}</small></strong></div>
        </div>
        <div className="puzzle-tools">
          {phase === 'PLAYING' && <button type="button" onClick={paused ? resumeGame : pauseGame}>{paused ? '继续' : '暂停'}</button>}
          <button type="button" onClick={toggleSound} aria-pressed={soundEnabled} aria-label={`游戏音效${soundEnabled ? '已开启' : '已关闭'}`} title="仅切换游戏音效，单词发音保持开启">{icon('volume_up')}音效{soundEnabled ? '开' : '关'}</button>
          <button type="button" onClick={exit}>退出</button>
        </div>
      </header>
      <div className="puzzle-layout">
        <section className="puzzle-arena" aria-label="九格连线游戏区">
          <div className="puzzle-board-head"><div className="puzzle-board-caption">{phase === 'RESULT' ? '本局记忆地图' : shortPractice ? '短补练 · 三个词，再记一次' : '听音拼写 · 三格成线'}</div><span>{phase === 'RESULT' ? '图像 + 单词，再记一次' : shortPractice ? '完成一行，再连一线' : '横线 / 竖线 / 对角线'}</span></div>
          <div className="puzzle-board" role="group" aria-label={phase === 'RESULT' ? '本局单词复盘' : '九宫格棋盘'}>
            {Array.from({ length: 9 }, (_, index) => {
              const card = displayCards[index];
              if (!card) return <div key={`empty-${index}`} className="puzzle-card" aria-hidden="true"><span className="puzzle-card-number">{String(index + 1).padStart(2, '0')}</span></div>;
              const isActive = phase === 'PLAYING' && activeCardId === card.word.id && playable(card);
              const revealed = card.hintUsed || card.isSolved || phase === 'RESULT';
              const charged = targets.includes(index);
              const stateLabel = card.isSolved ? card.hintUsed ? '提示完成' : card.attemptsUsed > 1 ? '纠正后完成' : '独立完成' : card.skipped ? '已跳过' : card.isLocked ? '待巩固' : phase === 'RESULT' ? '未尝试' : charged ? '差这一格，连线 +80' : isActive ? '正在聆听 · 输入右侧' : '点击选格 · 听音拼写';
              const cardImpact = impact?.cardId === card.word.id ? impact : null;
              return <button type="button" key={card.word.id} className="puzzle-card" data-testid={`puzzle-card-${index + 1}`} data-active={isActive} data-solved={card.isSolved} data-revealed={revealed} data-locked={card.isLocked && !card.isSolved} data-skipped={card.skipped} data-charged={charged} data-feedback={cardImpact ? cardImpact.kind === 'wrong' ? 'wrong' : 'correct' : undefined} disabled={phase !== 'PLAYING' || paused || !playable(card)} onClick={() => activateCard(card.word.id)} aria-pressed={isActive} aria-label={`第 ${index + 1} 格，${stateLabel}${phase === 'RESULT' ? `，${card.word.text}，${card.word.definition_cn || ''}` : ''}`} title={phase === 'RESULT' ? `${card.word.text} · ${card.word.definition_cn || ''} · ${stateLabel}` : `第 ${index + 1} 格，剩余 ${3 - card.attemptsUsed} 次机会`}>
                {card.imageUrl && <img className="puzzle-card-image" src={card.imageUrl} alt="" />}
                <span className="puzzle-card-number">{String(index + 1).padStart(2, '0')}</span>
                <div className="puzzle-card-center" aria-hidden="true">
                  {card.isSolved ? icon('check') : card.skipped ? icon('keyboard_double_arrow_right') : card.isLocked ? icon('close') : !revealed && <><div className="puzzle-wave">{Array.from({ length: 5 }, (_, i) => <span key={i} />)}</div><small>{isActive ? 'LISTENING' : 'LISTEN & SPELL'}</small></>}
                </div>
                {(card.isSolved || phase === 'RESULT') && <span className="puzzle-card-word">{card.word.text}</span>}
                <span className="puzzle-card-status">{phase === 'RESULT' ? `${stateLabel} · ${card.word.definition_cn || ''}` : stateLabel}</span>
                <span className="puzzle-attempts" aria-hidden="true">{Array.from({ length: 3 }, (_, i) => <i key={i} data-used={i < card.attemptsUsed} />)}</span>
                {cardImpact && <span key={`flash-${cardImpact.sequence}`} className="puzzle-card-flash" data-kind={cardImpact.kind === 'wrong' ? 'wrong' : 'correct'} />}
                {cardImpact && cardImpact.points > 0 && <span key={`score-${cardImpact.sequence}`} className="puzzle-score-pop" aria-hidden="true">+{cardImpact.points}</span>}
              </button>;
            })}
          </div>
          <div className="puzzle-arena-bottom"><div className="puzzle-line-dots" aria-label={`已连成 ${boardScore.completedLineIds.length} 条线`}>{PUZZLE_LINES.slice(0, availableLineCount).map((_, id) => <i key={id} data-complete={boardScore.completedLineIds.includes(id)} />)}</div><span>{cards.filter((card) => card.isSolved).length} / {cards.length || 9} 格已点亮</span></div>
          {(phase === 'COUNTDOWN' || (phase === 'PLAYING' && paused)) && <div className="puzzle-notice" role="status">
            {phase === 'COUNTDOWN' ? <><p>戴好耳机，听第一格</p><strong key={countdown}>{countdown}</strong><p>手放键盘，Enter 提交</p></> : <><h3>已暂停</h3><p>时间已停，准备好再继续。</p><button type="button" className="puzzle-button" onClick={resumeGame}>{icon('play_arrow')}继续这一盘</button></>}
          </div>}
          {impact && (impact.kind === 'line' || impact.kind === 'complete') && <div className="puzzle-burst" key={impact.sequence} aria-hidden="true"><small>{impact.kind === 'complete' ? 'ALL CLEAR' : 'LINE UP'}</small><strong>+{impact.points}</strong><span>{impact.kind === 'complete' ? '九格全亮！' : `点亮 ${impact.newLines.length} 条连线`}</span></div>}
        </section>
        <aside className="puzzle-console" aria-label="作答控制台">
          <div className="puzzle-console-heading"><small>{phase === 'RESULT' ? 'ROUND COMPLETE' : 'LISTEN · SPELL · CONNECT'}</small><h3>{phaseTitle}</h3></div>
          <div className="puzzle-console-body">
            {phase === 'INTRO' && <>
              <div className="puzzle-intro-copy"><h3>九个词。<br />八条线。90 秒。</h3><p>选一格听发音，拼对就揭开记忆图。自由选择路线，点亮横、竖或对角线。</p></div>
              <ul className="puzzle-rules"><li><small>首次独立答对</small><strong>+100</strong></li><li><small>提示 / 纠正后答对</small><strong>+70</strong></li><li><small>每连成一条线</small><strong>+80</strong></li><li><small>九格全部点亮</small><strong>+200</strong></li></ul>
              <button type="button" className="puzzle-button" disabled={candidateCount < 9} onClick={() => void prepareGame()}>{icon('play_arrow')}准备这一盘</button>
              <div className="puzzle-tips">可用带图单词 {candidateCount} 个{candidateCount < 9 ? '，至少需要 9 个。' : ' · 优先复习薄弱记忆'}</div>
              {preparationError && <p role="alert">{preparationError}</p>}
            </>}
            {phase === 'PREPARING' && <><div className="puzzle-intro-copy"><h3>声音与记忆图<br />正在就位。</h3><p>{progress.current} / {progress.total} 个词已检查，计时尚未开始。</p></div><progress value={progress.current} max={progress.total} aria-label="资源加载进度" />{preparationError && <><p role="alert">{preparationError}</p><button type="button" className="puzzle-button" onClick={() => void prepareGame(undefined, true)}>重试加载</button></>}</>}
            {(phase === 'READY' || phase === 'COUNTDOWN') && <><div className="puzzle-intro-copy"><h3>{cards.length === 9 ? '九格已就绪。' : `${cards.length} 个词，短补练。`}</h3><p>开始后自动播放第一格。答对就接着听下一格，也可以自由选格争取连线。</p></div><ul className="puzzle-rules"><li><small>本局限时</small><strong>{durationRef.current} 秒</strong></li><li><small>每格作答机会</small><strong>3 次</strong></li><li><small>重播 / 暂停</small><strong>不限次数</strong></li></ul><button type="button" className="puzzle-button" onClick={startCountdown} disabled={phase === 'COUNTDOWN'}>{icon('play_arrow')}{phase === 'COUNTDOWN' ? '即将开始…' : '开始'}</button><p>已作答结果自动保存。准备好就出发。</p></>}
            {phase === 'PLAYING' && <>
              <div className="puzzle-active-number"><strong>{String(activeIndex + 1).padStart(2, '0')}</strong><div><span>当前作答格</span><small>{activeCard ? `剩余 ${3 - activeCard.attemptsUsed} 次机会` : '这一盘即将完成'}</small></div></div>
              <section className="puzzle-entry" aria-label="单词作答区"><label htmlFor="puzzle-word-input">听到什么？把它拼出来。</label>
                <div className="puzzle-input-row"><input ref={inputRef} id="puzzle-word-input" data-testid="puzzle-input" type="text" inputMode="text" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="done" value={activeCard?.inputValue || ''} disabled={paused || !activeCard || !playable(activeCard)} placeholder="输入听到的单词" aria-describedby="puzzle-feedback puzzle-mismatches" onChange={(event) => {
                  const value = event.target.value; commitCards(cardsRef.current.map((card) => card.word.id === activeRef.current ? { ...card, inputValue: value } : card));
                }} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return;
                  event.preventDefault(); if (!event.repeat) submitAnswer();
                }} /><button type="button" disabled={paused || !activeCard} onClick={submitAnswer}>提交</button></div>
                <p id="puzzle-mismatches" className="puzzle-mismatches" title={mismatches.length > 8 ? `需要检查的位置：${mismatches.map((position) => position + 1).join('、')}` : undefined}>{mismatches.length ? `检查第 ${mismatches.slice(0, 8).map((position) => position + 1).join('、')} 位${mismatches.length > 8 ? `等 ${mismatches.length} 处` : '字母'}（含缺字或多字）。` : activeCard?.hintUsed ? `${activeCard.word.definition_cn || '观察已揭晓的图片'} · ${Array.from(activeCard.word.text).length} 个字符` : '独立拼对 +100 分 · 看图后答对 +70 分'}</p>
                <p id="puzzle-feedback" className="puzzle-feedback" data-kind={impact ? impact.kind === 'wrong' ? 'wrong' : 'correct' : undefined} role="status" aria-live="polite">{feedback || '先听发音，再试着拼写。可以随时重播，不扣分。'}</p>
                <div className="puzzle-actions"><button type="button" disabled={paused} onClick={() => activeCard && activateCard(activeCard.word.id)}>{icon('volume_up')}重播</button><button type="button" disabled={paused || activeCard?.hintUsed} onClick={hint}>{icon('lightbulb')}图片提示</button><button type="button" disabled={paused} onClick={skip}>{icon('keyboard_double_arrow_right')}跳过</button></div>
              </section>
              <div className="puzzle-tips"><p><kbd>Enter</kbd> 提交，答对自动进入下一格</p><p><kbd>Alt</kbd> + <kbd>1–9</kbd> 自由选格</p></div>
              {cards.length === 9 && <div className="puzzle-next-line"><strong>{targets.length ? `第 ${targets.map((i) => i + 1).join(' / ')} 格，再进一步！` : '先选路线，再连成线'}</strong>{targets.length ? '紫色描边的格子，答对即可获得连线奖励。' : '横、竖、对角线皆可。试着先攻下中心格，它连接着四条路线。'}</div>}
            </>}
            {phase === 'RESULT' && result && <>
              <div className="puzzle-result-summary"><h3>{result.wordsCorrect === 9 ? '九格全亮，漂亮的一盘！' : '每点亮一格，记忆就更深一点。'}</h3><div className="puzzle-result-score"><strong>{result.totalScore}</strong><small>分</small></div></div>
              <div className="puzzle-result-metrics"><div><span>点亮格数</span><strong>{result.wordsCorrect}/{result.wordsTotal}</strong></div><div><span>完成连线</span><strong>{result.completedLines}</strong></div><div><span>用时 / 秒</span><strong>{result.timeUsedSeconds}</strong></div></div>
              <ul className="puzzle-result-breakdown"><li><label>单词得分</label><strong>+{result.totalScore - (result.lineBonus || 0) - (result.completionBonus || 0)}</strong></li><li><label>连线奖励</label><strong>+{result.lineBonus || 0}</strong></li><li><label>全盘奖励</label><strong>+{result.completionBonus || 0}</strong></li></ul>
              <p role="status">{saveStatus === 'saving' ? '正在保存学习记录…' : saveStatus === 'saved' ? '学习记录已保存。看看左侧的记忆图，再记一次。' : saveStatus === 'failed' ? '暂未保存成功，可重试；本局仍保留在这里。' : ''}</p>
              <div className="puzzle-result-actions">{saveStatus === 'failed' && <button type="button" className="puzzle-button" onClick={() => void persistResult(result)}>重试保存</button>}{retryWords.length > 0 && <button type="button" className="puzzle-button" onClick={() => void prepareGame(retryWords)} disabled={saveStatus === 'saving' || saveStatus === 'failed'}>再练这 {retryWords.length} 个词</button>}<button type="button" className={`puzzle-button ${retryWords.length ? 'puzzle-button-secondary' : ''}`} onClick={() => void prepareGame()} disabled={candidateCount < 9 || saveStatus === 'saving' || saveStatus === 'failed'}>新的一盘</button></div>
            </>}
          </div>
          <div className="puzzle-console-footer"><strong>练习局 · 进展自动保存</strong><br />{phase === 'PLAYING' ? '重播不扣分 · 提示后仍可连线' : '巩固记忆，本局成绩不计入旧排行榜'}</div>
        </aside>
      </div>
    </div>
    {showExitConfirm && <div className="puzzle-dialog"><section role="dialog" aria-modal="true" aria-labelledby="puzzle-exit-title"><h3 id="puzzle-exit-title">结束这一盘？</h3><p>已作答的单词会保存，未尝试的格子不会记为错误。</p><div><button type="button" className="puzzle-button puzzle-button-secondary" onClick={() => { setShowExitConfirm(false); resumeGame(); }}>继续练习</button><button type="button" className="puzzle-button" onClick={() => { setShowExitConfirm(false); finishGame(); }}>结束并查看</button></div></section></div>}
  </div>;
};
export default PuzzleGameMode;
