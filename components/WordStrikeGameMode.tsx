import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { wordMeaningForLanguage } from '../utils/wordMeaningLocale';
import { HoverTranslationText } from './HoverTranslationText';
import { WordStrikeLeaderboardPanel } from './WordStrikeLeaderboardPanel';
import { InputSession, WordEntry, WordStrikeCardResult, WordStrikeGameSummary } from '../types';
import {
  WORD_STRIKE_BG_SRC,
  WORD_STRIKE_BLOCK_SRCS,
  WORD_STRIKE_LIVES,
  WORD_STRIKE_MIN_WORDS,
  WORD_STRIKE_SPAWN_CENTER_Y,
  applyWordStrikeScope,
  calculateWordStrikeGameSummary,
  getWordStrikeAimAngle,
  getWordStrikeBrickSpeed,
  getWordStrikeCandidateWords,
  getWordStrikeSpawnColumnX,
  getWordStrikeSpritePaths,
  getWordStrikeUnitSize,
  matchTypedWord,
  normalizeWordStrikeInput,
  selectWordStrikeWords,
  type WordStrikeScope,
} from '../services/wordStrike';
import {
  BulletContact,
  ELEVATOR,
  LOGICAL_WORLD,
  TURRET,
  UnitHandle,
  WordStrikePhysics,
  getGunPivotY,
} from '../utils/wordStrikePhysics';
import {
  WRONG_FLASH_MS,
  WordStrikeAimTarget,
  WordStrikeFloater,
  WordStrikeGhost,
  WordStrikeRenderer,
} from '../utils/wordStrikeRenderer';
import {
  playCheer,
  playExplosion,
  playGunshot,
  playMiss,
  playShatter,
} from '../utils/audioFeedback';
import { playWordPronunciation, preloadWordAudio, stopCurrentAudio } from '../services/pronunciationService';

interface WordStrikeGameModeProps {
  allWords: WordEntry[];
  sessions: InputSession[];
  onComplete: (summary: WordStrikeGameSummary) => Promise<void> | void;
  onCancel: () => void;
}

type WordStrikePhase =
  | 'INTRO'
  | 'PREPARING'
  | 'READY'
  | 'COUNTDOWN'
  | 'PLAYING'
  | 'REVIEW'
  | 'RESULT';

/** One shot in flight: its letter match applies the instant the bullet connects. */
interface PendingShot {
  match: ReturnType<typeof matchTypedWord>;
  typedLength: number;
  firedAt: number;
  applied: boolean;
}

const NEXT_BRICK_DELAY_MS = 950;
const SHOT_RESOLVE_TIMEOUT_MS = 900; // bullet flew past everything → apply anyway

// ----------------------------------------------------------------
// March-speed setting — 3 gears, persisted; 'fast' matches the original
// (tuned) curve, slower gears stretch time-to-think for casual drilling.
// ----------------------------------------------------------------
type StrikeSpeed = 'slow' | 'normal' | 'fast';
const SPEED_ORDER: StrikeSpeed[] = ['slow', 'normal', 'fast'];
// Halved twice from the original tuning — playtesting found even 'fast'
// too hot for comfortable typing. Ramp curve still scales on top.
const SPEED_FACTOR: Record<StrikeSpeed, number> = { slow: 0.175, normal: 0.3, fast: 0.5 };
const SPEED_LABELS: Record<StrikeSpeed, { en: string; zh: string }> = {
  slow: { en: 'SLOW', zh: '慢' },
  normal: { en: 'NORMAL', zh: '中' },
  fast: { en: 'FAST', zh: '快' },
};
const WORD_STRIKE_SPEED_KEY = 'vibe_word_strike_speed';

const loadStrikeSpeed = (): StrikeSpeed => {
  try {
    const raw = localStorage.getItem(WORD_STRIKE_SPEED_KEY);
    return raw === 'slow' || raw === 'fast' ? raw : 'normal';
  } catch {
    return 'normal';
  }
};

// ----------------------------------------------------------------
// Round composition — word count per round + sampling scope, both
// persisted; edited on the INTRO screen before "Load Strike Run".
// ----------------------------------------------------------------
const WORD_STRIKE_ROUND_SIZE_KEY = 'vibe_word_strike_round_size';
const WORD_STRIKE_SCOPE_KEY = 'vibe_word_strike_scope';
const ROUND_SIZE_MIN = 5;
const ROUND_SIZE_MAX = 20;

const loadStrikeRoundSize = (): number => {
  try {
    const parsed = parseInt(localStorage.getItem(WORD_STRIKE_ROUND_SIZE_KEY) || '', 10);
    return Number.isFinite(parsed) ? Math.min(ROUND_SIZE_MAX, Math.max(ROUND_SIZE_MIN, parsed)) : 10;
  } catch {
    return 10;
  }
};

const loadStrikeScope = (): WordStrikeScope => {
  try {
    const raw = localStorage.getItem(WORD_STRIKE_SCOPE_KEY);
    return raw === 'recent3' || raw === 'recent5' ? raw : 'all';
  } catch {
    return 'all';
  }
};

export const WordStrikeGameMode: React.FC<WordStrikeGameModeProps> = ({
  allWords,
  sessions,
  onComplete,
  onCancel,
}) => {
  // ----------------------------------------------------------------
  // React state — low-frequency HUD aggregates only
  // ----------------------------------------------------------------
  const { isZh } = useLanguage();
  const [phase, setPhase] = useState<WordStrikePhase>('INTRO');
  const [selectionMode, setSelectionMode] = useState<'smart' | 'random'>('random');
  const [selectionOverlapRate, setSelectionOverlapRate] = useState(0);
  const [rankingEligible, setRankingEligible] = useState(true);
  const [rankingIneligibleReason, setRankingIneligibleReason] = useState<string | null>(null);
  const [selectedWords, setSelectedWords] = useState<WordEntry[]>([]);
  const [audioProgress, setAudioProgress] = useState({ current: 0, total: 0 });
  const [selectionMessage, setSelectionMessage] = useState('');
  const [preparationError, setPreparationError] = useState<string | null>(null);
  const [countdownValue, setCountdownValue] = useState(3);
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [lives, setLives] = useState(WORD_STRIKE_LIVES);
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [currentWordIndex, setCurrentWordIndex] = useState(-1);
  /** Fully-shattered words — their cards collect in the right-side matrix. */
  const [collectedCards, setCollectedCards] = useState<WordEntry[]>([]);
  const [speed, setSpeed] = useState<StrikeSpeed>(loadStrikeSpeed);
  const [roundSize, setRoundSize] = useState<number>(loadStrikeRoundSize);
  const [scope, setScope] = useState<WordStrikeScope>(loadStrikeScope);
  const [result, setResult] = useState<WordStrikeGameSummary | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  /** One-shot feedback flash on the replay button after each trigger. */
  const [replayPulsing, setReplayPulsing] = useState(false);

  // Candidate availability per scope (for the scope picker + entry gate).
  const scopeCounts = useMemo(() => {
    const candidateCountFor = (s: WordStrikeScope) =>
      getWordStrikeCandidateWords(applyWordStrikeScope(allWords, sessions, s)).length;
    return {
      recent3: candidateCountFor('recent3'),
      recent5: candidateCountFor('recent5'),
      all: candidateCountFor('all'),
    } satisfies Record<WordStrikeScope, number>;
  }, [allWords, sessions]);
  const candidateCount = scopeCounts[scope];
  const canPrepare = candidateCount >= WORD_STRIKE_MIN_WORDS;

  const changeRoundSize = (size: number) => {
    const clamped = Math.min(ROUND_SIZE_MAX, Math.max(ROUND_SIZE_MIN, size));
    setRoundSize(clamped);
    try {
      localStorage.setItem(WORD_STRIKE_ROUND_SIZE_KEY, String(clamped));
    } catch {
      // private mode — session-only setting
    }
  };

  const changeScope = (next: WordStrikeScope) => {
    setScope(next);
    try {
      localStorage.setItem(WORD_STRIKE_SCOPE_KEY, next);
    } catch {
      // private mode — session-only setting
    }
  };

  // ----------------------------------------------------------------
  // Refs — 60fps game data, never in state (avoids per-frame re-renders)
  // ----------------------------------------------------------------
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const physicsRef = useRef<WordStrikePhysics | null>(null);
  const rendererRef = useRef<WordStrikeRenderer | null>(null);
  const rafRef = useRef<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  const pendingTimersRef = useRef<number[]>([]);

  const phaseRef = useRef<WordStrikePhase>('INTRO');
  const typedRef = useRef('');
  const speedRef = useRef<StrikeSpeed>(speed);
  const inputLockedRef = useRef(true);
  const livesRef = useRef(WORD_STRIKE_LIVES);
  const scoreRef = useRef(0);
  const comboRef = useRef(0);
  const maxComboRef = useRef(0);
  const lettersHitTotalRef = useRef(0);
  const lettersFiredTotalRef = useRef(0);
  const wordLettersHitRef = useRef(0);
  const wordLettersMissedRef = useRef(0);
  const attemptsRef = useRef(0);
  const brickIndexRef = useRef(0);
  const activeWordRef = useRef<WordEntry | null>(null);
  const brickActivatedAtRef = useRef<number | null>(null);
  const brickDeadRef = useRef(false);
  const pendingShotsRef = useRef<PendingShot[]>([]);
  /** Position → confirmed-correct letter, banked across attempts (drawn green
   *  on the tile). Reset per brick. */
  const revealedLettersRef = useRef<string[]>([]);
  /** Position → timestamp until which the tile flashes red (wrong input). */
  const wrongFlashRef = useRef<Record<number, number>>({});
  const ghostsRef = useRef<WordStrikeGhost[]>([]);
  const floatersRef = useRef<WordStrikeFloater[]>([]);
  const lastShotAtRef = useRef(0);
  const recoilRef = useRef(0);
  /** Live aim angle — written by the rAF tick, read by fire(). 0 = straight right. */
  const aimAngleRef = useRef(0);
  /** Elevator platform height (feet Y) — smoothed toward the live word. */
  const elevatorYRef = useRef(ELEVATOR.bottomFeetY);
  const gameStartTimeRef = useRef<number | null>(null);
  const finalizeGuardRef = useRef(false);
  const resultSubmittedRef = useRef(false);
  const selectedWordsRef = useRef<WordEntry[]>([]);
  const selectionMetaRef = useRef({
    selectionMode: 'random' as 'smart' | 'random',
    overlapRate: 0,
    rankingEligible: true,
    rankingIneligibleReason: null as string | null,
  });
  const resultsRef = useRef<WordStrikeCardResult[]>([]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const trackTimeout = useCallback((fn: () => void, ms: number): number => {
    const id = window.setTimeout(fn, ms);
    pendingTimersRef.current.push(id);
    return id;
  }, []);

  /** Switch march-speed gear; persists and live-applies to the in-flight brick. */
  const changeSpeed = useCallback((next: StrikeSpeed) => {
    setSpeed(next);
    speedRef.current = next;
    try {
      localStorage.setItem(WORD_STRIKE_SPEED_KEY, next);
    } catch {
      // private mode — the gear still applies for this session
    }
    physicsRef.current?.setBrickSpeed(
      getWordStrikeBrickSpeed(brickIndexRef.current) * SPEED_FACTOR[next]
    );
  }, []);

  const clearTrackedTimers = useCallback(() => {
    pendingTimersRef.current.forEach((id) => window.clearTimeout(id));
    pendingTimersRef.current = [];
    if (countdownTimerRef.current) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, []);

  // ----------------------------------------------------------------
  // word prep (selection + TTS preload)
  // ----------------------------------------------------------------

  const prepareGame = async () => {
    if (!canPrepare) return;

    setPreparationError(null);
    setPhase('PREPARING');
    setSelectionMessage(
      localStorage.getItem('vibe_ai_selection') === 'true'
        ? 'Smart Selection Assistant is choosing your targets...'
        : 'Random selection is choosing your targets...'
    );

    const smartSelectionEnabled = localStorage.getItem('vibe_ai_selection') === 'true';
    const scopedWords = applyWordStrikeScope(allWords, sessions, scope);
    const selection = await selectWordStrikeWords(scopedWords, sessions, smartSelectionEnabled, roundSize);
    setSelectionMode(selection.selectionMode);
    setSelectionOverlapRate(selection.overlapRate);
    setRankingEligible(selection.rankingEligible);
    setRankingIneligibleReason(selection.rankingIneligibleReason || null);
    selectionMetaRef.current = {
      selectionMode: selection.selectionMode,
      overlapRate: selection.overlapRate,
      rankingEligible: selection.rankingEligible,
      rankingIneligibleReason: selection.rankingIneligibleReason || null,
    };

    if (selection.words.length < WORD_STRIKE_MIN_WORDS) {
      setPreparationError('Not enough plain words in your library yet.');
      setPhase('INTRO');
      return;
    }

    setSelectedWords(selection.words);
    selectedWordsRef.current = selection.words;
    resultsRef.current = [];
    setSelectionMessage(`Selected ${selection.words.length} words. Loading pronunciation assets...`);
    setAudioProgress({ current: 0, total: selection.words.length });

    let completed = 0;
    for (const word of selection.words) {
      const lang = word.language || 'en';
      try {
        await preloadWordAudio(word.text, lang, 8000, word.audio_url);
      } catch (error) {
        console.warn('[WordStrikeGameMode] preload failed for', word.text, error);
      }
      completed += 1;
      setAudioProgress({ current: completed, total: selection.words.length });
    }

    setSelectionMessage(`All ${selection.words.length} audio files are ready.`);
    setPhase('READY');
  };

  // ----------------------------------------------------------------
  // brick lifecycle
  // ----------------------------------------------------------------

  const finishGame = useCallback(async () => {
    if (finalizeGuardRef.current) return;
    finalizeGuardRef.current = true;

    clearTrackedTimers();
    await stopCurrentAudio();

    const now = Date.now();
    const elapsedMs = gameStartTimeRef.current ? now - gameStartTimeRef.current : 0;

    // Words never attempted count as incorrect rows so wordsTotal stays the
    // full batch (mirrors how puzzle appends unsolved/locked cards).
    const attemptedIds = new Set(resultsRef.current.map((r) => r.wordId));
    const missing: WordStrikeCardResult[] = selectedWordsRef.current
      .filter((word) => !attemptedIds.has(word.id))
      .map((word) => ({
        wordId: word.id,
        wordText: word.text,
        correct: false,
        attemptsUsed: 0,
        lettersHit: 0,
        lettersMissed: 0,
        hintUsed: false,
        solvedAtMs: null,
        activatedAtMs: null,
      }));

    const summary = calculateWordStrikeGameSummary([...resultsRef.current, ...missing], {
      lettersHit: lettersHitTotalRef.current,
      lettersFired: lettersFiredTotalRef.current,
      maxCombo: maxComboRef.current,
      livesLost: WORD_STRIKE_LIVES - livesRef.current,
      livesRemaining: livesRef.current,
      elapsedMs,
      ...selectionMetaRef.current,
    });

    setResult(summary);
    setPhase('REVIEW');
  }, [clearTrackedTimers]);

  const spawnCurrentBrick = useCallback(() => {
    const physics = physicsRef.current;
    const word = selectedWordsRef.current[brickIndexRef.current];
    if (!physics || !word) {
      void finishGame();
      return;
    }

    setCurrentWordIndex(brickIndexRef.current);
    activeWordRef.current = word;
    brickDeadRef.current = false;
    inputLockedRef.current = false;
    attemptsRef.current = 0;
    wordLettersHitRef.current = 0;
    wordLettersMissedRef.current = 0;
    ghostsRef.current = [];
    typedRef.current = '';
    // Fresh dictation slate: nothing revealed, no wrong-input flashes.
    revealedLettersRef.current = [];
    wrongFlashRef.current = {};

    const text = normalizeWordStrikeInput(word.text);
    const unitSize = getWordStrikeUnitSize(text.length, LOGICAL_WORLD.width);
    // Difficulty = deterministic index ramp × gear; set BEFORE spawnBrick so
    // the fresh bar is born at speed (the setter also re-applies to in-flight
    // bars when called on a gear change).
    physics.setBrickSpeed(
      getWordStrikeBrickSpeed(brickIndexRef.current) * SPEED_FACTOR[speedRef.current]
    );
    // Spawn at the top of the field on a deterministic column so the WHOLE
    // word is visible at once; the elevator then tracks it down.
    const barWidth = text.length * unitSize;
    const centerX = getWordStrikeSpawnColumnX(brickIndexRef.current, barWidth);
    const y = WORD_STRIKE_SPAWN_CENTER_Y;
    physics.spawnBrick(text, word.id, { centerX, y, unitSize });
    brickActivatedAtRef.current = Date.now() - (gameStartTimeRef.current || Date.now());

    // Design point: every new brick announces itself.
    void playWordPronunciation(word.text, word.language || 'en', undefined, word.audio_url);
  }, [finishGame]);

  const advanceToNextBrick = useCallback(() => {
    brickIndexRef.current += 1;
    if (brickIndexRef.current >= selectedWordsRef.current.length) {
      void finishGame();
      return;
    }
    spawnCurrentBrick();
  }, [finishGame, spawnCurrentBrick]);

  const completeBrick = useCallback(() => {
    const word = activeWordRef.current;
    if (!word) return;

    playCheer();
    scoreRef.current += 50;
    setScore(scoreRef.current);

    resultsRef.current.push({
      wordId: word.id,
      wordText: word.text,
      correct: true,
      attemptsUsed: attemptsRef.current,
      lettersHit: wordLettersHitRef.current,
      lettersMissed: wordLettersMissedRef.current,
      hintUsed: false,
      solvedAtMs: Date.now() - (gameStartTimeRef.current || Date.now()),
      activatedAtMs: brickActivatedAtRef.current,
    });

    // The word card reveals itself in the right-side matrix ONLY after a
    // full hit — never before (dictation game: no spoilers).
    setCollectedCards((prev) => [word, ...prev]);

    inputLockedRef.current = true;

    // Snapshot the bar BEFORE clearBrick — the celebration burst replays the
    // letters flying off their last live positions (reveal allowed: word done).
    const physics = physicsRef.current;
    const burstUnits = physics
      ? physics.getAliveUnits().map((u) => ({ x: u.body.position.x, y: u.body.position.y, letter: u.letter }))
      : [];
    const barCenter = burstUnits.length
      ? {
          x: burstUnits.reduce((sum, u) => sum + u.x, 0) / burstUnits.length,
          y: burstUnits.reduce((sum, u) => sum + u.y, 0) / burstUnits.length,
        }
      : undefined;
    rendererRef.current?.spawnWordBurst(burstUnits, barCenter);
    rendererRef.current?.triggerMonsterState('cheer');
    physics?.shake(8);

    physics?.clearBrick();
    trackTimeout(advanceToNextBrick, NEXT_BRICK_DELAY_MS);
  }, [advanceToNextBrick, trackTimeout]);

  const handleBrickReachedGround = useCallback(() => {
    const physics = physicsRef.current;
    const word = activeWordRef.current;
    if (!physics || !word || brickDeadRef.current) return;

    brickDeadRef.current = true;
    inputLockedRef.current = true;
    pendingShotsRef.current = [];

    playExplosion();
    physics.shake(18);

    // Monster flinches + red vignette; the burst snapshot is taken BEFORE the
    // shatter and deliberately carries NO letters (dictation anti-spoiler —
    // a lost brick must never reveal its word).
    const burstUnits = physics.getAliveUnits().map((u) => ({ x: u.body.position.x, y: u.body.position.y }));
    const barCenter = burstUnits.length
      ? {
          x: burstUnits.reduce((sum, u) => sum + u.x, 0) / burstUnits.length,
          y: burstUnits.reduce((sum, u) => sum + u.y, 0) / burstUnits.length,
        }
      : undefined;
    const renderer = rendererRef.current;
    renderer?.triggerMonsterState('hurt');
    renderer?.triggerHurtFlash();
    renderer?.spawnBrickExplosion(burstUnits, barCenter);

    // Everything still alive goes up in debris — the explosion IS the shatter.
    physics.shatterUnits(physics.getAliveUnits().map((u) => u.unitIndex));
    physics.clearBrick();

    resultsRef.current.push({
      wordId: word.id,
      wordText: word.text,
      correct: false,
      attemptsUsed: attemptsRef.current,
      lettersHit: wordLettersHitRef.current,
      lettersMissed: wordLettersMissedRef.current,
      hintUsed: false,
      solvedAtMs: null,
      activatedAtMs: brickActivatedAtRef.current,
    });

    livesRef.current = Math.max(0, livesRef.current - 1);
    setLives(livesRef.current);
    comboRef.current = 0;
    setCombo(0);

    trackTimeout(() => {
      if (livesRef.current <= 0) {
        void finishGame();
      } else {
        advanceToNextBrick();
      }
    }, NEXT_BRICK_DELAY_MS);
  }, [advanceToNextBrick, finishGame, trackTimeout]);

  // ----------------------------------------------------------------
  // firing + letter matching
  // ----------------------------------------------------------------

  const applyShotResult = useCallback(
    (shot: PendingShot) => {
      if (shot.applied) return;
      shot.applied = true;

      const physics = physicsRef.current;
      const word = activeWordRef.current;
      if (!physics || !word || brickDeadRef.current) {
        inputLockedRef.current = false;
        return;
      }

      const aliveBefore = new Map<number, UnitHandle>();
      for (const unit of physics.getAliveUnits()) {
        aliveBefore.set(unit.unitIndex, unit);
      }
      const now = performance.now();

      if (!shot.match.isFullMatch) {
        // ---- non-lethal hit: the bar is struck but HOLDS TOGETHER ----
        // The full word must still be spelled, so nothing shatters: the bar
        // wobbles as a whole, correctly-typed letters bank onto their tiles
        // (drawn green from now on) and wrongly-typed tiles flash red —
        // positions the player never typed stay calm.
        rendererRef.current?.triggerBrickShake();

        let newlyRevealed = 0;
        for (const index of shot.match.hits) {
          if (!revealedLettersRef.current[index]) {
            const unit = aliveBefore.get(index);
            if (unit) {
              revealedLettersRef.current[index] = unit.letter;
              newlyRevealed += 1;
            }
          }
        }

        for (const index of shot.match.misses) {
          if (index < shot.typedLength) {
            wrongFlashRef.current[index] = now + WRONG_FLASH_MS;
          }
        }

        comboRef.current = 0;
        setCombo(0);
        playMiss();

        lettersFiredTotalRef.current += shot.typedLength;
        lettersHitTotalRef.current += shot.match.hits.length;
        wordLettersHitRef.current += shot.match.hits.length;
        wordLettersMissedRef.current += shot.match.missCount;

        // Only first-time reveals pay out — re-typing banked letters neither
        // scores nor rebuilds the combo.
        const gained = newlyRevealed * 10;
        if (gained > 0) {
          scoreRef.current += gained;
          setScore(scoreRef.current);
        }

        inputLockedRef.current = false;
        return;
      }

      // ---- lethal hit: a perfect spell shatters the whole bar ----
      // Ghost letters must be recorded BEFORE shatter removes the bodies.
      const newlyHit = shot.match.hits.filter((i) => aliveBefore.has(i));
      for (const index of newlyHit) {
        const unit = aliveBefore.get(index);
        if (unit) {
          ghostsRef.current.push({
            unitIndex: index,
            letter: unit.letter,
            x: unit.body.position.x,
            y: unit.body.position.y,
            bornAt: now,
          });
        }
      }

      if (newlyHit.length > 0) {
        physics.shatterUnits(newlyHit);
        playShatter();
      }

      // ---- scoring ----
      lettersFiredTotalRef.current += shot.typedLength;
      lettersHitTotalRef.current += newlyHit.length;
      wordLettersHitRef.current += newlyHit.length;
      wordLettersMissedRef.current += shot.match.missCount;

      comboRef.current += 1;
      maxComboRef.current = Math.max(maxComboRef.current, comboRef.current);
      setCombo(comboRef.current);

      const multiplier = 1 + Math.min(comboRef.current, 10) * 0.1;
      const gained = Math.round(newlyHit.length * 10 * multiplier);
      if (gained > 0) {
        scoreRef.current += gained;
        setScore(scoreRef.current);
      }

      if (physics.getAliveUnits().length === 0) {
        completeBrick();
        return;
      }

      inputLockedRef.current = false;
    },
    [completeBrick]
  );

  /** Replay the current word's TTS (` / ~ key, or the top-bar replay chip). */
  const replayCurrentWord = useCallback(() => {
    const word = activeWordRef.current;
    if (!word || phaseRef.current !== 'PLAYING') return;
    void playWordPronunciation(word.text, word.language || 'en', undefined, word.audio_url);
    setReplayPulsing(true);
    window.setTimeout(() => setReplayPulsing(false), 320);
  }, []);

  const fire = useCallback(() => {
    const physics = physicsRef.current;
    const word = activeWordRef.current;
    if (!physics || !word) return;
    if (phaseRef.current !== 'PLAYING' || inputLockedRef.current || brickDeadRef.current) return;

    const typed = typedRef.current;
    if (!typed) return;

    playGunshot();
    // Directional fire along the live gun angle from the elevator pivot;
    // muzzle FX at the exact bolt spawn point (same geometry the physics uses).
    const angle = aimAngleRef.current;
    const pivotY = getGunPivotY(elevatorYRef.current);
    physics.fireBullet(angle, pivotY);
    rendererRef.current?.spawnMuzzleFlash(
      TURRET.pivotX + Math.cos(angle) * TURRET.muzzleLength,
      pivotY + Math.sin(angle) * TURRET.muzzleLength,
      angle
    );
    rendererRef.current?.triggerMonsterState('shoot');
    lastShotAtRef.current = performance.now();
    recoilRef.current = 1;
    attemptsRef.current += 1;

    const match = matchTypedWord(word.text, typed);
    pendingShotsRef.current.push({
      match,
      typedLength: normalizeWordStrikeInput(typed).length,
      firedAt: performance.now(),
      applied: false,
    });

    // One shot in flight at a time — the player re-spells while it travels.
    typedRef.current = '';
    inputLockedRef.current = true;
  }, []);

  // ----------------------------------------------------------------
  // physics callbacks — routed through a ref so the single physics instance
  // always reaches the freshest closures without re-creating the engine.
  // ----------------------------------------------------------------

  const onBulletHitRef = useRef((_unit: UnitHandle, _contact: BulletContact) => {});
  onBulletHitRef.current = (unit: UnitHandle, contact: BulletContact) => {
    // Impact FX at the true contact point, then the oldest in-flight shot
    // resolves against whatever unit the bullet touched.
    rendererRef.current?.spawnImpact(contact.x, contact.y, Math.atan2(contact.vy, contact.vx));
    rendererRef.current?.triggerUnitFlash();
    physicsRef.current?.shake(3);
    const shot = pendingShotsRef.current.find((s) => !s.applied);
    if (!shot) return;
    applyShotResult(shot);
  };

  const onBrickReachedGroundRef = useRef(() => {});
  onBrickReachedGroundRef.current = () => handleBrickReachedGround();

  // ----------------------------------------------------------------
  // mount: physics + renderer + resize observer
  // ----------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const physics = new WordStrikePhysics({
      onBulletHit: (unit, contact) => onBulletHitRef.current(unit, contact),
      onBrickReachedGround: () => onBrickReachedGroundRef.current(),
    });
    physicsRef.current = physics;
    physics.pause(); // stays paused until COUNTDOWN → PLAYING

    const renderer = new WordStrikeRenderer(canvas);
    rendererRef.current = renderer;
    // Daily MONSTER mans the turret: top-down strike keyframes first, the
    // legacy front-view webp as mid-tier fallback (drawn upright, only the
    // gun swings), vector blob last. Every slot fails independently.
    const day = new Date().getDay();
    renderer.setMonsterFrames(getWordStrikeSpritePaths(day));
    renderer.setMonsterImage(`/monsterImages/M${day}.webp`);
    renderer.setBackgroundImage(WORD_STRIKE_BG_SRC);
    renderer.setBlockTextures(WORD_STRIKE_BLOCK_SRCS);

    const resize = () => {
      const rect = container.getBoundingClientRect();
      renderer.resize(Math.max(rect.width, 1), Math.max(rect.height, 1));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      clearTrackedTimers();
      physics.destroy();
      physicsRef.current = null;
      rendererRef.current = null;
      void stopCurrentAudio();
    };
  }, [clearTrackedTimers]);

  // ----------------------------------------------------------------
  // rAF loop — only while PLAYING
  // ----------------------------------------------------------------

  useEffect(() => {
    // COUNTDOWN also draws (grass field + idle gunner) — physics stays paused.
    if (phase !== 'PLAYING' && phase !== 'COUNTDOWN') return;

    if (phase === 'PLAYING') {
      physicsRef.current?.resume();
      if (gameStartTimeRef.current == null) {
        gameStartTimeRef.current = Date.now();
      }
    }

    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;

      const physics = physicsRef.current;
      const renderer = rendererRef.current;
      if (physics && renderer) {
        if (!document.hidden && phaseRef.current === 'PLAYING') {
          physics.update(dt);

          // Fallback: a shot whose bullet somehow never connected (flew
          // through a gap in a shattered bar) still resolves.
          const expired = pendingShotsRef.current.filter(
            (s) => !s.applied && now - s.firedAt > SHOT_RESOLVE_TIMEOUT_MS
          );
          for (const shot of expired) {
            applyShotResult(shot);
          }
        }

        recoilRef.current *= 0.86;

        // Elevator tracking: the platform carries the gun pivot to the word's
        // height, exponentially smoothed (rate 5/s → ~0.7s across the full
        // travel; slower drift back to the ground when nothing is in flight).
        const center = physics.getBrickCenter();
        const feetTarget = center
          ? Math.min(ELEVATOR.bottomFeetY, Math.max(ELEVATOR.topFeetY, center.y + ELEVATOR.gunOffsetY))
          : ELEVATOR.bottomFeetY;
        elevatorYRef.current +=
          (feetTarget - elevatorYRef.current) * Math.min(1, (dt / 1000) * (center ? 5 : 1.2));

        // Per-frame gun aiming: lead the sinking bar's center by its
        // velocity from the live pivot height. No brick → aimTarget null and
        // the gun relaxes straight right.
        let aimTarget: WordStrikeAimTarget | null = null;
        if (center) {
          const pivotY = getGunPivotY(elevatorYRef.current);
          const angle = getWordStrikeAimAngle(
            TURRET.pivotX,
            pivotY,
            center.x,
            center.y,
            center.vx,
            center.vy
          );
          aimAngleRef.current = angle;
          aimTarget = { angle, x: center.x, y: center.y };
        }

        renderer.draw(physics, {
          ghosts: ghostsRef.current,
          floaters: floatersRef.current,
          lastShotAt: lastShotAtRef.current,
          recoil: recoilRef.current,
          typed: typedRef.current,
          revealed: revealedLettersRef.current.join(''),
          wrongFlash: wrongFlashRef.current,
          now,
          aimTarget,
          elevatorFeetY: elevatorYRef.current,
        });
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      physicsRef.current?.pause();
    };
  }, [applyShotResult, phase]);

  // ----------------------------------------------------------------
  // keyboard capture — PLAYING only
  // ----------------------------------------------------------------

  const currentTargetLength = useMemo(() => {
    const word = currentWordIndex >= 0 ? selectedWords[currentWordIndex] : null;
    return word ? normalizeWordStrikeInput(word.text).length : 0;
  }, [currentWordIndex, selectedWords]);

  useEffect(() => {
    if (phase !== 'PLAYING') return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTextInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;
      if (isTextInput) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // Keep page-level keys from scrolling the game viewport.
      if (
        event.key === ' ' ||
        event.key === 'Tab' ||
        event.key === 'ArrowUp' ||
        event.key === 'ArrowDown'
      ) {
        event.preventDefault();
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        fire();
        return;
      }

      // ` / ~ — replay the current word's pronunciation (didn't catch it?
      // never a dead end). Works regardless of input lock.
      if (event.key === '~' || event.key === '`') {
        event.preventDefault();
        replayCurrentWord();
        return;
      }

      if (event.key === 'Backspace') {
        event.preventDefault();
        if (!inputLockedRef.current && typedRef.current.length > 0) {
          typedRef.current = typedRef.current.slice(0, -1);
        }
        return;
      }

      if (/^[a-zA-Z]$/.test(event.key)) {
        event.preventDefault();
        if (inputLockedRef.current) return;
        const word = activeWordRef.current;
        const maxLen = word ? normalizeWordStrikeInput(word.text).length : 12;
        if (typedRef.current.length >= maxLen) return;
        typedRef.current += event.key.toLowerCase();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fire, phase, replayCurrentWord]);

  // ----------------------------------------------------------------
  // countdown
  // ----------------------------------------------------------------

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
          trackTimeout(() => {
            finalizeGuardRef.current = false;
            resultSubmittedRef.current = false;
            livesRef.current = WORD_STRIKE_LIVES;
            setLives(WORD_STRIKE_LIVES);
            scoreRef.current = 0;
            setScore(0);
            comboRef.current = 0;
            maxComboRef.current = 0;
            setCombo(0);
            lettersHitTotalRef.current = 0;
            lettersFiredTotalRef.current = 0;
            resultsRef.current = [];
            setCollectedCards([]);
            brickIndexRef.current = 0;
            gameStartTimeRef.current = Date.now();
            setBannerMessage('GO!');
            setPhase('PLAYING');
            spawnCurrentBrick();
            trackTimeout(() => setBannerMessage(null), 1200);
          }, 250);
          return 0;
        }
        return current - 1;
      });
    }, 900);
  };

  // ----------------------------------------------------------------
  // REVIEW → RESULT submission
  // ----------------------------------------------------------------

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

  const handleExitClick = () => {
    if (phase === 'REVIEW') {
      setShowExitConfirm(true);
    } else {
      onCancel();
    }
  };

  // ----------------------------------------------------------------
  // derived UI data
  // ----------------------------------------------------------------

  const currentWord = currentWordIndex >= 0 ? selectedWords[currentWordIndex] : null;
  const hintDefinition = currentWord?.definition_cn || null;

  const summaryCards = result
    ? [
        { labelEn: 'Total Score', labelZh: '总分', value: Math.round(result.totalScore) },
        { labelEn: 'Accuracy', labelZh: '完成率', value: `${Math.round(result.accuracyRate * 100)}%` },
        { labelEn: 'Max Combo', labelZh: '最高连击', value: `${result.maxCombo}` },
        { labelEn: 'Lives Left', labelZh: '剩余生命', value: `${result.livesRemaining}/${WORD_STRIKE_LIVES}` },
      ]
    : [];

  return (
    <div className="fixed inset-0 z-[90] overflow-hidden bg-[radial-gradient(ellipse_at_center,_#232338_0%,_#1A1A2E_55%,_#0F0F20_100%)]">
      <div className="relative flex h-[100dvh] flex-col px-3 pb-3 pt-3 md:px-5 md:pb-4 md:pt-4">
        {/* compact single-row game HUD — every pixel of vertical space goes to
            the arena. The replay chip is ALWAYS on during play (keyboard or
            mouse, works with or without a CN definition); the definition hint
            folds in beside it (the ONLY on-screen hint while the brick falls;
            never the word or its phonetic). */}
        <div className="mb-2 flex shrink-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 md:gap-3">
            <h2 className="shrink-0 font-headline text-xl text-white md:text-2xl">
              <HoverTranslationText text="Word Strike" translation="单词射击" />
            </h2>
            {phase === 'PLAYING' && (
              <button
                onClick={replayCurrentWord}
                title="Replay pronunciation ( ~ )"
                className={`flex shrink-0 items-center gap-1.5 rounded-xl border border-electric-blue/40 bg-electric-blue/10 px-2.5 py-1 text-electric-blue transition-all hover:border-electric-blue hover:bg-electric-blue/20 ${
                  replayPulsing ? 'scale-110 border-electric-blue shadow-[0_0_14px_rgba(0,240,255,0.45)]' : ''
                }`}
                aria-label="replay pronunciation"
              >
                <span className="material-symbols-outlined text-[18px]">volume_up</span>
                <span className="hidden font-mono text-[10px] uppercase tracking-[0.15em] sm:inline">
                  <HoverTranslationText text="Replay" translation="重读" />
                </span>
                <span className="font-mono text-[10px] text-electric-blue/60 sm:hidden">~</span>
              </button>
            )}
            {phase === 'PLAYING' && hintDefinition && (
              <div className="flex min-w-0 items-center rounded-xl border border-electric-purple/40 bg-electric-purple/10 px-3 py-1">
                <span className="min-w-0 truncate text-xs text-electric-purple">{hintDefinition}</span>
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2 md:gap-3">
            {(phase === 'PLAYING' || phase === 'COUNTDOWN') && (
              <>
                <div className="flex items-center gap-0.5" title="Lives">
                  {Array.from({ length: WORD_STRIKE_LIVES }).map((_, index) => (
                    <span
                      key={`life-${index}`}
                      className={`material-symbols-outlined text-lg md:text-xl ${
                        index < lives ? 'text-red-400' : 'text-mid-charcoal'
                      }`}
                    >
                      favorite
                    </span>
                  ))}
                </div>
                <div className="rounded-xl border border-electric-green/30 bg-electric-green/10 px-3 py-1 font-headline text-xl text-electric-green">
                  {score}
                </div>
                {combo > 1 && (
                  <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 font-mono text-xs text-amber-300">
                    🔥 x{combo}
                  </div>
                )}
              </>
            )}
            <button
              onClick={handleExitClick}
              className="rounded-xl border border-mid-charcoal bg-dark-charcoal/70 px-3 py-1.5 text-[10px] font-mono uppercase tracking-[0.25em] text-text-light transition-colors hover:border-white hover:text-white"
            >
              <HoverTranslationText text="Exit" translation="退出" />
            </button>
          </div>
        </div>

        {/* INTRO */}
        {phase === 'INTRO' && (
          <div className="flex flex-1 items-center justify-center">
            <div className="w-full max-w-3xl rounded-[32px] border border-mid-charcoal bg-dark-charcoal/80 p-8 shadow-2xl backdrop-blur-md md:p-10">
              <div className="grid gap-8 md:grid-cols-[1.15fr_0.85fr]">
                <div className="space-y-5">
                  <p className="max-w-2xl text-sm leading-7 text-text-light md:text-base">
                    <HoverTranslationText
                      text="Listen — the brick's letters are hidden. Type what you hear and press Enter to fire. A perfect spell shatters the brick; a wrong one just shakes it, keeps the letters you got right (green) and flashes the wrong ones red — spell it again. Collect every word card before the brick touches the ground — 3 lives, then it's over."
                      translation="听音拼写——砖块上的字母是隐藏的。输入你听到的单词并按回车开炮：完全拼对时砖块才会被击碎；拼错时砖块只会整体晃一下，拼对的字母保留显示（绿色）、拼错的砖块闪红——请再次输入直到完全正确。在砖块落地前收集所有单词卡片——共 3 条命，耗尽即结束。"
                    />
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-3xl border border-mid-charcoal bg-light-charcoal/30 p-4">
                      <div className="text-xs font-mono uppercase tracking-[0.3em] text-text-dark">
                        <HoverTranslationText text="Lives" translation="生命" />
                      </div>
                      <div className="mt-2 text-2xl font-headline text-white">3 ♥</div>
                    </div>
                    <div className="rounded-3xl border border-mid-charcoal bg-light-charcoal/30 p-4">
                      <div className="text-xs font-mono uppercase tracking-[0.3em] text-text-dark">
                        <HoverTranslationText text="Words / round" translation="每轮词数" />
                      </div>
                      <div className="mt-2 text-2xl font-headline text-white">{roundSize}</div>
                    </div>
                    <div className="rounded-3xl border border-mid-charcoal bg-light-charcoal/30 p-4">
                      <div className="text-xs font-mono uppercase tracking-[0.3em] text-text-dark">
                        <HoverTranslationText text="Controls" translation="操作" />
                      </div>
                      <div className="mt-2 text-2xl font-headline text-white">A-Z · ~ · Enter</div>
                    </div>
                    <div className="rounded-3xl border border-mid-charcoal bg-light-charcoal/30 p-4">
                      <div className="text-xs font-mono uppercase tracking-[0.3em] text-text-dark">
                        <HoverTranslationText text="Hint" translation="提示" />
                      </div>
                      <div className="mt-2 text-2xl font-headline text-white">
                        <HoverTranslationText text="Audio + meaning" translation="读音 + 释义" />
                      </div>
                    </div>
                  </div>
                  <div className="rounded-2xl border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-xs font-mono text-amber-200/80">
                    <HoverTranslationText
                      text="Physical keyboard required — desktop recommended."
                      translation="需要实体键盘——建议在桌面端游玩。"
                    />
                  </div>
                </div>

                <div className="rounded-[28px] border border-electric-green/25 bg-[linear-gradient(180deg,rgba(46,230,124,0.10),rgba(46,230,124,0.03))] p-6">
                  <div className="text-xs font-mono uppercase tracking-[0.3em] text-electric-green/70">
                    <HoverTranslationText text="Preparation" translation="准备状态" />
                  </div>
                  <div className="mt-4 text-sm leading-7 text-text-light">
                    <HoverTranslationText
                      text={`Plain words available: ${candidateCount}. You need at least ${WORD_STRIKE_MIN_WORDS} to start.`}
                      translation={`当前范围可用纯字母单词：${candidateCount}。至少需要 ${WORD_STRIKE_MIN_WORDS} 个才能开始。`}
                    />
                  </div>

                  {/* sampling scope */}
                  <div className="mt-4">
                    <div className="text-xs font-mono uppercase tracking-[0.28em] text-text-dark">
                      <HoverTranslationText text="Word scope" translation="抽样范围" />
                    </div>
                    <div className="mt-2 flex items-center gap-1 rounded-2xl border border-mid-charcoal/70 bg-dark-charcoal/50 p-1">
                      {([
                        { key: 'recent3' as const, en: 'LAST 3', zh: '最近 3 批' },
                        { key: 'recent5' as const, en: 'LAST 5', zh: '最近 5 批' },
                        { key: 'all' as const, en: 'ALL', zh: '全部词汇' },
                      ]).map((option) => (
                        <button
                          key={option.key}
                          onClick={() => changeScope(option.key)}
                          className={`flex-1 rounded-xl px-2 py-2 font-mono text-[10px] uppercase tracking-[0.1em] transition-colors ${
                            scope === option.key
                              ? 'bg-electric-green text-charcoal'
                              : 'text-text-dark hover:text-text-light'
                          }`}
                        >
                          <HoverTranslationText text={option.en} translation={option.zh} />
                          <span className="ml-1 opacity-70">{scopeCounts[option.key]}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* words per round */}
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-xs font-mono uppercase tracking-[0.28em] text-text-dark">
                      <span>
                        <HoverTranslationText text="Words / round" translation="每轮词数" />
                      </span>
                      <span className="text-electric-green">{roundSize}</span>
                    </div>
                    <input
                      type="range"
                      min={ROUND_SIZE_MIN}
                      max={ROUND_SIZE_MAX}
                      step={1}
                      value={roundSize}
                      onChange={(e) => changeRoundSize(Number(e.target.value))}
                      className="mt-2 w-full accent-electric-green"
                      aria-label="words per round"
                    />
                    <div className="mt-1 flex justify-between font-mono text-[10px] text-text-dark">
                      <span>{ROUND_SIZE_MIN}</span>
                      <span>{ROUND_SIZE_MAX}</span>
                    </div>
                  </div>

                  <button
                    onClick={prepareGame}
                    disabled={!canPrepare}
                    className={`mt-8 w-full rounded-2xl px-5 py-4 font-headline text-sm uppercase tracking-[0.3em] transition-all ${
                      canPrepare
                        ? 'bg-electric-green text-charcoal hover:-translate-y-1 hover:shadow-[0_0_30px_rgba(46,230,124,0.25)]'
                        : 'cursor-not-allowed bg-mid-charcoal text-text-dark'
                    }`}
                  >
                    <HoverTranslationText text="Load Strike Run" translation="开始准备" />
                  </button>
                  {!canPrepare && (
                    <div className="mt-4 text-xs font-mono text-red-300">
                      <HoverTranslationText
                        text="Add more plain words (letters only, ≤14 chars) to unlock this mode."
                        translation="请先录入更多纯字母单词（≤14 个字母）以解锁此模式。"
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* PREPARING */}
        {phase === 'PREPARING' && (
          <div className="flex flex-1 items-center justify-center">
            <div className="w-full max-w-2xl rounded-[32px] border border-mid-charcoal bg-dark-charcoal/80 p-8 shadow-2xl backdrop-blur-md md:p-10">
              <div className="text-center">
                <div className="inline-flex rounded-full border border-electric-green/30 bg-electric-green/10 px-4 py-2 text-xs font-mono uppercase tracking-[0.3em] text-electric-green">
                  <HoverTranslationText text="Preparing Strike Run" translation="正在准备射击" />
                </div>
                <h3 className="mt-6 font-headline text-3xl text-white">
                  <HoverTranslationText text="Selecting Words + Loading Audio" translation="单词遴选 + 音频加载" />
                </h3>
                <p className="mx-auto mt-4 max-w-xl text-sm leading-7 text-text-light">{selectionMessage}</p>
              </div>

              <div className="mt-8 rounded-[28px] border border-mid-charcoal bg-light-charcoal/30 p-6">
                <div className="flex items-center justify-between text-xs font-mono uppercase tracking-[0.28em] text-text-dark">
                  <span>
                    <HoverTranslationText text="Audio preload" translation="音频预载" />
                  </span>
                  <span>
                    {audioProgress.current}/{audioProgress.total}
                  </span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-mid-charcoal">
                  <div
                    className="h-full rounded-full bg-electric-green transition-all duration-300"
                    style={{
                      width:
                        audioProgress.total > 0
                          ? `${(audioProgress.current / audioProgress.total) * 100}%`
                          : '0%',
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* READY — this click unlocks the AudioContext (autoplay policy) */}
        {phase === 'READY' && (
          <div className="flex flex-1 items-center justify-center">
            <div className="w-full max-w-md rounded-[32px] border border-electric-green/30 bg-dark-charcoal/85 p-8 text-center shadow-2xl backdrop-blur-md">
              <div className="text-xs font-mono uppercase tracking-[0.3em] text-electric-green/70">
                <HoverTranslationText text="Ready" translation="准备就绪" />
              </div>
              <h3 className="mt-4 font-headline text-4xl text-white">
                <HoverTranslationText text={`${selectedWords.length} words loaded`} translation={`已装填 ${selectedWords.length} 个单词`} />
              </h3>
              <p className="mt-3 text-sm text-text-light">
                <HoverTranslationText
                  text="Turn your sound on — every brick announces its word."
                  translation="打开声音——每块砖出现时都会朗读单词。"
                />
              </p>

              {/* march-speed gear — adjustable again mid-game from the side panel */}
              <div className="mt-6 rounded-2xl border border-mid-charcoal bg-light-charcoal/30 p-4 text-left">
                <div className="flex items-center justify-between text-xs font-mono uppercase tracking-[0.28em] text-text-dark">
                  <span>
                    <HoverTranslationText text="March speed" translation="推进速度" />
                  </span>
                  <span className="text-electric-green">
                    <HoverTranslationText
                      text={SPEED_LABELS[speed].en}
                      translation={SPEED_LABELS[speed].zh}
                    />
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={1}
                  value={SPEED_ORDER.indexOf(speed)}
                  onChange={(e) => changeSpeed(SPEED_ORDER[Number(e.target.value)])}
                  className="mt-3 w-full accent-electric-green"
                  aria-label={isZh ? '推进速度' : 'March speed'}
                />
                <div className="mt-1 flex justify-between font-mono text-[10px] text-text-dark">
                  <span><HoverTranslationText text="SLOW" translation="慢" /></span>
                  <span><HoverTranslationText text="NORMAL" translation="中" /></span>
                  <span><HoverTranslationText text="FAST" translation="快" /></span>
                </div>
              </div>

              <button
                onClick={startCountdown}
                className="mt-8 w-full rounded-2xl bg-electric-green px-5 py-4 font-headline text-sm uppercase tracking-[0.3em] text-charcoal transition-all hover:-translate-y-1 hover:shadow-[0_0_30px_rgba(46,230,124,0.3)]"
              >
                <HoverTranslationText text="Start" translation="开始" />
              </button>
            </div>
          </div>
        )}

        {/* ARENA + CARD MATRIX — always mounted so the canvas exists when the
            mount effect initializes physics/renderer (a phase-conditional
            canvas meant the effect bailed at INTRO and physics never got
            created). Hidden outside COUNTDOWN/PLAYING. */}
        <div
          className={`min-h-0 flex-1 gap-4 ${
            phase === 'COUNTDOWN' || phase === 'PLAYING' ? 'flex' : 'hidden'
          }`}
        >
          <div ref={containerRef} className="relative min-h-0 flex-1">
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

          {/* countdown overlay + GO! banner live INSIDE the canvas frame so
              they center on the arena, not on the page column */}
          {phase === 'COUNTDOWN' && (
            <div className="absolute inset-0 z-30 flex items-center justify-center">
              <div className="font-headline text-[120px] text-electric-green drop-shadow-[0_0_30px_rgba(46,230,124,0.5)]">
                {countdownValue > 0 ? countdownValue : ''}
              </div>
            </div>
          )}
          {bannerMessage && (phase === 'PLAYING' || phase === 'COUNTDOWN') && (
            <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center">
              <div className="font-headline text-7xl text-electric-green drop-shadow-[0_0_24px_rgba(46,230,124,0.6)]">
                <HoverTranslationText text={bannerMessage} translation={bannerMessage === 'GO!' ? '开始！' : bannerMessage} />
              </div>
            </div>
          )}

          {/* word cards collect in the right-side matrix; typed characters
              render directly on the brick units (see renderer) — there is no
              separate input bar */}
          </div>

          {/* collected word cards — a word only appears here AFTER its brick
              is fully shattered (dictation: no spoilers before that). Floated
              with vertical margins so it never hugs the screen edges. */}
          <aside className="hidden w-[280px] shrink-0 flex-col rounded-[28px] border border-mid-charcoal/70 bg-dark-charcoal/60 p-4 shadow-[0_12px_40px_rgba(0,0,0,0.35)] backdrop-blur-md md:flex">
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-text-dark">
                <span className="material-symbols-outlined text-[14px] text-electric-green/70">award_star</span>
                <HoverTranslationText text="Collected" translation="已击碎" />
              </span>
              <span className="rounded-full border border-electric-green/30 bg-electric-green/10 px-2 py-0.5 font-mono text-[10px] text-electric-green">
                {collectedCards.length}/{selectedWords.length || 0}
              </span>
            </div>

            {/* live march-speed gear — switchable mid-game, applies in flight */}
            <div className="mt-3 flex items-center gap-1 rounded-2xl border border-mid-charcoal/70 bg-dark-charcoal/60 p-1">
              {SPEED_ORDER.map((s) => (
                <button
                  key={s}
                  onClick={() => changeSpeed(s)}
                  className={`flex-1 rounded-xl px-2 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors ${
                    speed === s
                      ? 'bg-electric-green text-charcoal'
                      : 'text-text-dark hover:text-text-light'
                  }`}
                >
                  <HoverTranslationText text={SPEED_LABELS[s].en} translation={SPEED_LABELS[s][isZh ? 'zh' : 'en']} />
                </button>
              ))}
            </div>

            <div className="mt-3 min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1.5 custom-scrollbar">
              {collectedCards.length === 0 && (
                <div className="rounded-2xl border border-dashed border-mid-charcoal px-3 py-6 text-center text-[11px] font-mono leading-5 text-text-dark">
                  <HoverTranslationText
                    text="Shatter a brick to reveal its word card."
                    translation="击碎砖块后，单词卡片会显示在这里。"
                  />
                </div>
              )}
              {collectedCards.map((word, index) => (
                <div
                  key={word.id}
                  className={`rounded-2xl border bg-gradient-to-b from-light-charcoal/40 to-dark-charcoal/60 p-3.5 transition-colors ${
                    index === 0
                      ? 'border-electric-green/60 shadow-[0_0_20px_rgba(46,230,124,0.15)]'
                      : 'border-mid-charcoal/80 hover:border-electric-green/30'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-serif text-xl text-white">{word.text}</span>
                    <button
                      onClick={() =>
                        void playWordPronunciation(word.text, word.language || 'en', undefined, word.audio_url)
                      }
                      className="shrink-0 rounded-full p-1 text-electric-blue/70 transition-colors hover:bg-electric-blue/10 hover:text-electric-blue"
                      aria-label={isZh ? '重播' : 'Replay'}
                    >
                      <span className="material-symbols-outlined text-[18px]">volume_up</span>
                    </button>
                  </div>
                  {word.phonetic && (
                    <div className="mt-0.5 font-mono text-[10px] text-electric-blue/60">{word.phonetic}</div>
                  )}
                  <div className="mt-1.5 text-xs leading-5 text-text-light/90">
                    {wordMeaningForLanguage(word, isZh)}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 border-t border-mid-charcoal/60 pt-2.5 text-center font-mono text-[9px] uppercase tracking-[0.2em] text-text-dark">
              <HoverTranslationText text="Enter = fire · ~ = replay" translation="回车 = 开火 · ~ = 重读" />
            </div>
          </aside>
        </div>

        {/* MOBILE strip (<md): the side panel's essentials survive as a
            compact horizontal bar — speed gear, collected chips (swipeable),
            and the controls hint. */}
        {phase === 'PLAYING' && (
          <div className="mt-2 flex shrink-0 items-center gap-2 md:hidden">
            <div className="flex shrink-0 items-center gap-0.5 rounded-xl border border-mid-charcoal/70 bg-dark-charcoal/60 p-1">
              {SPEED_ORDER.map((s) => (
                <button
                  key={s}
                  onClick={() => changeSpeed(s)}
                  className={`rounded-lg px-2 py-1 font-mono text-[10px] uppercase transition-colors ${
                    speed === s ? 'bg-electric-green text-charcoal' : 'text-text-dark'
                  }`}
                >
                  {SPEED_LABELS[s][isZh ? 'zh' : 'en']}
                </button>
              ))}
            </div>
            <div className="custom-scrollbar flex min-w-0 flex-1 gap-1.5 overflow-x-auto overflow-y-hidden pb-1">
              {/* overflow-y-hidden: the hidden hover-translation bubble inside the
                  hint span otherwise creates phantom vertical overflow → a
                  stray scrollbar thumb at the strip's right end. */}
              {collectedCards.length === 0 ? (
                <span className="shrink-0 py-1 font-mono text-[10px] text-text-dark">
                  <HoverTranslationText text="Shatter bricks to collect cards" translation="击碎砖块收集单词卡" />
                </span>
              ) : (
                collectedCards.map((word) => (
                  <button
                    key={word.id}
                    onClick={() =>
                      void playWordPronunciation(word.text, word.language || 'en', undefined, word.audio_url)
                    }
                    className="shrink-0 rounded-full border border-electric-green/30 bg-electric-green/10 px-2.5 py-1 font-serif text-sm text-white"
                  >
                    {word.text}
                  </button>
                ))
              )}
            </div>
            <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.15em] text-text-dark"><HoverTranslationText text="~ Replay" translation="~ 重读" /></span>
          </div>
        )}

        {/* REVIEW */}
        {phase === 'REVIEW' && result && (
          <div className="flex flex-1 items-center justify-center overflow-y-auto py-4">
            <div className="w-full max-w-4xl rounded-[32px] border border-mid-charcoal bg-dark-charcoal/85 p-8 shadow-2xl backdrop-blur-md md:p-10">
              <div className="text-xs font-mono uppercase tracking-[0.35em] text-electric-green/80">
                <HoverTranslationText text="Round Review" translation="本局复盘" />
              </div>
              <h3 className="mt-3 font-headline text-4xl text-white">
                <HoverTranslationText text="Strike run complete." translation="射击结束。" />
              </h3>

              <div className="mt-6 space-y-2">
                {result.results.map((item) => (
                  <div
                    key={item.wordId}
                    className={`flex items-center justify-between rounded-2xl border px-4 py-3 ${
                      item.correct ? 'border-green-400/40 bg-green-500/5' : 'border-red-500/40 bg-red-500/5'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`material-symbols-outlined ${item.correct ? 'text-green-400' : 'text-red-400'}`}
                      >
                        {item.correct ? 'check_circle' : 'cancel'}
                      </span>
                      <span className="font-serif text-lg text-white">{item.wordText}</span>
                    </div>
                    <div className="font-mono text-xs text-text-dark">
                      <HoverTranslationText
                        text={
                          item.correct
                            ? `${item.attemptsUsed} shot${item.attemptsUsed === 1 ? '' : 's'} · ${item.lettersHit} hit / ${item.lettersMissed} miss`
                            : item.activatedAtMs == null
                              ? 'Not attempted'
                              : 'Brick hit the ground'
                        }
                        translation={
                          item.correct
                            ? `${item.attemptsUsed} 次射击 · 命中 ${item.lettersHit} / 未中 ${item.lettersMissed}`
                            : item.activatedAtMs == null
                              ? '未挑战'
                              : '砖块落地了'
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>

              <button
                onClick={() => void proceedToResult()}
                className="mt-8 w-full rounded-2xl bg-electric-green px-5 py-4 font-headline text-sm uppercase tracking-[0.3em] text-charcoal transition-all hover:-translate-y-1 hover:shadow-[0_0_30px_rgba(46,230,124,0.25)]"
              >
                <HoverTranslationText text="Next: view score" translation="下一步：查看成绩" />
              </button>
            </div>
          </div>
        )}

        {/* RESULT */}
        {phase === 'RESULT' && result && (
          <div className="flex flex-1 items-center justify-center overflow-y-auto py-4">
            <div className="w-full max-w-5xl rounded-[32px] border border-mid-charcoal bg-dark-charcoal/85 p-8 shadow-2xl backdrop-blur-md md:p-10">
              <div className="grid gap-8 md:grid-cols-[1.2fr_0.8fr]">
                <div>
                  <div className="text-xs font-mono uppercase tracking-[0.35em] text-electric-green/80">
                    <HoverTranslationText text="Round Complete" translation="本局完成" />
                  </div>
                  <h3 className="mt-3 font-headline text-4xl text-white">
                    <HoverTranslationText text="Strike run archived." translation="射击成绩已归档。" />
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
                        text={`Leaderboard metrics: total ${Math.round(result.totalScore)}, accuracy ${Math.round(result.accuracyRate * 100)}%, speed ${result.speedScore}, combo ${result.comboScore}.`}
                        translation={`排行榜指标：总分 ${Math.round(result.totalScore)}，完成率 ${Math.round(result.accuracyRate * 100)}%，速度分 ${result.speedScore}，连击分 ${result.comboScore}。`}
                      />
                    </div>
                    <div className="mt-2">
                      <HoverTranslationText
                        text={`Letter precision: ${result.lettersHit}/${result.lettersFired} · words ${result.wordsCorrect}/${result.wordsTotal} · lives lost ${result.livesLost}.`}
                        translation={`字母命中率：${result.lettersHit}/${result.lettersFired} · 单词 ${result.wordsCorrect}/${result.wordsTotal} · 失命 ${result.livesLost}。`}
                      />
                    </div>
                    <div className="mt-2">
                      <HoverTranslationText
                        text={`Selection mode: ${result.selectionMode.toUpperCase()} · overlap with today's earlier runs ${Math.round(result.overlapRate * 100)}%.${result.rankingEligible ? '' : ' This round is not eligible for ranking.'}`}
                        translation={`选词模式：${result.selectionMode === 'smart' ? '智能' : '随机'} · 与今日更早对局重复率 ${Math.round(result.overlapRate * 100)}%。${result.rankingEligible ? '' : ' 本局不计入排行榜成绩。'}`}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex min-h-[320px] flex-col justify-between rounded-[30px] border border-electric-green/20 bg-electric-green/5 p-6">
                  <WordStrikeLeaderboardPanel />
                  <button
                    onClick={onCancel}
                    className="mt-6 rounded-2xl bg-electric-green px-4 py-4 font-headline text-sm uppercase tracking-[0.3em] text-charcoal transition-transform hover:-translate-y-1"
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

        {/* exit confirm */}
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

export default WordStrikeGameMode;
