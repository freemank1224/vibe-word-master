import React, { useEffect, useRef, useState } from 'react';
import type { InputSession, WordEntry } from '../types';
import {
  advanceWordOrbit, createWordOrbitState, hintWordOrbit, orbitWordBudget, ORBIT_ACTION_SECONDS,
  ORBIT_TERRAINS, selectWordOrbitQuestions, skipWordOrbit, submitWordOrbit, summarizeWordOrbit,
  wordOrbitReviewQuestions,
  wordOrbitClue, formatOrbitMessage,
} from '../services/wordOrbit';
import type { OrbitEffect, OrbitTransition, WordOrbitQuestion, WordOrbitState, WordOrbitSummary } from '../services/wordOrbit';
import { createWordOrbitRenderer } from '../utils/wordOrbitRenderer';
import { useLanguage } from '../contexts/LanguageContext';
import './WordOrbitGameMode.css';

interface Props {
  allWords: WordEntry[];
  sessions: InputSession[];
  onComplete: (summary: WordOrbitSummary) => Promise<void> | void;
  onCancel: () => void;
}
type Animation = OrbitEffect & { elapsed: number; speed: number };
type Runtime = { apply: (transition: OrbitTransition) => void; sync: () => void; start: (questions: WordOrbitQuestion[]) => void; pause: (automatic?: boolean) => void; resume: () => void; draw: () => void; refreshLocale: () => void };
const ZONES = { zh: ['薄荷群丘', '珊瑚峡谷', '极光冰原'], en: ['Mint Hills', 'Coral Canyon', 'Aurora Icefield'] };
const newRoundId = () => globalThis.crypto?.randomUUID?.() || `orbit-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export default function WordOrbitGameMode({ allWords, sessions, onComplete, onCancel }: Props) {
  const { language, isZh } = useLanguage();
  const t = (zh: string, en: string) => isZh ? zh : en;
  const game = useRef(createWordOrbitState([], '', Date.now()));
  const [view, setView] = useState(game.current);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [lightMotion, setLightMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [save, setSave] = useState<{ id: string; status: 'saving' | 'saved' | 'failed' }>({ id: '', status: 'saved' });
  const [stageHeight, setStageHeight] = useState(210);
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const time = useRef<HTMLElement>(null);
  const distance = useRef<HTMLElement>(null);
  const wordClock = useRef<HTMLSpanElement>(null);
  const wordFill = useRef<HTMLDivElement>(null);
  const burst = useRef<HTMLDivElement>(null);
  const resultTitle = useRef<HTMLHeadingElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const composing = useRef(false);
  const settings = useRef({ soundEnabled, lightMotion, language });
  settings.current = { soundEnabled, lightMotion, language };
  const props = useRef({ allWords, sessions, onComplete, onCancel });
  props.current = { allWords, sessions, onComplete, onCancel };
  const alive = useRef(true);
  const loadGeneration = useRef(0);
  const savedRounds = useRef(new Set<string>());
  const persistedRounds = useRef(new Set<string>());
  const summaryCache = useRef(new Map<string, WordOrbitSummary>());
  const savingRounds = useRef(new Map<string, Promise<boolean>>());
  const exitAfterSave = useRef<string | null>(null);

  async function loadQuestions(startImmediately = false) {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadError(false);
    try {
      const questions = await selectWordOrbitQuestions(props.current.allWords, props.current.sessions);
      if (!alive.current || generation !== loadGeneration.current) return;
      if (startImmediately && questions.length) runtime.current?.start(questions);
      else {
        const next = createWordOrbitState(questions, newRoundId());
        game.current = next;
        setView(next);
        runtime.current?.draw();
      }
    } catch {
      if (alive.current && generation === loadGeneration.current) setLoadError(true);
    } finally {
      if (alive.current && generation === loadGeneration.current) setLoading(false);
    }
  }

  function cachedSummary(state: WordOrbitState) {
    const cached = summaryCache.current.get(state.roundId);
    if (cached) return cached;
    const summary = summarizeWordOrbit(state, Date.now());
    summaryCache.current.set(state.roundId, summary);
    return summary;
  }

  function saveSummary(summary: WordOrbitSummary): Promise<boolean> {
    if (persistedRounds.current.has(summary.roundId)) return Promise.resolve(true);
    const existing = savingRounds.current.get(summary.roundId);
    if (existing) return existing;
    setSave({ id: summary.roundId, status: 'saving' });
    const request = Promise.resolve().then(() => props.current.onComplete(summary)).then(() => {
      persistedRounds.current.add(summary.roundId);
      if (alive.current) setSave({ id: summary.roundId, status: 'saved' });
      return true;
    }, () => {
      if (alive.current) setSave({ id: summary.roundId, status: 'failed' });
      return false;
    }).finally(() => savingRounds.current.delete(summary.roundId));
    savingRounds.current.set(summary.roundId, request);
    return request;
  }

  async function saveAndMaybeExit(summary: WordOrbitSummary) {
    const success = await saveSummary(summary);
    if (success && alive.current && exitAfterSave.current === summary.roundId) {
      exitAfterSave.current = null;
      props.current.onCancel();
    }
  }

  function leaveRound() {
    runtime.current?.pause();
    const state = game.current;
    if (!state.results.length) { props.current.onCancel(); return; }
    exitAfterSave.current = state.roundId;
    // Preserve completed answers only; leaving must not create failures for unseen words.
    const finished: WordOrbitState = { ...state, phase: 'finished', feedback: { key: 'leave' } };
    runtime.current?.apply({ state: finished, effects: [] });
    void saveAndMaybeExit(cachedSummary(finished));
  }

  useEffect(() => {
    alive.current = true;
    if (!canvas.current) return;
    const renderer = createWordOrbitRenderer(canvas.current);
    let raf: number | null = null;
    let lastNow = performance.now();
    let lastHud = 0;
    let worldTime = 0;
    let action: Animation | null = null;
    let queued: Animation | null = null;
    let burstUntil = 0;
    let burstMessage: OrbitEffect['text'] | null = null;
    let audio: AudioContext | null = null;
    let destroyed = false;

    function draw() {
      const state = game.current;
      const question = state.questions[Math.min(state.index, state.questions.length - 1)];
      const terrain = ORBIT_TERRAINS[state.index % 3];
      renderer.render({ time: worldTime, running: state.phase === 'playing', reducedMotion: settings.current.lightMotion,
        progress: action ? 1 : state.phase === 'ready' ? .5 : Math.min(1, 1 - state.questionRemainingMs / orbitWordBudget(question?.answer || '')),
        obstacle: action?.obstacle || terrain.obstacle, action: action ? { type: action.action, elapsed: action.elapsed } : null,
        combo: state.combo, zone: Math.min(2, Math.floor(state.correctCount / 4)) });
      if (burst.current) {
        if (burstMessage) burst.current.textContent = formatOrbitMessage(burstMessage, settings.current.language);
        if (worldTime >= burstUntil) burst.current.style.opacity = '0';
      }
    }
    function hud() {
      const state = game.current;
      const seconds = Math.ceil(state.remainingMs / 1_000);
      if (time.current) time.current.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      const zh = settings.current.language === 'zh';
      if (distance.current) distance.current.textContent = `${Math.floor(state.distance)} ${zh ? '米' : 'm'}`;
      if (wordClock.current) wordClock.current.textContent = state.phase === 'ready' ? (zh ? '准备起跑' : 'Ready to run') : (zh ? `距障碍 ${Math.ceil(state.questionRemainingMs / 1_000)} 秒` : `Obstacle in ${Math.ceil(state.questionRemainingMs / 1_000)}s`);
      if (wordFill.current) {
        const answer = state.questions[Math.min(state.index, state.questions.length - 1)]?.answer || '';
        wordFill.current.style.width = `${Math.min(100, state.questionRemainingMs / orbitWordBudget(answer) * 100)}%`;
        wordFill.current.dataset.urgent = String(state.questionRemainingMs < 3_000);
      }
    }
    function playSound(effect: OrbitEffect) {
      if (!settings.current.soundEnabled) return;
      try {
        const Audio = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Audio) return;
        audio ||= new Audio();
        void audio.resume().catch(() => {});
        const now = audio.currentTime;
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.type = effect.action === 'fall' ? 'triangle' : 'sine';
        oscillator.frequency.setValueAtTime(effect.action === 'fall' ? 170 : effect.action === 'jet' ? 580 : 420, now);
        oscillator.frequency.exponentialRampToValueAtTime(effect.action === 'fall' ? 55 : 900, now + .12);
        gain.gain.setValueAtTime(.0001, now);
        gain.gain.exponentialRampToValueAtTime(.08, now + .014);
        gain.gain.exponentialRampToValueAtTime(.0001, now + .22);
        oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(now); oscillator.stop(now + .24);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      } catch { /* Audio availability never blocks answering. */ }
    }
    function enqueue(effect: OrbitEffect) {
      const next = { ...effect, elapsed: 0, speed: 1 };
      if (!action) action = next;
      else {
        // Catch up quickly instead of accumulating animations behind fast answers.
        action.speed = Math.max(1, (ORBIT_ACTION_SECONDS[action.action] - action.elapsed) / .18);
        queued = next;
      }
      burstMessage = effect.text;
      if (burst.current) { burst.current.textContent = formatOrbitMessage(effect.text, settings.current.language); burst.current.style.opacity = '1'; }
      burstUntil = worldTime + .8;
      playSound(effect);
    }
    function apply(transition: OrbitTransition) {
      const previous = game.current;
      game.current = transition.state;
      transition.effects.forEach(enqueue);
      // Time-only updates stay in refs; React renders question / phase changes only.
      if (previous.index !== transition.state.index || previous.phase !== transition.state.phase || previous.feedback !== transition.state.feedback || previous.input !== transition.state.input || previous.hintUsed !== transition.state.hintUsed) setView(transition.state);
      hud();
      if (previous.index !== transition.state.index && transition.state.phase === 'playing') {
        requestAnimationFrame(() => { if (!destroyed) input.current?.focus({ preventScroll: true }); });
      }
      ensureFrame();
    }
    function sync() {
      const now = performance.now();
      const elapsed = Math.max(0, now - lastNow);
      lastNow = now;
      apply(advanceWordOrbit(game.current, elapsed));
    }
    function loop(now: number) {
      raf = null;
      if (destroyed) return;
      const elapsed = Math.max(0, now - lastNow);
      lastNow = now;
      const state = game.current;
      if (state.phase === 'playing' || state.phase === 'finished' && action) {
        worldTime += Math.min(elapsed / 1_000, .12);
        if (action) {
          action.elapsed += elapsed / 1_000 * action.speed;
          if (action.elapsed >= ORBIT_ACTION_SECONDS[action.action]) { action = queued; queued = null; }
        }
      }
      if (state.phase === 'playing') apply(advanceWordOrbit(state, elapsed));
      if (now - lastHud >= 100) { hud(); lastHud = now; }
      draw();
      ensureFrame();
    }
    function ensureFrame() {
      if (!destroyed && raf === null && (game.current.phase === 'playing' || game.current.phase === 'finished' && action)) raf = requestAnimationFrame(loop);
    }
    function start(questions: WordOrbitQuestion[]) {
      if (!questions.length) return;
      action = null; queued = null; worldTime = 0; burstUntil = 0; burstMessage = null;
      if (burst.current) burst.current.textContent = '';
      composing.current = false;
      lastNow = performance.now();
      const next = { ...createWordOrbitState(questions, newRoundId()), phase: 'playing' as const };
      game.current = next; setView(next); hud(); draw(); ensureFrame();
    }
    function pause(automatic = false) {
      if (game.current.phase !== 'playing') return;
      sync();
      if (game.current.phase !== 'playing') return;
      const next: WordOrbitState = { ...game.current, phase: 'paused', feedback: { key: automatic ? 'autoPause' : 'pause' } };
      game.current = next; setView(next);
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null; draw();
    }
    function resume() {
      if (game.current.phase !== 'paused') return;
      lastNow = performance.now();
      const next: WordOrbitState = { ...game.current, phase: 'playing', feedback: { key: 'resume' } };
      game.current = next; setView(next); ensureFrame();
    }
    runtime.current = { apply, sync, start, pause, resume, draw, refreshLocale: () => { hud(); draw(); } };
    const observer = new ResizeObserver(draw);
    observer.observe(canvas.current);
    const visibility = () => { if (document.hidden) pause(true); };
    const blur = () => pause(true);
    const viewport = () => setStageHeight(Math.max(150, Math.min(210, (window.visualViewport?.height || window.innerHeight) - 290)));
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motionChanged = (event: MediaQueryListEvent) => setLightMotion(event.matches);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', blur);
    window.visualViewport?.addEventListener('resize', viewport);
    motionQuery.addEventListener('change', motionChanged);
    viewport(); draw();
    void loadQuestions();
    return () => {
      destroyed = true; alive.current = false; loadGeneration.current++;
      if (raf !== null) cancelAnimationFrame(raf);
      observer.disconnect(); renderer.destroy(); runtime.current = null;
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', blur);
      window.visualViewport?.removeEventListener('resize', viewport);
      motionQuery.removeEventListener('change', motionChanged);
      void audio?.close().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (view.phase === 'playing') input.current?.focus({ preventScroll: true });
    if (view.phase === 'finished') resultTitle.current?.focus({ preventScroll: true });
  }, [view.phase, view.roundId]);
  useEffect(() => { runtime.current?.draw(); }, [lightMotion]);
  useEffect(() => { runtime.current?.refreshLocale(); }, [language]);
  useEffect(() => {
    if (view.phase !== 'finished' || savedRounds.current.has(view.roundId)) return;
    const summary = cachedSummary(game.current);
    savedRounds.current.add(view.roundId);
    void saveAndMaybeExit(summary);
  }, [view.phase, view.roundId]);

  function act(callback: (state: WordOrbitState) => OrbitTransition) {
    if (composing.current || game.current.phase !== 'playing') return;
    const index = game.current.index;
    runtime.current?.sync();
    if (game.current.phase !== 'playing' || game.current.index !== index) return;
    runtime.current?.apply(callback(game.current));
    input.current?.focus({ preventScroll: true });
  }
  const question = view.questions[Math.min(view.index, view.questions.length - 1)];
  const playing = view.phase === 'playing';
  const terrain = ORBIT_TERRAINS[view.index % 3];
  const review = view.phase === 'finished' ? wordOrbitReviewQuestions(view) : [];
  const savePending = save.id === view.roundId && save.status === 'saving';
  const saveFailed = save.id === view.roundId && save.status === 'failed';

  const clue = question ? wordOrbitClue(question, language) : '';
  const loadErrorMessage = t('词库准备失败，请重试。', 'Could not prepare your words. Please try again.');

  return <main className={`word-orbit ${playing ? 'or-compact' : ''}`} data-phase={view.phase} lang={language === 'zh' ? 'zh-CN' : 'en'} style={{ '--or-stage-height': `${stageHeight}px` } as React.CSSProperties} aria-label={t('星词漫游', 'Word Orbit')}>
    <header className="or-header"><div><span className="or-kicker">{t('词汇星球', 'WORD ORBIT')}</span><h1>{t('星词漫游', 'Word Orbit')} <span>{t('练习模式', 'Practice mode')}</span></h1></div><button type="button" className="or-quiet" onClick={leaveRound} disabled={savePending}>{t('返回', 'Back')}</button></header>
    <div className="or-hud"><div><span>{t('剩余时间', 'Time left')}</span><strong ref={time}>01:30</strong></div><div><span>{t('探索距离', 'Distance')}</span><strong ref={distance}>{t('0 米', '0 m')}</strong></div><div><span>{t('连续越障', 'Combo')}</span><strong>{view.combo}</strong></div><button className="or-quiet" type="button" disabled={view.phase === 'ready' || view.phase === 'finished'} onClick={() => view.phase === 'paused' ? runtime.current?.resume() : runtime.current?.pause()}>{view.phase === 'paused' ? t('继续', 'Resume') : t('暂停', 'Pause')}</button></div>
    <div className="or-world">
      <canvas ref={canvas} role="img" aria-label={t('第三人称宇航员在星球跑道上前进，答对翻越障碍，答错跌倒后继续', 'Third-person astronaut running across a planet. Correct answers clear obstacles; mistakes cause a recoverable stumble.')} />
      <div className="or-location"><span>{ZONES[language][Math.min(2, Math.floor(view.correctCount / 4))]}</span><span>{t('前方', 'Ahead')} · {isZh ? terrain.name : terrain.nameEn}</span></div>
      <div ref={burst} className="or-burst" aria-hidden="true" />
      {view.phase === 'ready' || view.phase === 'paused' ? <div className="or-gate">
        <strong>{view.phase === 'paused' ? t('星球等你继续。', 'The planet is waiting for you.') : t('下一步，跨过这个单词。', 'Your next word is your next leap.')}</strong>
        <span>{view.phase === 'paused' ? t('当前输入与剩余时间已保留', 'Your answer and remaining time are saved') : t('答对翻越 · 答错摔跤 · 改对继续', 'Answer to vault · Stumble · Correct and recover')}</span>
        {loading ? <p role="status">{t('正在准备你的复习词…', 'Preparing your review words…')}</p> : loadError ? <><p role="alert">{loadErrorMessage}</p><button className="or-main" onClick={() => void loadQuestions()}>{t('重新准备', 'Try again')}</button></> : !question ? <><p>{t('还没有适合练习的英文单词，请先添加单词和释义。', 'No eligible words yet. Add English words with definitions first.')}</p><button className="or-main" onClick={onCancel}>{t('返回添加单词', 'Back to add words')}</button></> : <button className="or-main" type="button" onClick={() => view.phase === 'paused' ? runtime.current?.resume() : runtime.current?.start(view.questions)}>{view.phase === 'paused' ? t('继续跑 →', 'Keep running →') : t('开始 90 秒 →', 'Start 90 seconds →')}</button>}
      </div> : null}
    </div>
    {view.phase !== 'finished' ? <section className="or-play" aria-label={t('填词越障', 'Fill in a word to clear the obstacle')}>
      <div className="or-question-meta"><span>{t(`第 ${Math.min(view.index + 1, view.questions.length)} / ${view.questions.length} 个障碍`, `Obstacle ${Math.min(view.index + 1, view.questions.length)} / ${view.questions.length}`)}</span><span ref={wordClock}>{t('准备起跑', 'Ready to run')}</span></div>
      <div className="or-word-track" aria-hidden="true"><div ref={wordFill} /></div>
      <p className="or-sentence">{question?.before || ''}<span className="or-blank">{view.input ? Array.from(view.input as string).map((letter, index) => <span key={index} className={view.invalid && letter.toLowerCase() !== question?.answer[index] ? 'or-wrong' : undefined}>{letter}</span>) : '···'}</span>{question?.after || ''}</p>
      <p className="or-clue">{clue || t('从已有词库挑选需要复习的单词', 'Words are selected from your review queue')}{question ? t(` · ${question.answer.length} 个字母`, ` · ${question.answer.length} letters`) : ''}{view.hintUsed && question ? t(` · 首字母 ${question.answer[0].toUpperCase()}`, ` · Starts with ${question.answer[0].toUpperCase()}`) : ''}</p>
      <span className="or-sr" aria-live="polite" aria-atomic="true">{playing && question ? t(`第 ${view.index + 1} 题。${question.before || ''}空白${question.after || ''}。提示：${clue}，${question.answer.length} 个字母。`, `Question ${view.index + 1}. ${question.before || ''}blank${question.after || ''}. Clue: ${clue}. ${question.answer.length} letters.`) : ''}</span>
      <label className="or-input-label" htmlFor="word-orbit-input">{question?.before !== undefined ? t('填入缺失的英文单词', 'Fill in the missing word') : t('根据提示填入英文单词', 'Type the word that matches the clue')}</label>
      <div className="or-input-row"><input ref={input} id="word-orbit-input" value={view.input} type="text" inputMode="text" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} maxLength={40} enterKeyHint="go" placeholder={t('输入单词，Enter 越障', 'Type a word, then press Enter')} aria-describedby="word-orbit-feedback" aria-invalid={view.invalid || undefined} disabled={!playing}
        onChange={event => { if (game.current.phase !== 'playing') return; const next = { ...game.current, input: event.target.value, invalid: false }; game.current = next; setView(next); }}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat && !event.nativeEvent.isComposing && event.keyCode !== 229) act(state => submitWordOrbit(state)); } }} />
        <button type="button" className="or-main" disabled={!playing} onClick={() => act(state => submitWordOrbit(state))}>{isZh ? terrain.verb : terrain.verbEn} <span aria-hidden="true">↵</span></button></div>
      <div className="or-feedback-row"><p id="word-orbit-feedback" role="status" aria-live="polite" data-error={view.invalid}>{formatOrbitMessage(view.feedback, language)}</p><div className="or-assists"><button className="or-quiet" type="button" disabled={!playing || view.hintUsed} onClick={() => act(state => ({ state: hintWordOrbit(state), effects: [] }))}>{t('首字母', 'First letter')}</button><button className="or-quiet" type="button" disabled={!playing} onClick={() => act(state => ({ state: skipWordOrbit(state), effects: [] }))}>{t('绕行', 'Skip')}</button></div></div>
    </section> : <section className="or-result" aria-label={t('本轮结果', 'Run results')}>
      <span className="or-kicker">{t('这一程的收获', 'YOUR JOURNEY')}</span><h2 ref={resultTitle} tabIndex={-1}>{view.remainingMs <= 0 ? t('时间到，收好这一程。', 'Time’s up. Journey complete.') : t('这一圈，跑完了。', 'Another orbit complete.')}</h2>
      <p>{t(`越过 ${view.correctCount} 个障碍 · 最佳 ${view.bestCombo} 连击 · ${view.score} 分 · ${Math.floor(view.distance)} 米`, `${view.correctCount} obstacles cleared · Best combo ${view.bestCombo} · ${view.score} points · ${Math.floor(view.distance)} m`)}</p>
      <div className="or-review">{review.length ? review.map(item => <span key={item.wordId}><b>{item.answer}</b> · {wordOrbitClue(item, language)}</span>) : <span>{t('本轮已作答单词全部独立完成', 'Every answered word completed without help')}</span>}</div>
      <p className="or-save" role="status">{savePending ? t('正在保存本轮练习…', 'Saving this run…') : saveFailed ? t('本轮结果未保存，请重试后继续。', 'Your results could not be saved. Retry to continue.') : t('练习结果已记录；积分仅用于本轮，不计金币和旧排行榜。', 'Practice saved. Points apply to this run only; no coins or leaderboard points are awarded.')}</p>
      {loadError ? <p role="alert">{loadErrorMessage}</p> : null}
      <div className="or-result-actions">{saveFailed ? <button className="or-main" onClick={() => { const summary = summaryCache.current.get(view.roundId); if (summary) void saveAndMaybeExit(summary); }}>{t('重试保存', 'Retry save')}</button> : <>
        {review.length ? <button className="or-main" disabled={savePending} onClick={() => runtime.current?.start(review)}>{t(`回练这 ${review.length} 个词`, `Review ${review.length} words`)}</button> : null}
        <button className={review.length ? 'or-secondary' : 'or-main'} disabled={savePending || loading} onClick={() => void loadQuestions(true)}>{loading ? t('准备中…', 'Preparing…') : t('再跑一程', 'Run again')}</button>
        <button className="or-quiet" disabled={savePending} onClick={leaveRound}>{t('返回词库', 'Back to words')}</button>
      </>}</div>
    </section>}
    <footer className="or-footer"><span>{t('按复习优先级选词 · 90 秒探索', 'Review-priority words · 90-second exploration')}</span><div><button className="or-quiet" type="button" aria-pressed={soundEnabled} onClick={() => setSoundEnabled(value => !value)}>{t('音效：', 'Sound: ')}{soundEnabled ? t('开', 'On') : t('关', 'Off')}</button><button className="or-quiet" type="button" aria-pressed={lightMotion} onClick={() => setLightMotion(value => !value)}>{t('轻动态：', 'Reduced motion: ')}{lightMotion ? t('开', 'On') : t('关', 'Off')}</button></div></footer>
  </main>;
}
