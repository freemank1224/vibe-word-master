import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import { LargeWordInput } from '../../components/LargeWordInput';
import { createSurfState, currentSurfWord, pauseSurf, resumeSurf, setSurfInput, startSurf, submitSurf, tickSurf } from './game';
import { SURF_BASE_SPEED, SURF_MAX_HITS, SURF_CHASE_TRIGGER, SURF_CHASE_ESCAPE_WORDS, SURF_CHASE_MAX_MISTAKES, surfMagnetMultiplier, surfSpeedMultiplier } from './constants';
import { SURF_MONSTERS } from './monsters';
import { createSurfRenderer } from './renderer';
import { SurfAudio } from './audio';
import { getDailySurfMonster, millisecondsUntilNextSurfDay, refreshDailySurfMonster } from './dailyMonster';
import type { SurfRenderer, SurfState } from './types';

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

function Icon({ name, size = 20 }: { name: 'coin' | 'heart' | 'sound' | 'pause' | 'play' | 'wave' | 'arrow' | 'magnet' | 'restart' | 'bird'; size?: number }) {
  const paths = {
    coin: <><circle cx="12" cy="12" r="9"/><path d="m12 6 4 6-4 6-4-6z"/></>,
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
  const [view, setView] = useState(() => createSurfState(getDailySurfMonster()));
  const state = useRef(view);
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const renderer = useRef<SurfRenderer | null>(null);
  const audio = useRef<SurfAudio | null>(null);
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
  const composing = useRef(false);
  const controls = useRef({ begin: () => {}, pause: () => {}, resume: () => {}, replay: () => {} });

  const apply = useCallback((next: SurfState, publish = true) => {
    const gainedCoins = Math.max(0, next.coins - state.current.coins);
    state.current = next;
    if (next.event && next.event.id !== lastEvent.current) {
      lastEvent.current = next.event.id;
      audio.current?.play(next.event.kind, gainedCoins || next.event.count || 1);
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
    void audio.current?.speak(currentSurfWord(state.current).answer, slow).then(ok => {
      if (request === speechRequest.current && canListen(state.current.phase)) setSpeech(ok ? 'played' : 'error');
    });
    focusInput();
  };
  const startLoadedRun = useCallback((monsterId: number) => {
    pendingStart.current = false;
    lastEvent.current = 0; spokenCheckpoint.current = -1; lastTime.current = performance.now();
    const next = startSurf(monsterId);
    apply(document.hidden || !document.hasFocus() ? pauseSurf(next) : next);
    requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
  }, [apply]);
  const begin = () => {
    if (!['ready', 'over'].includes(state.current.phase)) return;
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
    startLoadedRun(today);
  };
  const pause = () => {
    apply(pauseSurf(state.current)); stopSpeech(); audio.current?.stopEffects();
  };
  const resume = () => {
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
        if (today === monsterId) startLoadedRun(today);
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
    const player = new SurfAudio(); audio.current = player;
    let frame = 0; let live = true; let publishedAt = 0;
    const loop = () => {
      if (!live) return;
      const now = performance.now();
      player.effectsEnabled = settings.current.sound;
      if (lastTime.current !== null) {
        const before = state.current;
        const next = tickSurf(before, now - lastTime.current);
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
      live = false; cancelAnimationFrame(frame); player.destroy(); audio.current = null;
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility);
    };
  }, [apply]);

  useEffect(() => {
    if (view.phase === 'surfing') {
      focusInput();
      if (spokenCheckpoint.current !== view.checkpoint) {
        spokenCheckpoint.current = view.checkpoint;
        controls.current.replay();
      }
    }
    if (view.phase === 'paused' || view.phase === 'over') primary.current?.focus({ preventScroll: true });
  }, [view.phase, view.checkpoint]);

  const monster = SURF_MONSTERS[view.monster] ?? SURF_MONSTERS[1];
  const taskOpen = ['surfing', 'hurt', 'cleared'].includes(view.phase);
  const word = currentSurfWord(view);
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
  const magnetLabel = magnetMultiplier < 1000 ? magnetMultiplier.toFixed(2) : new Intl.NumberFormat(isZh ? 'zh-CN' : 'en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(magnetMultiplier);
  const active = !['ready', 'paused', 'over'].includes(view.phase);
  const navigationLabel = view.navigation === 'guided'
    ? t('自动避障 · 寻找金币', 'AVOIDING & COLLECTING')
    : view.navigation === 'locked'
      ? t('航向保持 · 修正字母', 'HEADING HELD · FIX SPELLING')
      : t('听词输入，字母指引航向', 'YOUR LETTERS STEER THE RIDE');
  const submit = (event?: React.FormEvent) => {
    event?.preventDefault(); if (composing.current) return;
    const next = submitSurf(state.current);
    if (next !== state.current) {
      if (next.phase !== 'surfing') stopSpeech();
      apply(next);
    }
    focusInput();
  };
  const trapFocus = (event: React.KeyboardEvent) => {
    if (event.key === 'Tab') { event.preventDefault(); primary.current?.focus(); }
  };

  return <div className="ms-app" data-reduced-motion={reduced} data-phase={view.phase} data-assets={assets} data-monster={view.monster} data-character-source={`/monster-surf/characters/M${view.monster}-surf.png`} data-hits={view.hits} data-correct={view.correct} data-checkpoint={view.checkpoint} data-coins={view.coins} data-distance={Math.floor(view.distance)} data-x={view.x.toFixed(1)} data-streak={view.streak} data-speed={earnedSpeedMultiplier.toFixed(2)} data-current-speed={currentSpeedMultiplier.toFixed(2)} data-magnet={magnetMultiplier.toFixed(4)} data-navigation={view.navigation} data-target-x={view.targetX?.toFixed(1)} data-invulnerable={Math.round(view.invulnerableMs)} data-chase-phase={chase.phase} data-chase-mistakes={chase.mistakes} data-chase-streak={chase.escapeStreak} data-chase-gap={chase.gap.toFixed(1)} data-chase-target-gap={chase.targetGap.toFixed(1)} data-chase-boost={Math.round(chase.boostMs)} data-chase-phase-ms={Math.round(chase.phaseMs)} data-chase-action={chase.action} data-sea-artwork={seaArtwork}>
    <header className="ms-site-header"><a className="ms-brand" href="/" aria-label="Vocab Monster"><img src="/monsterImages/home-logo.webp" alt="" width="44" height="44"/><span>VOCAB MONSTER</span></a><span className="ms-edition">{t('冲浪试玩', 'SURF PLAYTEST')}</span><div className="ms-site-actions"><button onClick={() => { toggleLanguage(); if (canListen(state.current.phase)) focusInput(); }}>{isZh ? 'EN' : '中文'}</button><a href="/">{t('返回网站', 'Back to site')} <Icon name="arrow" size={16}/></a></div></header>
    <main className="ms-main">
      <div className="ms-title-row"><div className="ms-title"><h1>{t('怪兽冲浪', 'MONSTER SURF')}</h1>{chaseShown ? <div className={`ms-chase-banner is-${chase.phase}`}><strong>{chaseTitle}</strong><span>{chaseRule}</span></div> : <span>{t('听写掌舵，乘风逐浪。', 'Your words. Your waves.')}</span>}</div><div className="ms-options">{seaArtwork === 'error' && <button className="ms-sea-art-retry" onClick={() => { setSeaArtworkAttempt(n => n + 1); if (canListen(view.phase)) focusInput(); }} title={t('海妖插画加载失败，当前显示简化形象。点击重试。', 'Sea monster artwork did not load. A simplified creature is shown. Click to retry.')}><Icon name="restart" size={15}/>{t('重载海妖', 'Retry creature art')}</button>}<button aria-pressed={sound} onClick={() => { const next = !sound; setSound(next); if (audio.current) { audio.current.effectsEnabled = next; if (next) audio.current.unlock(); } if (canListen(view.phase)) focusInput(); }}><Icon name="sound" size={17}/>{t(sound ? '音效开' : '音效关', sound ? 'SFX ON' : 'SFX OFF')}</button><button aria-pressed={reduced} onClick={() => { setReduced(!reduced); if (canListen(view.phase)) focusInput(); }}>{t('减少动态', 'Less motion')}</button></div></div>
      <span className="ms-sr-only" role="status" aria-live="polite" aria-atomic="true">{chaseAnnouncement}</span>
      <section className={`ms-ocean${view.phase === 'hurt' ? ' is-hurt' : ''}`} aria-label={t('怪兽冲浪海域', 'Monster surfing ocean')}>
        <canvas ref={canvas} tabIndex={-1} aria-label={t('自动冲浪画面，正确字母引导怪兽避障和收集金币', 'Automatic surf course. Correct letters guide your monster around islands and toward coins.')} onPointerDown={event => {
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
            <div className="ms-abilities"><span title={t('吸金币半径', 'Coin pickup radius')}><Icon name="magnet" size={16}/><b>{magnetLabel}×</b></span><span title={t('海鸥伙伴', 'Seagull companions')}><Icon name="bird" size={18}/><b>{view.correct}</b></span></div>
          </div>
        {taskOpen && <div className={`ms-task-card${view.phase === 'cleared' ? ' is-correct' : ''}${view.phase === 'hurt' || view.navigation === 'locked' ? ' is-wrong' : ''}`}>
          <div className="ms-task-heading"><div><div className="ms-task-kicker"><span className="ms-kicker">{t(`听写 ${String(view.checkpoint + 1).padStart(2, '0')}`, `DICTATION ${String(view.checkpoint + 1).padStart(2, '0')}`)}</span>{view.streak >= 2 && <span className="ms-combo" data-testid="surf-combo">{t('连对', 'COMBO')} ×{view.streak}</span>}</div><h2 id="ms-word-meaning" className="ms-word-meaning" lang="zh-CN">{word.meaningZh}</h2></div><div className="ms-audio-row"><button className="ms-listen" onClick={() => playPrompt()} title={t('重听单词（Alt + R）', 'Replay word (Alt + R)')}><Icon name="sound" size={18}/>{speech === 'loading' ? t('播放中…', 'Playing…') : t('重听', 'Replay')}</button><button className="ms-slow" onClick={() => playPrompt(true)}>{t('慢速', 'Slow')}</button></div></div>
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
              disabled={view.phase !== 'surfing'}
              autoFocus={false}
              manageFocus={false}
              showWordBlocks
              targetWord={word.answer}
              status={view.phase === 'cleared' ? 'correct' : view.navigation === 'locked' ? 'wrong' : 'idle'}
              placeholder={t('输入听到的单词', 'Type the word you hear')}
              ariaInvalid={view.navigation === 'locked' || view.feedback === 'wrong'}
              ariaDescribedBy="ms-word-meaning ms-answer-feedback"
            />
            <button className="ms-primary" type="submit" disabled={view.phase !== 'surfing'}>{t('确认', 'CHECK')} <span>↵</span></button>
          </form>
          <div className="ms-task-footer"><p id="ms-answer-feedback" className="ms-answer-feedback" role="status">{view.phase === 'cleared' ? chase.escapeStreak > 0 && (chaseActive || chase.phase === 'retreating') ? t(`加速甩开 · 连对 ${chase.escapeStreak} / 5 · 半径 ×1.5`, `Escape burst · Streak ${chase.escapeStreak} / 5 · Radius ×1.5`) : t('吸金币半径 ×1.5 · 海鸥 +1 · 速度提升', 'Radius ×1.5 · Seagull +1 · Speed up') : speech === 'error' ? t('语音播放失败，点击重听可重试。', 'Audio could not play. Click Replay to retry.') : view.feedback === 'collision' ? t(`撞到岛屿 · 受伤 ${view.hits} / 3 · 正确字母恢复引航`, `Island collision · Injuries ${view.hits} / 3 · Correct letters restore guidance`) : view.phase === 'hurt' || view.feedback === 'wrong' ? chaseActive ? t(`海妖逼近 ${chase.mistakes} / 3 · 连对已重置，修正拼写`, `Close call ${chase.mistakes} / 3 · Streak reset. Fix your spelling.`) : t(`受伤 ${view.hits} / 3 · 修正拼写，继续冲浪`, `Injuries ${view.hits} / 3 · Fix your spelling and ride on`) : view.feedback === 'empty' ? t('先输入听到的单词。', 'Type the word you heard first.') : navigationLabel}</p><span className={`ms-course-status is-${view.navigation}`} aria-hidden="true"><span/>{view.navigation === 'guided' ? t('引航中', 'GUIDED') : view.navigation === 'locked' ? t('保持航向', 'HEADING HELD') : t('听写掌舵', 'TYPE TO STEER')}</span></div>
        </div>}
          <div className={`ms-stat-group${chaseShown ? ' has-chase' : ''}`}>
            <div className="ms-stat-top"><div className="ms-stat ms-gold"><small>{t('本局金币', 'RUN COINS')}</small><strong><Icon name="coin" size={22}/><span data-testid="surf-coins">{view.coins}</span></strong></div><button className="ms-pause" onClick={pause} disabled={!active} aria-label={t('暂停', 'Pause')}><Icon name="pause" size={20}/></button></div>
            {chaseShown && <div className="ms-chase-progress">
              <div><span>{t('甩开连对', 'ESCAPE STREAK')}</span><div className="ms-chase-steps" role="img" aria-label={t(`连续答对 ${chase.escapeStreak} / 5`, `${chase.escapeStreak} of 5 consecutive words`)}>{Array.from({ length: SURF_CHASE_ESCAPE_WORDS }, (_, i) => <i key={i} className={i < chase.escapeStreak ? 'is-complete' : ''}/>)}</div></div>
              <div><span>{t('海妖逼近', 'CLOSE CALLS')}</span><div className="ms-chase-misses" role="img" aria-label={t(`答错 ${chase.mistakes} / 3`, `${chase.mistakes} of 3 misses`)}>{Array.from({ length: SURF_CHASE_MAX_MISTAKES }, (_, i) => <i key={i} className={i < chase.mistakes ? 'is-filled' : ''}/>)}</div></div>
            </div>}
            <div className="ms-health" aria-label={t(`受伤 ${view.hits} / 3 次`, `${view.hits} of 3 injuries`)}><small>{t('剩余生命', 'LIVES LEFT')}</small><div>{Array.from({ length: SURF_MAX_HITS }, (_, i) => <span key={i} className={i < SURF_MAX_HITS - view.hits ? '' : 'is-lost'}><Icon name="heart" size={20}/></span>)}</div></div>
          </div>
        </div>}
        {view.phase === 'ready' && <div className="ms-start-card">
          <span className="ms-kicker">{t(`今日伙伴 · ${monster.nameZh}`, `TODAY’S SURFER · ${monster.nameEn.toUpperCase()}`)}</span>
          <h2>{t('今天，一起', 'A NEW DAY.')}<br/><em>{t('乘风逐浪！', 'A NEW WAVE.')}</em></h2>
          <p>{t('每天和当日怪兽一起出海。听写字母指引航向，避开岛屿，追逐金币。', 'Your daily monster is ready to ride. Type what you hear to steer around islands and chase coins.')}</p>
          <div className="ms-rules"><span><Icon name="magnet" size={17}/>{t('答对：吸金币半径 ×1.5，再添一只海鸥', 'Correct: radius ×1.5 + one seagull')}</span><span><Icon name="heart" size={17}/>{t('普通航程：答错或撞岛受伤，3 次落海', 'Normal ride: wrong answers or collisions cause injuries. Three ends the run.')}</span><span className="ms-chase-intro"><Icon name="wave" size={17}/>{t(`答对 ${SURF_CHASE_TRIGGER} 词海妖来袭：连对 5 词甩开，答错 3 次被追上`, `After ${SURF_CHASE_TRIGGER} words: a sea monster follows. 5 in a row to escape; 3 misses and it strikes.`)}</span></div>
          <button className="ms-primary" ref={primary} onClick={assets === 'error' ? () => setAssetAttempt(n => n + 1) : begin} disabled={assets === 'loading'}>{assets === 'loading' ? t('今日伙伴准备中…', 'Your surfer is getting ready…') : assets === 'error' ? t('重新加载', 'Reload') : t('开始冲浪', 'LET’S SURF')}<Icon name="arrow"/></button>
          <small className="ms-start-hint">{t('无需手动转向 · 字母写错保持航向 · 每答对一词加速', 'No steering needed · Wrong letters hold your heading · Each correct word adds speed')}</small>
          {assets === 'error' && <p role="alert">{t('冲浪素材加载失败，请重试。', 'Surf artwork could not load. Please retry.')}</p>}
        </div>}
        {view.phase !== 'ready' && <div className="ms-distance">{Math.floor(view.distance)} <span>{t('米航程', 'm sailed')}</span></div>}
        {view.phase === 'sinking' && <div className="ms-sinking-note" role="status"><Icon name="wave" size={34}/><strong>{t('扑通！', 'SPLASH!')}</strong><span>{caughtBySeaMonster ? t('第 3 次答错，海妖追上了你。', 'Third miss. The sea monster caught you.') : t('累计 3 次受伤，落海了。', 'Three injuries. Overboard!')}</span></div>}
        {view.phase === 'paused' && <div className="ms-modal-scrim"><div className="ms-modal" role="dialog" aria-modal="true" aria-labelledby="ms-paused" onKeyDown={trapFocus}><Icon name="pause" size={30}/><h2 id="ms-paused">{t('歇会儿，再乘浪。', 'TAKE A BREATHER.')}</h2><p>{t('航程、任务与生命都已保留。', 'Your course, task and lives are right here.')}</p><button className="ms-primary" ref={primary} onClick={resume}>{t('继续冲浪', 'KEEP SURFING')}<Icon name="play" size={18}/></button><small>{t('Enter 或 Esc 继续', 'Enter or Esc to resume')}</small></div></div>}
        {view.phase === 'over' && <div className="ms-modal-scrim"><div className="ms-modal ms-result" role="region" aria-labelledby="ms-over"><span className="ms-kicker">{caughtBySeaMonster ? t('被海妖追上了', 'CAUGHT BY THE SEA MONSTER') : t('这趟航程，结束啦', 'THAT’S A WRAP')}</span><h2 id="ms-over">{t('下次再乘风破浪！', 'ONE MORE WAVE?')}</h2><div className="ms-result-stats"><div><strong>{Math.floor(view.distance)}</strong><span>{t('米', 'METRES')}</span></div><div><strong>{view.coins}</strong><span>{t('金币', 'COINS')}</span></div><div><strong>{view.correct}</strong><span>{t('答对', 'WORDS')}</span></div><div><strong>{view.bestStreak}</strong><span>{t('最高连对', 'BEST STREAK')}</span></div></div><p className="ms-result-cause">{caughtBySeaMonster ? t('追逐中累计答错 3 次，海妖发动了攻击。', 'Three misses during the chase brought the sea monster close enough to strike.') : t('累计受伤 3 次，这趟冲浪结束了。', 'Three injuries ended this ride.')}</p><p>{t('最后一词', 'Last word')}: <b>{word.answer}</b> · {isZh ? word.meaningZh : word.meaningEn}</p><button className="ms-primary" ref={primary} onClick={begin} disabled={assets === 'loading'}><Icon name="restart" size={18}/>{t('再冲一次', 'SURF AGAIN')}</button><button className="ms-return-intro" onClick={() => { pendingStart.current = false; stopSpeech(); apply(createSurfState(getDailySurfMonster())); }}>{t('返回介绍', 'Back to introduction')}</button></div></div>}
      </section>
    </main>
    <footer className="ms-footer"><span>VOCAB MONSTER</span><span>{t('冲浪试玩 · 金币仅计入本局', 'SURF PLAYTEST · COINS STAY IN THIS RUN')}</span><span>{t('Esc 暂停', 'Esc to pause')}</span></footer>
  </div>;
}
