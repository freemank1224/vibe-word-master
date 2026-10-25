import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import { LargeWordInput } from '../../components/LargeWordInput';
import { createSurfState, currentSurfWord, pauseSurf, resumeSurf, setSurfInput, submitSurf, tickSurf } from './game';
import { SURF_BASE_SPEED, SURF_MAX_HITS, SURF_CHASE_TRIGGER, SURF_CHASE_ESCAPE_WORDS, SURF_CHASE_MAX_MISTAKES, surfMagnetMultiplier, surfSpeedMultiplier } from './constants';
import { SURF_MONSTERS } from './monsters';
import { createSurfRenderer } from './renderer';
import { SurfAudio } from './audio';
import { SurfRecordingBuffer } from './recordingBuffer';
import { SurfLaunchOptions, type SurfLaunchProgress } from './SurfLaunchOptions';
import { modeFromSlider } from './runMode';
import { SURF_WORDS } from './words';
import { getRecordedPronunciationUrls, rememberRecordedPronunciation } from '../../services/pronunciationService';
import { getDailySurfMonster, millisecondsUntilNextSurfDay, refreshDailySurfMonster } from './dailyMonster';
import { useSurfSession } from './useSurfSession';
import { estimateMonsterSurfReward } from '../../services/monsterSurfService';
import { SurfRunReview } from './SurfRunReview';
import { buildSurfRunReview } from './runReview';
import type { SurfRenderer, SurfState, SurfWord } from './types';

const surfImageCache = new Map<string, Promise<HTMLImageElement>>();

function loadSurfImage(source: string): Promise<HTMLImageElement> {
  const cached = surfImageCache.get(source);
  if (cached) return cached;
  const pending = (async () => {
    const image = new Image();
    image.decoding = 'async';
    image.src = source;
    await image.decode();
    return image;
  })();
  surfImageCache.set(source, pending);
  void pending.catch(() => {
    if (surfImageCache.get(source) === pending) surfImageCache.delete(source);
  });
  return pending;
}

function Icon({ name, size = 20 }: { name: 'coin' | 'crystal' | 'heart' | 'sound' | 'pause' | 'play' | 'wave' | 'arrow' | 'magnet' | 'restart' | 'bird'; size?: number }) {
  const paths = {
    coin: <><circle cx="12" cy="12" r="9"/><path d="m12 6 4 6-4 6-4-6z"/></>,
    crystal: <><path d="m3 8 5-5h8l5 5-9 13z"/><path d="M3 8h18M8 3l4 5 4-5M12 8v13"/></>,
    heart: <path d="M20.8 4.6a5.4 5.4 0 0 0-7.6 0L12 5.8l-1.2-1.2a5.4 5.4 0 0 0-7.6 7.6L12 21l8.8-8.8a5.4 5.4 0 0 0 0-7.6Z"/>,
    sound: <><path d="m11 4-6 5H2v6h3l6 5zM16 8c3 2 3 6 0 8M19 4c6 4 6 12 0 16"/></>,
    pause: <path d="M8 5v14M16 5v14"/>,
    play: <path d="m8 4 12 8-12 8z"/>,
    wave: <><path d="M2 17c3-3 5 3 8 0s5 3 8 0 4 0 4 0M3 12c3-5 6-8 10-8 4 0 5 5 1 7 3 2 6 1 8-1"/></>,
    arrow: <path d="M4 12h15m-6-6 6 6-6 6"/>,
    magnet: <><path d="M5 3v9a7 7 0 0 0 14 0V3h-5v9a2 2 0 0 1-4 0V3zM5 7h5m4 0h5"/></>,
    restart: <><path d="M3 10a9 9 0 1 1 2 8M3 3v7h7"/></>,
    bird: <><path d="M2 8c4-2 7-1 10 4 3-5 6-6 10-4M12 12v5m-3-2 3 2 3-2"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={name === 'heart' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export default function MonsterSurf() {
  const { isZh, toggleLanguage } = useLanguage();
  const t = (zh: string, en: string) => isZh ? zh : en;
  const session = useSurfSession();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const starting = useRef(false);
  const settlingRun = useRef<string | null>(null);
  const previousAccount = useRef<string | null>(null);
  const shownRecoveredRuns = useRef(new Set<string>());
  const [view, setView] = useState(() => createSurfState(getDailySurfMonster()));
  const state = useRef(view);
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const renderer = useRef<SurfRenderer | null>(null);
  const audio = useRef<SurfAudio | null>(null);
  const recordings = useRef<SurfRecordingBuffer | null>(null);
  const launchAbort = useRef<AbortController | null>(null);
  const [modeValue, setModeValue] = useState(20);
  const modeValueRef = useRef(modeValue);
  modeValueRef.current = modeValue;
  const [preload, setPreload] = useState<SurfLaunchProgress | null>(null);
  const lastTime = useRef<number | null>(null);
  const lastEvent = useRef(0);
  const [sound, setSound] = useState(true);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const settings = useRef({ sound, reduced });
  settings.current = { sound, reduced };
  const [assets, setAssets] = useState<'loading' | 'ready' | 'error'>('loading');
  const [assetAttempt, setAssetAttempt] = useState(0);
  const loadedMonster = useRef<number | null>(null);
  const sceneImages = useRef<{ sprites: HTMLImageElement[]; islands: HTMLImageElement; gulls: HTMLImageElement } | null>(null);
  const seaMonsterImage = useRef<HTMLImageElement | undefined>(undefined);
  const [seaArtwork, setSeaArtwork] = useState<'loading' | 'ready' | 'error'>('loading');
  const [seaArtworkAttempt, setSeaArtworkAttempt] = useState(0);
  const pendingStart = useRef(false);
  const [speech, setSpeech] = useState<'idle' | 'loading' | 'played' | 'error'>('idle');
  const speechRequest = useRef(0);
  const spokenCheckpoint = useRef(-1);
  const heardCheckpoint = useRef(-1);
  const composing = useRef(false);
  const controls = useRef({ begin: () => {}, pause: () => {}, resume: () => {}, replay: () => {} });

  const apply = useCallback((next: SurfState, publish = true) => {
    const gainedCrystals = Math.max(0, next.coins - state.current.coins);
    state.current = next;
    sessionRef.current.capture(next);
    if (next.event && next.event.id !== lastEvent.current) {
      lastEvent.current = next.event.id;
      audio.current?.play(next.event.kind, gainedCrystals || next.event.count || 1);
    }
    if (publish) setView(next);
  }, []);
  useEffect(() => {
    let midnightTimer = 0;
    const refresh = () => {
      const next = refreshDailySurfMonster(state.current);
      if (next !== state.current) apply(next);
    };
    const scheduleMidnight = () => {
      window.clearTimeout(midnightTimer);
      midnightTimer = window.setTimeout(() => {
        refresh(); scheduleMidnight();
      }, millisecondsUntilNextSurfDay() + 25);
    };
    const onFocus = () => { refresh(); scheduleMidnight(); };
    const onVisibility = () => { if (!document.hidden) onFocus(); };
    onFocus();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearTimeout(midnightTimer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [apply]);

  const focusInput = () => requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
  const stopSpeech = () => { speechRequest.current += 1; audio.current?.stopSpeech(); setSpeech('idle'); };
  const canListen = (phase: SurfState['phase']) => ['surfing', 'hurt', 'cleared'].includes(phase);
  const playPrompt = (slow = false) => {
    if (!canListen(state.current.phase)) return;
    const request = ++speechRequest.current;
    setSpeech('loading');
    audio.current?.unlock();
    const prompt = currentSurfWord(state.current);
    const checkpoint = state.current.checkpoint;
    void audio.current?.speak(prompt.answer, slow, prompt.audioUrl).then(ok => {
      if (request === speechRequest.current && canListen(state.current.phase)) {
        if (ok && state.current.checkpoint === checkpoint) heardCheckpoint.current = checkpoint;
        setSpeech(ok ? 'played' : 'error');
        if (ok) focusInput();
      }
    });
    focusInput();
  };
  const startLoadedRun = useCallback(async (monsterId: number) => {
    if (starting.current) return;
    starting.current = true;
    pendingStart.current = false;
    const abort = new AbortController(); launchAbort.current = abort;
    try {
      const next = await sessionRef.current.begin(monsterId, modeFromSlider(modeValueRef.current), async (deck, mode, checkpoint) => {
        if (abort.signal.aborted) throw new DOMException('Preparation cancelled', 'AbortError');
        const buffer = recordings.current;
        if (!buffer) throw new Error('Recordings are not ready');
        try {
          await buffer.prepare(deck, { mode, checkpoint, onProgress: progress => {
            if (!abort.signal.aborted && launchAbort.current === abort) setPreload({ loaded: progress.loaded, total: progress.total, status: 'loading' });
          } });
          if (!abort.signal.aborted && launchAbort.current === abort) setPreload(previous => previous && { ...previous, status: 'ready' });
        } catch (error) {
          if (!abort.signal.aborted && launchAbort.current === abort) setPreload(previous => ({ loaded: previous?.loaded ?? 0, total: previous?.total ?? deck.length, status: 'error' }));
          throw error;
        }
      }, abort.signal);
      if (!next) return;
      setPreload(null);
      settlingRun.current = null;
      lastEvent.current = next.eventId; spokenCheckpoint.current = -1; heardCheckpoint.current = -1; lastTime.current = performance.now();
      // A saved ride can retain yesterday's surfer. Wait for its artwork before resuming.
      const mustPause = document.hidden || !document.hasFocus() || loadedMonster.current !== next.monster;
      apply(mustPause ? pauseSurf(next) : next);
      requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
    } finally { starting.current = false; if (launchAbort.current === abort) launchAbort.current = null; }
  }, [apply]);
  const cancelPreparation = () => {
    launchAbort.current?.abort(); recordings.current?.abort(); pendingStart.current = false; setPreload(null);
  };
  const begin = () => {
    if (!['ready', 'over'].includes(state.current.phase)) return;
    const current = sessionRef.current;
    if (starting.current || current.busy || (!current.practice && (current.status !== 'ready'
      || (state.current.phase === 'over' && !current.result)))) return;
    stopSpeech(); audio.current?.unlock();
    const today = getDailySurfMonster();
    if (today !== state.current.monster) {
      pendingStart.current = true;
      setAssets('loading');
      apply(createSurfState(today));
      return;
    }
    if (assets !== 'ready' || loadedMonster.current !== today) {
      pendingStart.current = true;
      if (assets === 'error') setAssetAttempt(attempt => attempt + 1);
      return;
    }
    void startLoadedRun(today);
  };
  const pause = () => {
    apply(pauseSurf(state.current)); stopSpeech(); audio.current?.stopEffects();
  };
  const resume = () => {
    if (assets !== 'ready' || (!sessionRef.current.practice && (sessionRef.current.status !== 'ready'
      || sessionRef.current.errorCode?.includes('storage')))) return;
    lastTime.current = performance.now(); audio.current?.unlock();
    const next = resumeSurf(state.current); apply(next);
    if (canListen(next.phase)) { playPrompt(); focusInput(); }
  };
  controls.current = { begin, pause, resume, replay: () => playPrompt() };

  const rebuildRenderer = useCallback(() => {
    if (!canvas.current || !sceneImages.current) return;
    const { sprites, islands, gulls } = sceneImages.current;
    renderer.current?.destroy();
    renderer.current = createSurfRenderer(canvas.current, sprites, islands, gulls, seaMonsterImage.current);
    renderer.current.render(state.current, settings.current.reduced);
  }, []);

  useEffect(() => {
    let disposed = false;
    setSeaArtwork('loading');
    // The chase is preloaded independently so the daily rider can start immediately.
    void loadSurfImage('/monster-surf/inkfin-atlas-v6.png').then(image => {
      if (disposed) return;
      seaMonsterImage.current = image;
      setSeaArtwork('ready');
      rebuildRenderer();
    }).catch(() => { if (!disposed) setSeaArtwork('error'); });
    return () => { disposed = true; };
  }, [seaArtworkAttempt, rebuildRenderer]);

  useEffect(() => {
    let disposed = false;
    const monsterId = view.monster;
    setAssets('loading');
    // Load one weekday rider; shared scenery and previously seen days reuse decoded images.
    void Promise.all([
      loadSurfImage(`/monster-surf/characters/M${monsterId}-surf.png`),
      loadSurfImage('/monster-surf/islands-native-v4.png'),
      loadSurfImage('/monster-surf/gulls-atlas.png'),
    ]).then(([rider, islands, gulls]) => {
      if (disposed || !canvas.current) return;
      const sprites = new Array<HTMLImageElement>(7);
      sprites[monsterId] = rider;
      sceneImages.current = { sprites, islands, gulls };
      rebuildRenderer();
      loadedMonster.current = monsterId;
      setAssets('ready');
      if (pendingStart.current && ['ready', 'over'].includes(state.current.phase)) {
        const today = getDailySurfMonster();
        if (today === monsterId) void startLoadedRun(today);
        else { setAssets('loading'); apply(createSurfState(today)); }
      }
    }).catch(() => { if (!disposed) setAssets('error'); });
    return () => {
      disposed = true;
      loadedMonster.current = null; sceneImages.current = null;
      renderer.current?.destroy(); renderer.current = null;
    };
  }, [view.monster, assetAttempt, apply, startLoadedRun, rebuildRenderer]);

  useEffect(() => {
    const buffer = new SurfRecordingBuffer({ resolveSources: getRecordedPronunciationUrls, onSourceReady: rememberRecordedPronunciation });
    recordings.current = buffer;
    const player = new SurfAudio({ resolvePreparedSource: (word, url) => buffer.ensure(word, url) }); audio.current = player;
    let frame = 0; let live = true; let publishedAt = 0;
    const loop = () => {
      if (!live) return;
      const now = performance.now();
      player.effectsEnabled = settings.current.sound;
      if (lastTime.current !== null) {
        const before = state.current;
        // A recording that has not started must not cost the player distance,
        // answer time, or injuries while they cannot hear the question.
        const waitingForRecording = before.phase === 'surfing' && heardCheckpoint.current !== before.checkpoint;
        const next = waitingForRecording ? before : tickSurf(before, now - lastTime.current);
        const important = next.phase !== before.phase || next.eventId !== before.eventId || next.chase.phase !== before.chase.phase;
        apply(next, important || now - publishedAt >= 80);
        if (important || now - publishedAt >= 80) publishedAt = now;
      }
      lastTime.current = now;
      renderer.current?.render(state.current, settings.current.reduced);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    const blur = () => {
      if (!['ready', 'paused', 'over'].includes(state.current.phase)) controls.current.pause();
    };
    const visibility = () => { if (document.hidden) blur(); };
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || composing.current) return;
      const phase = state.current.phase;
      if (event.key === 'Escape' && !event.repeat) {
        if (phase === 'paused') { event.preventDefault(); controls.current.resume(); }
        else if (!['ready', 'over'].includes(phase)) { event.preventDefault(); controls.current.pause(); }
      } else if (event.key === 'Enter' && phase === 'paused' && !event.repeat) {
        event.preventDefault(); controls.current.resume();
      } else if (event.altKey && event.code === 'KeyR' && canListen(phase)) {
        event.preventDefault(); controls.current.replay();
      }
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('blur', blur); document.addEventListener('visibilitychange', visibility);
    return () => {
      live = false; launchAbort.current?.abort(); cancelAnimationFrame(frame); player.destroy(); buffer.dispose(); recordings.current = null; audio.current = null;
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility);
    };
  }, [apply]);

  useEffect(() => {
    if (view.phase === 'surfing') {
      recordings.current?.advance(view.checkpoint);
      focusInput();
      if (spokenCheckpoint.current !== view.checkpoint) {
        spokenCheckpoint.current = view.checkpoint;
        controls.current.replay();
      }
    }
    if (view.phase === 'paused') primary.current?.focus({ preventScroll: true });
    if (view.phase === 'over') reviewHeading.current?.focus({ preventScroll: true });
  }, [view.phase, view.checkpoint]);

  useEffect(() => {
    if (!session.practice && (session.status !== 'ready' || session.errorCode?.includes('storage'))
      && !['ready', 'paused', 'over'].includes(state.current.phase)) controls.current.pause();
  }, [session.practice, session.status, session.errorCode]);

  useEffect(() => {
    const previous = previousAccount.current;
    previousAccount.current = session.accountId;
    if (session.practice || previous === null || previous === session.accountId) return;
    pendingStart.current = false; settlingRun.current = null;
    launchAbort.current?.abort(); recordings.current?.abort(); setPreload(null);
    spokenCheckpoint.current = -1; speechRequest.current += 1;
    audio.current?.stopSpeech(); audio.current?.stopEffects(); setSpeech('idle');
    apply(createSurfState(getDailySurfMonster()));
  }, [session.accountId, session.practice, apply]);

  useEffect(() => {
    const recovered = session.recoveredState;
    const runId = session.recoveredRunId;
    if (!recovered || recovered.phase !== 'over' || !runId || session.status === 'loading' || shownRecoveredRuns.current.has(runId)) return;
    // A retried receipt belongs to its saved ride, never to a new ride in progress.
    shownRecoveredRuns.current.add(runId);
    if (state.current.phase !== 'ready' || starting.current) return;
    pendingStart.current = false; settlingRun.current = runId;
    lastEvent.current = recovered.eventId; spokenCheckpoint.current = -1;
    speechRequest.current += 1; lastTime.current = performance.now();
    audio.current?.stopSpeech(); audio.current?.stopEffects(); setSpeech('idle');
    apply(recovered);
  }, [session.recoveredState, session.recoveredRunId, session.status, apply]);

  useEffect(() => {
    if (view.phase !== 'over' || session.result || session.busy === 'settle') return;
    const key = session.run?.id ?? (session.practice ? `practice-${view.elapsedMs}` : null);
    if (!key || settlingRun.current === key) return;
    settlingRun.current = key;
    void sessionRef.current.settle(state.current);
  }, [view.phase, view.elapsedMs, session.run?.id, session.practice, session.result, session.busy]);

  const monster = SURF_MONSTERS[view.monster] ?? SURF_MONSTERS[1];
  const taskOpen = ['surfing', 'hurt', 'cleared'].includes(view.phase);
  const promptReady = heardCheckpoint.current === view.checkpoint;
  const word = currentSurfWord(view);
  const review = useMemo(() => buildSurfRunReview(view.deck, session.attempts, view.checkpoint), [view.deck, session.attempts, view.checkpoint]);
  const replayReviewWord = (reviewWord: SurfWord) => {
    const request = ++speechRequest.current;
    setSpeech('loading'); audio.current?.unlock();
    void audio.current?.speak(reviewWord.answer, false, reviewWord.audioUrl).then(ok => {
      if (request === speechRequest.current && state.current.phase === 'over') setSpeech(ok ? 'played' : 'error');
    });
  };
  const earnedSpeedMultiplier = surfSpeedMultiplier(view.correct);
  const recovering = view.phase === 'hurt' || (view.phase === 'paused' && view.resumePhase === 'hurt');
  const currentSpeedMultiplier = view.speed / SURF_BASE_SPEED * (recovering ? 0.25 : 1);
  const chase = view.chase;
  const chaseShown = chase.phase !== 'dormant';
  const chaseActive = chase.phase === 'warning' || chase.phase === 'chasing';
  const caughtBySeaMonster = chase.phase === 'attacking';
  const escapedSeaMonster = chase.phase === 'retreating' || chase.phase === 'escaped';
  const chaseTitle = caughtBySeaMonster ? t('海妖扑来了！', 'THE SEA MONSTER STRIKES!')
    : escapedSeaMonster ? t('成功甩开海妖！', 'YOU OUTRAN THE SEA MONSTER!')
    : chase.phase === 'warning' ? t('海怪来袭！', 'SEA MONSTER INCOMING!')
    : chase.mistakes === 2 ? t('海妖逼近，稳住拼写！', 'CLOSE BEHIND. KEEP YOUR FOCUS!')
    : t('海妖尾随中', 'SEA MONSTER ON YOUR TAIL');
  const chaseRule = caughtBySeaMonster ? t('第 3 次答错，海妖追上了你。', 'Third miss. The sea monster caught you.')
    : escapedSeaMonster ? t('连续答对 5 词，海妖放弃追逐。', 'Five in a row. The sea monster gives up.')
    : t('连对 5 词甩开它 · 答错会逼近，第 3 次攻击', '5 in a row to escape · Misses bring it closer. Third miss: attack.');
  const chaseAnnouncement = !chaseShown ? '' : `${chaseTitle} ${chaseRule} ${t(`甩开 ${chase.escapeStreak} / 5，逼近 ${chase.mistakes} / 3。`, `Escape streak ${chase.escapeStreak} of 5. Close calls ${chase.mistakes} of 3.`)}`;
  const magnetMultiplier = surfMagnetMultiplier(view.correct);
  const magnetLabel = magnetMultiplier >= 1e6 ? magnetMultiplier.toExponential(1) : magnetMultiplier < 1000 ? magnetMultiplier.toFixed(2) : new Intl.NumberFormat(isZh ? 'zh-CN' : 'en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(magnetMultiplier);
  const active = !['ready', 'paused', 'over'].includes(view.phase);
  const navigationLabel = view.navigation === 'guided'
    ? t('航向已修正 · 继续敲对字母以避障', 'COURSE SET · KEEP TYPING CORRECT LETTERS')
    : view.navigation === 'locked'
      ? t('航向保持 · 修正字母', 'HEADING HELD · FIX SPELLING')
      : t('每敲对一个字母，修正一次航向', 'EACH NEW CORRECT LETTER SETS YOUR COURSE');
  const submit = (event?: React.FormEvent) => {
    event?.preventDefault(); if (composing.current || heardCheckpoint.current !== state.current.checkpoint) return;
    const next = submitSurf(state.current);
    if (next !== state.current) {
      if (!sessionRef.current.recordAttempt(state.current, next)) {
        controls.current.pause();
        return;
      }
      if (next.phase !== 'surfing') stopSpeech();
      apply(next);
    }
    focusInput();
  };
  const trapFocus = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]'));
    const first = elements[0]; const last = elements[elements.length - 1];
    if (!first) return;
    if (event.shiftKey && (document.activeElement === first || !event.currentTarget.contains(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  };
  const resumable = !session.practice && session.run?.status === 'active' && !session.result;
  const summary = session.selection?.summary;
  const noWords = !session.practice && session.status === 'ready' && !resumable && !session.selection?.deck.length;
  const insufficient = !session.practice && !resumable && session.balance !== null && session.balance < 1;
  const canStart = assets === 'ready' && !session.busy && preload?.status !== 'loading' && (session.practice || session.status === 'ready') && !noWords && !insufficient;
  const canRestart = canStart && (session.practice || Boolean(session.result));
  const settlement = session.result?.run;
  const errorMessage = !session.errorCode ? '' : session.errorCode === 'insufficient_balance'
    ? t('余额不足，开启一局需要 1 金币。', 'You need 1 coin to enter a ride.')
    : preload?.status === 'error' ? '' : session.errorCode === 'learning_unavailable'
      ? t('部分单词记录暂不可用，本局记录已保留。请恢复词库后重试。', 'Some word records are unavailable. This ride is retained. Restore your vocabulary and retry.')
    : session.errorCode === 'not_authenticated' || session.errorCode === 'auth_changed'
      ? t('登录状态已变化，请重新登录后继续。', 'Your sign-in changed. Sign in again to continue.')
      : session.errorCode.includes('storage')
        ? t('本机未能保存进度，已暂停。请释放浏览器存储后重试。', 'Your progress could not be saved. Free up browser storage, then retry.')
        : session.errorCode === 'backend_unavailable'
          ? t('结算服务暂不可用，请稍后重试。', 'The settlement service is unavailable. Please retry shortly.')
          : t('连接暂时失败，进度已保留，请重试。', 'Connection interrupted. Your progress is retained. Please retry.');
  const endRide = () => {
    stopSpeech(); audio.current?.stopEffects();
    apply({ ...state.current, phase: 'over', resumePhase: null, phaseMs: 0, feedback: 'over' });
  };

  return <div className="ms-app" data-preload-status={preload?.status ?? "idle"} data-preload-loaded={preload?.loaded ?? 0} data-preload-total={preload?.total ?? 0} data-deck-size={view.deck.length} data-run-mode={session.run?.mode?.kind ?? (modeValue === 51 ? "endless" : "fixed")} data-session-status={session.status} data-practice={session.practice} data-wallet-balance={session.balance ?? undefined} data-audio-status={speech} data-audio-ready={promptReady} data-learning-sync={session.learningSyncing ? 'syncing' : session.learningPending ? 'pending' : 'synced'} data-settlement={session.result ? 'settled' : session.busy === 'settle' ? 'pending' : 'none'} data-crystals={view.coins} data-reduced-motion={reduced} data-phase={view.phase} data-assets={assets} data-monster={view.monster} data-character-source={`/monster-surf/characters/M${view.monster}-surf.png`} data-hits={view.hits} data-correct={view.correct} data-checkpoint={view.checkpoint} data-coins={view.coins} data-distance={Math.floor(view.distance)} data-x={view.x.toFixed(3)} data-vx={view.vx.toFixed(6)} data-elapsed-ms={view.elapsedMs.toFixed(3)} data-streak={view.streak} data-speed={earnedSpeedMultiplier.toFixed(2)} data-current-speed={currentSpeedMultiplier.toFixed(2)} data-magnet={magnetMultiplier.toFixed(4)} data-navigation={view.navigation} data-target-x={view.targetX?.toFixed(1)} data-invulnerable={Math.round(view.invulnerableMs)} data-chase-phase={chase.phase} data-chase-mistakes={chase.mistakes} data-chase-streak={chase.escapeStreak} data-chase-gap={chase.gap.toFixed(1)} data-chase-target-gap={chase.targetGap.toFixed(1)} data-chase-boost={Math.round(chase.boostMs)} data-chase-phase-ms={Math.round(chase.phaseMs)} data-chase-action={chase.action} data-sea-artwork={seaArtwork}>
    <header className="ms-site-header"><a className="ms-brand" href="/" aria-label="Vocab Monster"><img src="/monsterImages/home-logo.webp" alt="" width="44" height="44"/><span>VOCAB MONSTER</span></a><span className="ms-edition">{session.practice ? t('免费试玩', 'FREE PRACTICE') : t('听写冲浪', 'DICTATION SURF')}</span><div className="ms-site-actions">{!session.practice && session.balance !== null && <span className="ms-wallet" title={t('账户金币余额', 'Account coin balance')}><Icon name="coin" size={17}/><b>{session.balance}</b></span>}<button onClick={() => { toggleLanguage(); if (canListen(state.current.phase)) focusInput(); }}>{isZh ? 'EN' : '中文'}</button><a href="/">{t('返回网站', 'Back to site')} <Icon name="arrow" size={16}/></a></div></header>
    <main className="ms-main">
      <div className="ms-title-row"><div className="ms-title"><h1>{t('怪兽冲浪', 'MONSTER SURF')}</h1>{chaseShown ? <div className={`ms-chase-banner is-${chase.phase}`}><strong>{chaseTitle}</strong><span>{chaseRule}</span></div> : <span>{t('听写掌舵，乘风逐浪。', 'Your words. Your waves.')}</span>}</div><div className="ms-options">{seaArtwork === 'error' && <button className="ms-sea-art-retry" onClick={() => { setSeaArtworkAttempt(n => n + 1); if (canListen(view.phase)) focusInput(); }} title={t('海妖插画加载失败，当前显示简化形象。点击重试。', 'Sea monster artwork did not load. A simplified creature is shown. Click to retry.')}><Icon name="restart" size={15}/>{t('重载海妖', 'Retry creature art')}</button>}<button aria-pressed={sound} onClick={() => { const next = !sound; setSound(next); if (audio.current) { audio.current.effectsEnabled = next; if (next) audio.current.unlock(); } if (canListen(view.phase)) focusInput(); }}><Icon name="sound" size={17}/>{t(sound ? '音效开' : '音效关', sound ? 'SFX ON' : 'SFX OFF')}</button><button aria-pressed={reduced} onClick={() => { setReduced(!reduced); if (canListen(view.phase)) focusInput(); }}>{t('减少动态', 'Less motion')}</button></div></div>
      <span className="ms-sr-only" role="status" aria-live="polite" aria-atomic="true">{chaseAnnouncement}</span>
      <section className={`ms-ocean${view.phase === 'hurt' ? ' is-hurt' : ''}`} aria-label={t('怪兽冲浪海域', 'Monster surfing ocean')}>
        <canvas ref={canvas} tabIndex={-1} aria-label={t('自动冲浪画面，正确字母引导怪兽避障和收集海晶', 'Automatic surf course. Correct letters guide your monster around islands and toward Sea Crystals.')} onPointerDown={event => {
          if (canListen(state.current.phase)) { event.preventDefault(); focusInput(); }
        }}/>
        {view.phase !== 'ready' && <div className="ms-dashboard">
          <div className={`ms-navigation-hud${chaseShown ? ' has-chase' : ''}`} style={{ '--monster-color': monster.color } as React.CSSProperties}>
            <div className="ms-side-heading"><span>{t(`${monster.nameZh}伙伴`, `${monster.nameEn.toUpperCase()} SURFER`)}</span><Icon name="wave" size={22}/></div>
            <div className={`ms-speed${chase.boostMs > 0 ? ' is-boosted' : ''}`}><small>{chase.boostMs > 0 ? t('加速甩开！', 'ESCAPE BURST!') : t('冲浪速度', 'SURF SPEED')}</small><strong data-testid="surf-speed">{currentSpeedMultiplier.toFixed(2)}<i>×</i></strong></div>
            {chaseShown && <div className={`ms-chase-distance${escapedSeaMonster ? ' is-safe' : chase.mistakes >= 2 ? ' is-close' : ''}`}>
              <div><small>{escapedSeaMonster ? t('已脱离追逐', 'CHASE CLEARED') : t('海妖距离', 'CHASER DISTANCE')}</small><strong>{Math.round(chase.gap)} <span>m</span></strong></div>
              <div className="ms-chase-distance-track" aria-hidden="true"><span style={{ width: `${Math.max(2, Math.min(100, chase.gap / 650 * 100))}%` }}/></div>
            </div>}
            <div className="ms-abilities"><span title={t('海晶吸附半径', 'Sea Crystal pickup radius')}><Icon name="magnet" size={16}/><b>{magnetLabel}×</b></span><span title={t('海鸥伙伴', 'Seagull companions')}><Icon name="bird" size={18}/><b>{view.correct}</b></span></div>
          </div>
        {taskOpen && <div className={`ms-task-card${view.phase === 'cleared' ? ' is-correct' : ''}${view.phase === 'hurt' || view.navigation === 'locked' ? ' is-wrong' : ''}`}>
          <div className="ms-task-heading"><div><div className="ms-task-kicker"><span className="ms-kicker">{t(`听写 ${String(view.checkpoint + 1).padStart(2, '0')}`, `DICTATION ${String(view.checkpoint + 1).padStart(2, '0')}`)}</span>{view.streak >= 2 && <span className="ms-combo" data-testid="surf-combo">{t('连对', 'COMBO')} ×{view.streak}</span>}</div><h2 id="ms-word-meaning" className="ms-word-meaning" lang="zh-CN" title={word.meaningZh}>{word.meaningZh}</h2></div><div className="ms-audio-row"><button className="ms-listen" onClick={() => playPrompt()} title={t('重听单词（Alt + R）', 'Replay word (Alt + R)')}><Icon name="sound" size={18}/>{speech === 'loading' ? t('播放中…', 'Playing…') : t('重听', 'Replay')}</button><button className="ms-slow" onClick={() => playPrompt(true)}>{t('慢速', 'Slow')}</button></div></div>
          <form onSubmit={submit}>
            <label className="ms-sr-only" htmlFor="ms-answer">{t('听写单词', 'Spell the word')}</label>
            <LargeWordInput
              variant="embedded"
              inputRef={input}
              id="ms-answer"
              value={view.input}
              onChange={value => apply(setSurfInput(state.current, value))}
              onEnter={() => submit()}
              onCompositionStart={() => { composing.current = true; }}
              onCompositionEnd={() => { composing.current = false; }}
              disabled={view.phase !== 'surfing' || !promptReady}
              autoFocus={false}
              manageFocus={false}
              showWordBlocks
              targetWord={word.answer}
              status={view.phase === 'cleared' ? 'correct' : view.navigation === 'locked' ? 'wrong' : 'idle'}
              placeholder={t('输入听到的单词', 'Type the word you hear')}
              ariaInvalid={view.navigation === 'locked' || view.feedback === 'wrong'}
              ariaDescribedBy="ms-word-meaning ms-answer-feedback"
            />
            <button className="ms-primary" type="submit" disabled={view.phase !== 'surfing' || !promptReady}>{t('确认', 'CHECK')} <span>↵</span></button>
          </form>
          <div className="ms-task-footer"><p id="ms-answer-feedback" className="ms-answer-feedback" role="status">{view.phase === 'cleared' ? chase.escapeStreak > 0 && (chaseActive || chase.phase === 'retreating') ? t(`加速甩开 · 连对 ${chase.escapeStreak} / 5 · 半径 ×1.5`, `Escape burst · Streak ${chase.escapeStreak} / 5 · Radius ×1.5`) : t('海晶吸附半径 ×1.5 · 海鸥 +1 · 速度提升', 'Radius ×1.5 · Seagull +1 · Speed up') : speech === 'error' ? t('词库录音加载失败，请点击重听；尚未听到本词时，航程会等待。', 'Recording unavailable. Click Replay; the ride waits until this word is heard.') : !promptReady ? t('正在加载词库录音，航程暂时等待…', 'Loading the project recording. Your ride is waiting…') : view.feedback === 'collision' ? t(`撞到岛屿 · 受伤 ${view.hits} / 3 · 新敲对字母修正航向`, `Island collision · Injuries ${view.hits} / 3 · Type a correct letter to steer`) : view.phase === 'hurt' || view.feedback === 'wrong' ? chaseActive ? t(`海妖逼近 ${chase.mistakes} / 3 · 连对已重置，修正拼写`, `Close call ${chase.mistakes} / 3 · Streak reset. Fix your spelling.`) : t(`受伤 ${view.hits} / 3 · 修正拼写，继续冲浪`, `Injuries ${view.hits} / 3 · Fix your spelling and ride on`) : view.feedback === 'empty' ? t('先输入听到的单词。', 'Type the word you heard first.') : navigationLabel}</p><span className={`ms-course-status is-${view.navigation}`} aria-hidden="true"><span/>{view.navigation === 'guided' ? t('航向已修正', 'COURSE SET') : view.navigation === 'locked' ? t('保持航向', 'HEADING HELD') : t('听写掌舵', 'TYPE TO STEER')}</span></div>
        </div>}
          <div className={`ms-stat-group${chaseShown ? ' has-chase' : ''}`}>
            <div className="ms-stat-top"><div className="ms-stat ms-crystals"><small>{t('本局海晶', 'SEA CRYSTALS')}</small><strong><Icon name="crystal" size={22}/><span data-testid="surf-coins">{view.coins}</span></strong></div><button className="ms-pause" onClick={pause} disabled={!active} aria-label={t('暂停', 'Pause')}><Icon name="pause" size={20}/></button></div>
            {chaseShown && <div className="ms-chase-progress">
              <div><span>{t('甩开连对', 'ESCAPE STREAK')}</span><div className="ms-chase-steps" role="img" aria-label={t(`连续答对 ${chase.escapeStreak} / 5`, `${chase.escapeStreak} of 5 consecutive words`)}>{Array.from({ length: SURF_CHASE_ESCAPE_WORDS }, (_, i) => <i key={i} className={i < chase.escapeStreak ? 'is-complete' : ''}/>)}</div></div>
              <div><span>{t('海妖逼近', 'CLOSE CALLS')}</span><div className="ms-chase-misses" role="img" aria-label={t(`答错 ${chase.mistakes} / 3`, `${chase.mistakes} of 3 misses`)}>{Array.from({ length: SURF_CHASE_MAX_MISTAKES }, (_, i) => <i key={i} className={i < chase.mistakes ? 'is-filled' : ''}/>)}</div></div>
            </div>}
            <div className="ms-health" aria-label={t(`受伤 ${view.hits} / 3 次`, `${view.hits} of 3 injuries`)}><small>{t('剩余生命', 'LIVES LEFT')}</small><div>{Array.from({ length: SURF_MAX_HITS }, (_, i) => <span key={i} className={i < SURF_MAX_HITS - view.hits ? '' : 'is-lost'}><Icon name="heart" size={20}/></span>)}</div></div>
          </div>
        </div>}
        {view.phase === 'ready' && <div className="ms-start-card">
          <span className="ms-kicker">{t(`今日伙伴 · ${monster.nameZh}`, `TODAY’S SURFER · ${monster.nameEn.toUpperCase()}`)}</span>
          <h2>{t('一起', 'CATCH THE')} <em>{t('乘风逐浪！', 'NEXT WAVE.')}</em></h2>

          {session.practice ? <div className="ms-practice-note"><strong>{t('免费试玩 · 24 个固定示例词', 'FREE PRACTICE · 24 SAMPLE WORDS')}</strong><span>{t('使用项目统一录音；示例词不取自个人词库，不改变学习进度。', 'Project recordings. Sample words are separate from your vocabulary; no learning changes or coin charges.')}</span></div> : <div className="ms-economy-rules" aria-label={t('奖励规则', 'Reward rules')}>
            <div><Icon name="coin" size={18}/><strong>{t('1 金币', '1 COIN')}</strong><span>{t('每局入场费', 'ENTRY PER RIDE')}</span></div>
            <div><Icon name="crystal" size={18}/><strong>{t('10 海晶', '10 CRYSTALS')}</strong><span>{t('结束时兑换 1 金币', 'CONVERT TO 1 COIN')}</span></div>
            <div><Icon name="wave" size={18}/><strong>{t('每对 1 词', 'EACH CORRECT WORD')}</strong><span>{t('最多兑换 1 金币', 'UNLOCKS UP TO 1 COIN')}</span></div>
          </div>}
          {!session.practice && <div className="ms-selection-info">
            <div><strong>{t('遗忘曲线选词', 'SPACED REVIEW')}</strong><span>{resumable ? t('继续已付费航程', 'RESUME YOUR PAID RIDE') : t('到期优先 · 非随机', 'DUE FIRST · NO RANDOM PICKS')}</span></div>
            <p>{resumable ? t(`已保留 ${session.run!.words.length} 个词，本次继续不再扣费。`, `${session.run!.words.length} saved words. Resume without another entry fee.`) : summary ? t('重学与到期词优先，再补新词和未到期词。', 'Relearning and due words first, then new and upcoming words.') : session.status === 'loading' ? t('正在读取账户和复习队列…', 'Loading your account and review queue…') : t('登录后使用你的个人词库。', 'Sign in to use your personal vocabulary.')}</p>
          </div>}
          <SurfLaunchOptions isZh={isZh} value={resumable && session.run?.mode ? (session.run.mode.kind === 'endless' ? 51 : session.run.mode.wordCount) : modeValue}
            onChange={value => { setModeValue(value); setPreload(null); }}
            savedWordCount={resumable && !session.run?.mode ? session.run!.words.length : undefined}
            availableCount={resumable ? session.run!.words.length : session.practice ? SURF_WORDS.length : summary?.candidateCount ?? 0}
            disabled={Boolean(session.busy) || resumable || (!session.practice && session.status !== 'ready')}
            progress={preload} onRetry={begin} onCancel={cancelPreparation}/>
          {!preload && <div className="ms-rules"><span><Icon name="magnet" size={17}/>{t('答对：海晶吸附半径 ×1.5，海鸥 +1', 'Correct: crystal radius ×1.5 + one seagull')}</span><span><Icon name="heart" size={17}/>{t('答错或撞岛受伤，3 次落海', 'Wrong answers or collisions hurt. Three injuries end the ride.')}</span><span className="ms-chase-intro"><Icon name="wave" size={17}/>{t(`${SURF_CHASE_TRIGGER} 词后海妖来袭：连对 5 词甩开，错 3 次失败`, `After ${SURF_CHASE_TRIGGER} words: escape the chaser with 5 correct in a row. Three misses end the ride.`)}</span></div>}
          {noWords && <p className="ms-session-message" role="status">{t('还没有可听写的英文词。请先添加带中文释义的单词。', 'No playable English words yet. Add words with Chinese meanings first.')}</p>}
          {insufficient && <p className="ms-session-message" role="status">{t('余额不足 1 金币，可先免费试玩。', 'You need 1 coin to enter. Free practice is available below.')}</p>}
          {errorMessage && <p className="ms-session-message is-error" role="alert">{errorMessage}</p>}
          {session.status === 'anonymous' && !session.practice ? <a className="ms-primary" href="/">{t('返回网站登录', 'SIGN IN ON THE WEBSITE')}<Icon name="arrow"/></a> : session.status === 'error' && !session.practice ? <button className="ms-primary" ref={primary} onClick={() => void session.refresh()} disabled={Boolean(session.busy)}>{t('重新连接', 'RECONNECT')}<Icon name="restart"/></button> : <button className="ms-primary" ref={primary} onClick={assets === 'error' ? () => setAssetAttempt(n => n + 1) : begin} disabled={assets !== 'error' && !canStart}>{session.busy === 'start' ? preload?.status === 'loading' ? t('录音准备中…', 'PREPARING RECORDINGS…') : t('正在开启航程…', 'STARTING YOUR RIDE…') : assets === 'loading' ? t('今日伙伴准备中…', 'YOUR SURFER IS GETTING READY…') : assets === 'error' ? t('重新加载', 'RELOAD') : session.status === 'loading' && !session.practice ? t('读取账户中…', 'LOADING YOUR ACCOUNT…') : resumable ? t('继续航程 · 无需再付费', 'RESUME · NO EXTRA FEE') : session.practice ? t('免费试玩', 'TRY A FREE RIDE') : t('花 1 金币，开始冲浪', 'START RIDE · 1 COIN')}<Icon name="arrow"/></button>}
          <div className="ms-start-links"><span>{t('自动转向 · Enter 确认', 'AUTO STEERING · ENTER TO CHECK')}</span><a href={session.practice ? '/monster-run.html' : '/monster-run.html?practice=1'}>{session.practice ? t('进入正式比赛', 'Play for rewards') : t('免费试玩', 'Free practice')}</a></div>
          {assets === 'error' && <p className="ms-session-message is-error" role="alert">{t('冲浪素材加载失败，请重试。', 'Surf artwork could not load. Please retry.')}</p>}
        </div>}
        {view.phase !== 'ready' && <div className="ms-distance">{Math.floor(view.distance)} <span>{t('米航程', 'm sailed')}</span></div>}
        {view.phase === 'sinking' && <div className="ms-sinking-note" role="status"><Icon name="wave" size={34}/><strong>{t('扑通！', 'SPLASH!')}</strong><span>{caughtBySeaMonster ? t('第 3 次答错，海妖追上了你。', 'Third miss. The sea monster caught you.') : t('累计 3 次受伤，落海了。', 'Three injuries. Overboard!')}</span></div>}
        {view.phase === 'paused' && <div className="ms-modal-scrim"><div className="ms-modal" role="dialog" aria-modal="true" aria-labelledby="ms-paused" onKeyDown={trapFocus}><Icon name="pause" size={30}/><h2 id="ms-paused">{t('歇会儿，再乘浪。', 'TAKE A BREATHER.')}</h2><p>{t('航程、任务与生命都已保留。', 'Your course, task and lives are right here.')}</p>{errorMessage && <p className="ms-session-message is-error" role="alert">{errorMessage}</p>}{!session.practice && session.status === 'anonymous' ? <a className="ms-primary" href="/">{t('返回网站登录', 'SIGN IN ON THE WEBSITE')}<Icon name="arrow"/></a> : !session.practice && (session.status !== 'ready' || session.errorCode?.includes('storage')) ? <button className="ms-primary" ref={primary} onClick={() => void session.refresh()} disabled={Boolean(session.busy)}>{t('重新连接', 'RECONNECT')}<Icon name="restart" size={18}/></button> : <button className="ms-primary" ref={primary} onClick={resume} disabled={assets !== 'ready'}>{t('继续冲浪', 'KEEP SURFING')}<Icon name="play" size={18}/></button>}<button className="ms-secondary" onClick={endRide} disabled={!session.practice && session.status !== 'ready'}>{session.practice ? t('结束试玩', 'End practice') : t('结束航程并结算', 'End ride & settle')}</button><small>{t('Enter 或 Esc 继续', 'Enter or Esc to resume')}</small></div></div>}
        {view.phase === 'over' && <div className="ms-modal-scrim"><div className="ms-modal ms-result ms-review-result" role="region" aria-labelledby="ms-over">
          <div className="ms-review-result-heading"><span className="ms-kicker">{caughtBySeaMonster ? t('被海妖追上了', 'CAUGHT BY THE SEA MONSTER') : view.endReason === 'completed' ? t('本局词库全部完成', 'WORD DECK COMPLETE') : t('这趟航程，结束啦', 'THAT’S A WRAP')}</span><h2 id="ms-over" ref={reviewHeading} tabIndex={-1}>{t('航程收获 · 单词复盘', 'YOUR RIDE · WORD REVIEW')}</h2></div>
          {session.practice ? <div className="ms-practice-note ms-settlement-banner"><strong>{t('免费试玩 · 不结算金币', 'FREE PRACTICE · NO COIN REWARDS')}</strong><span>{t('正式比赛使用你的词库与遗忘曲线。', 'Reward rides use your vocabulary and spaced review queue.')}</span></div> : settlement ? <div className="ms-settlement ms-settlement-banner" data-testid="surf-settlement" role="status">
            <div className="ms-settlement-award"><Icon name="coin" size={30}/><div><span>{settlement.rewardCoins > 0 ? t('金币已到账', 'COINS ADDED TO YOUR WALLET') : t('本局结算完成', 'RIDE SETTLED')}</span><strong>+{settlement.rewardCoins}<small>{t('金币', 'COINS')}</small></strong></div></div>
            <div className="ms-settlement-breakdown"><div><span>{t('本局入场费', 'ENTRY FEE')}</span><b>−{settlement.entryFee}</b></div><div className="ms-net"><span>{t('本局净收益', 'NET CHANGE')}</span><b>{settlement.netCoins > 0 ? '+' : ''}{settlement.netCoins}</b></div></div>
            <div className="ms-settlement-balance"><span>{t('账户金币余额', 'WALLET BALANCE')}</span><strong>{session.result!.balance}</strong></div>
          </div> : <div className="ms-settlement-pending ms-settlement-banner" role="status"><strong>{session.busy === 'settle' ? t('正在结算…', 'SETTLING YOUR RIDE…') : t('等待结算', 'SETTLEMENT PENDING')}</strong><p>{t(`预计兑换 ${estimateMonsterSurfReward(view.correct, view.coins)} 金币，确认到账后才能开始下一局。`, `Estimated reward: ${estimateMonsterSurfReward(view.correct, view.coins)} coins. Confirm settlement before your next ride.`)}</p>{errorMessage && <p className="ms-session-message is-error" role="alert">{errorMessage}</p>}{session.busy !== 'settle' && <button className="ms-secondary" onClick={() => void (session.status !== 'ready' || !session.run ? session.refresh() : session.settle(state.current))}>{t('重试结算', 'Retry settlement')}</button>}</div>}
          <div className="ms-review-result-body"><aside className="ms-review-ride-summary" aria-label={t('航程结算', 'Ride settlement')}>
            <div className="ms-result-stats"><div><strong>{Math.floor(view.distance)}</strong><span>{t('米', 'METRES')}</span></div><div className="ms-crystals"><strong>{view.coins}</strong><span>{t('海晶', 'SEA CRYSTALS')}</span></div><div><strong>{view.correct}</strong><span>{t('答对', 'WORDS')}</span></div><div><strong>{view.bestStreak}</strong><span>{t('最高连对', 'BEST STREAK')}</span></div></div>


            {!session.practice && <div className="ms-review-sync" role="status">
              <strong>{session.learningSyncing ? t('正在同步学习记录…', 'Syncing learning progress…') : session.learningPending ? t('学习记录已保存在本机，等待同步', 'Learning saved on this device; sync pending') : review.attemptedCount ? t('学习记录已同步', 'Learning progress synced') : t('本局未作答，学习记录未改变', 'No submissions; learning progress unchanged')}</strong>
              <p>{t('答错会计入错误次数并安排复习；改正后答对仍保留错词记录。', 'Wrong submissions count toward your mistakes and review schedule. Corrected words retain their mistake history.')}</p>
              {session.learningPending && !session.learningSyncing && <button className="ms-secondary" onClick={session.retryLearning}>{t('重试同步', 'Retry sync')}</button>}
            </div>}
            {speech === 'error' && <p className="ms-session-message is-error" role="status">{t('语音暂不可用，请再次点击重听。', 'Audio is unavailable. Try the listen button again.')}</p>}
            {(settlement || session.practice) && errorMessage && <p className="ms-session-message is-error" role="alert">{errorMessage}</p>}
            <p className="ms-result-cause">{caughtBySeaMonster ? t('追逐中累计答错 3 次，海妖发动了攻击。', 'Three misses during the chase brought the sea monster close enough to strike.') : view.endReason === 'completed' ? t('本局单词已全部完成，不重复刷词。', 'Every word in this ride is complete. Words never loop for extra rewards.') : view.endReason === 'injuries' ? t('累计受伤 3 次，这趟冲浪结束了。', 'Three injuries ended this ride.') : t('你已结束本次航程。', 'You ended this ride.')}</p>
          </aside><SurfRunReview review={review} isZh={isZh} onReplay={replayReviewWord}/></div>
          <div className="ms-review-result-actions"><button className="ms-primary" ref={primary} onClick={() => { stopSpeech(); setPreload(null); apply(createSurfState(getDailySurfMonster())); }} disabled={!canRestart}><Icon name="restart" size={18}/>{session.practice ? t('再试玩一次', 'TRY ANOTHER RIDE') : session.busy === 'start' ? t('正在开启…', 'STARTING…') : t('选择下一局', 'SET UP NEXT RIDE')}</button><button className="ms-return-intro" disabled={!session.practice && !session.result} onClick={() => { pendingStart.current = false; stopSpeech(); apply(createSurfState(getDailySurfMonster())); }}>{t('返回介绍', 'Back to introduction')}</button></div>
        </div></div>}

      </section>
    </main>
    <footer className="ms-footer"><span>VOCAB MONSTER</span><span>{session.practice ? t('免费试玩 · 不扣费、不奖励、不写入学习进度', 'FREE PRACTICE · NO FEES, REWARDS OR LEARNING CHANGES') : t('10 海晶兑换 1 金币 · 每答对 1 词最多兑换 1 金币', '10 CRYSTALS = 1 COIN · UP TO 1 COIN PER CORRECT WORD')}</span><span>{t('Esc 暂停', 'Esc to pause')}</span></footer>
  </div>;
}
