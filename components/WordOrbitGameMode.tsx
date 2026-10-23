import React, { useEffect, useRef, useState } from 'react';
import type { InputSession, WordEntry } from '../types';
import {
  advanceWordOrbit, createWordOrbitState, hintWordOrbit, orbitWordBudget, ORBIT_ACTION_SECONDS,
  ORBIT_TERRAINS, selectWordOrbitQuestions, skipWordOrbit, submitWordOrbit, summarizeWordOrbit,
  wordOrbitReviewQuestions,
} from '../services/wordOrbit';
import type { OrbitEffect, OrbitTransition, WordOrbitQuestion, WordOrbitState, WordOrbitSummary } from '../services/wordOrbit';
import { createWordOrbitRenderer } from '../utils/wordOrbitRenderer';
import './WordOrbitGameMode.css';

interface Props {
  allWords: WordEntry[];
  sessions: InputSession[];
  onComplete: (summary: WordOrbitSummary) => Promise<void> | void;
  onCancel: () => void;
}
type Animation = OrbitEffect & { elapsed: number; speed: number };
type Runtime = { apply: (transition: OrbitTransition) => void; sync: () => void; start: (questions: WordOrbitQuestion[]) => void; pause: (automatic?: boolean) => void; resume: () => void; draw: () => void };
const ZONES = ['薄荷群丘', '珊瑚峡谷', '极光冰原'];
const newRoundId = () => globalThis.crypto?.randomUUID?.() || `orbit-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export default function WordOrbitGameMode({ allWords, sessions, onComplete, onCancel }: Props) {
  const game = useRef(createWordOrbitState([], '', Date.now()));
  const [view, setView] = useState(game.current);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
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
  const settings = useRef({ soundEnabled, lightMotion });
  settings.current = { soundEnabled, lightMotion };
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
    setLoadError('');
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
      if (alive.current && generation === loadGeneration.current) setLoadError('词库准备失败，请重试。');
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
    const finished = { ...state, phase: 'finished' as const, feedback: '本轮已结束，正在保存已作答单词。' };
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
      if (burst.current && worldTime >= burstUntil) burst.current.style.opacity = '0';
    }
    function hud() {
      const state = game.current;
      const seconds = Math.ceil(state.remainingMs / 1_000);
      if (time.current) time.current.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      if (distance.current) distance.current.textContent = `${Math.floor(state.distance)} m`;
      if (wordClock.current) wordClock.current.textContent = state.phase === 'ready' ? '准备起跑' : `距障碍 ${Math.ceil(state.questionRemainingMs / 1_000)} 秒`;
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
      if (burst.current) { burst.current.textContent = effect.text; burst.current.style.opacity = '1'; }
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
      action = null; queued = null; worldTime = 0; burstUntil = 0;
      composing.current = false;
      lastNow = performance.now();
      const next = { ...createWordOrbitState(questions, newRoundId()), phase: 'playing' as const };
      game.current = next; setView(next); hud(); draw(); ensureFrame();
    }
    function pause(automatic = false) {
      if (game.current.phase !== 'playing') return;
      sync();
      if (game.current.phase !== 'playing') return;
      const next = { ...game.current, phase: 'paused' as const, feedback: automatic ? '离开画面时已暂停。' : '已暂停，输入还在。' };
      game.current = next; setView(next);
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null; draw();
    }
    function resume() {
      if (game.current.phase !== 'paused') return;
      lastNow = performance.now();
      const next = { ...game.current, phase: 'playing' as const, feedback: '继续跑，下一步由你决定。' };
      game.current = next; setView(next); ensureFrame();
    }
    runtime.current = { apply, sync, start, pause, resume, draw };
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

  return <main className={`word-orbit ${playing ? 'or-compact' : ''}`} data-phase={view.phase} style={{ '--or-stage-height': `${stageHeight}px` } as React.CSSProperties} aria-label="星词漫游">
    <header className="or-header"><div><span className="or-kicker">WORD ORBIT</span><h1>星词漫游 <span>练习模式</span></h1></div><button type="button" className="or-quiet" onClick={leaveRound} disabled={savePending}>返回</button></header>
    <div className="or-hud"><div><span>剩余时间</span><strong ref={time}>01:30</strong></div><div><span>探索距离</span><strong ref={distance}>0 m</strong></div><div><span>连续越障</span><strong>{view.combo}</strong></div><button className="or-quiet" type="button" disabled={view.phase === 'ready' || view.phase === 'finished'} onClick={() => view.phase === 'paused' ? runtime.current?.resume() : runtime.current?.pause()}>{view.phase === 'paused' ? '继续' : '暂停'}</button></div>
    <div className="or-world">
      <canvas ref={canvas} role="img" aria-label="第三人称宇航员在星球跑道上前进，答对翻越障碍，答错跌倒后继续" />
      <div className="or-location"><span>{ZONES[Math.min(2, Math.floor(view.correctCount / 4))]}</span><span>前方 · {terrain.name}</span></div>
      <div ref={burst} className="or-burst" aria-hidden="true" />
      {view.phase === 'ready' || view.phase === 'paused' ? <div className="or-gate">
        <strong>{view.phase === 'paused' ? '星球等你继续。' : '下一步，跨过这个单词。'}</strong>
        <span>{view.phase === 'paused' ? '当前输入与剩余时间已保留' : '答对翻越 · 答错摔跤 · 改对继续'}</span>
        {loading ? <p role="status">正在准备你的复习词…</p> : loadError ? <><p role="alert">{loadError}</p><button className="or-main" onClick={() => void loadQuestions()}>重新准备</button></> : !question ? <><p>还没有带中文释义的英文单词。</p><button className="or-main" onClick={onCancel}>返回添加单词</button></> : <button className="or-main" type="button" onClick={() => view.phase === 'paused' ? runtime.current?.resume() : runtime.current?.start(view.questions)}>{view.phase === 'paused' ? '继续跑 →' : '开始 90 秒 →'}</button>}
      </div> : null}
    </div>
    {view.phase !== 'finished' ? <section className="or-play" aria-label="填词越障">
      <div className="or-question-meta"><span>第 {Math.min(view.index + 1, view.questions.length)} / {view.questions.length} 个障碍</span><span ref={wordClock}>准备起跑</span></div>
      <div className="or-word-track" aria-hidden="true"><div ref={wordFill} /></div>
      <p className="or-sentence">{question?.before || ''}<span className="or-blank">{view.input ? Array.from(view.input as string).map((letter, index) => <span key={index} className={view.invalid && letter.toLowerCase() !== question?.answer[index] ? 'or-wrong' : undefined}>{letter}</span>) : '···'}</span>{question?.after || ''}</p>
      <p className="or-clue">{question?.clue || '从已有词库挑选需要复习的单词'}{question ? ` · ${question.answer.length} 个字母` : ''}{view.hintUsed && question ? ` · 首字母 ${question.answer[0].toUpperCase()}` : ''}</p>
      <span className="or-sr" aria-live="polite" aria-atomic="true">{playing && question ? `第 ${view.index + 1} 题。${question.before || ''}空白${question.after || ''}。提示：${question.clue}，${question.answer.length} 个字母。` : ''}</span>
      <label className="or-input-label" htmlFor="word-orbit-input">{question?.before !== undefined ? '填入缺失的英文单词' : '根据释义填入英文单词'}</label>
      <div className="or-input-row"><input ref={input} id="word-orbit-input" value={view.input} type="text" inputMode="text" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} maxLength={40} enterKeyHint="go" placeholder="输入单词，Enter 越障" aria-describedby="word-orbit-feedback" aria-invalid={view.invalid || undefined} disabled={!playing}
        onChange={event => { if (game.current.phase !== 'playing') return; const next = { ...game.current, input: event.target.value, invalid: false }; game.current = next; setView(next); }}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat && !event.nativeEvent.isComposing && event.keyCode !== 229) act(state => submitWordOrbit(state)); } }} />
        <button type="button" className="or-main" disabled={!playing} onClick={() => act(state => submitWordOrbit(state))}>{terrain.verb} <span aria-hidden="true">↵</span></button></div>
      <div className="or-feedback-row"><p id="word-orbit-feedback" role="status" aria-live="polite" data-error={view.invalid}>{view.feedback}</p><div className="or-assists"><button className="or-quiet" type="button" disabled={!playing || view.hintUsed} onClick={() => act(state => ({ state: hintWordOrbit(state), effects: [] }))}>首字母</button><button className="or-quiet" type="button" disabled={!playing} onClick={() => act(state => ({ state: skipWordOrbit(state), effects: [] }))}>绕行</button></div></div>
    </section> : <section className="or-result" aria-label="本轮结果">
      <span className="or-kicker">这一程的收获</span><h2 ref={resultTitle} tabIndex={-1}>{view.remainingMs <= 0 ? '时间到，收好这一程。' : '这一圈，跑完了。'}</h2>
      <p>越过 {view.correctCount} 个障碍 · 最佳 {view.bestCombo} 连击 · {view.score} 分 · {Math.floor(view.distance)} 米</p>
      <div className="or-review">{review.length ? review.map(item => <span key={item.wordId}><b>{item.answer}</b> · {item.clue}</span>) : <span>本轮已作答单词全部独立完成</span>}</div>
      <p className="or-save" role="status">{savePending ? '正在保存本轮练习…' : saveFailed ? '本轮结果未保存，请重试后继续。' : '练习结果已记录；积分仅用于本轮，不计金币和旧排行榜。'}</p>
      {loadError ? <p role="alert">{loadError}</p> : null}
      <div className="or-result-actions">{saveFailed ? <button className="or-main" onClick={() => { const summary = summaryCache.current.get(view.roundId); if (summary) void saveAndMaybeExit(summary); }}>重试保存</button> : <>
        {review.length ? <button className="or-main" disabled={savePending} onClick={() => runtime.current?.start(review)}>回练这 {review.length} 个词</button> : null}
        <button className={review.length ? 'or-secondary' : 'or-main'} disabled={savePending || loading} onClick={() => void loadQuestions(true)}>{loading ? '准备中…' : '再跑一程'}</button>
        <button className="or-quiet" disabled={savePending} onClick={leaveRound}>返回词库</button>
      </>}</div>
    </section>}
    <footer className="or-footer"><span>按复习优先级选词 · 90 秒探索</span><div><button className="or-quiet" type="button" aria-pressed={soundEnabled} onClick={() => setSoundEnabled(value => !value)}>音效：{soundEnabled ? '开' : '关'}</button><button className="or-quiet" type="button" aria-pressed={lightMotion} onClick={() => setLightMotion(value => !value)}>轻动态：{lightMotion ? '开' : '关'}</button></div></footer>
  </main>;
}
