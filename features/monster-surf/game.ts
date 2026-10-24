import {
  SURF_BASE_SPEED, SURF_FIRST_CHECKPOINT, SURF_MAX_HITS,
  SURF_WORLD_WIDTH, surfMagnetRadius, surfSpeedMultiplier,
  SURF_RIDER_COLLISION_RX as HERO_RX, SURF_RIDER_COLLISION_RY as HERO_RY,
  SURF_CHASE_TRIGGER, SURF_CHASE_ESCAPE_WORDS, SURF_CHASE_MAX_MISTAKES,
  SURF_CHASE_WARNING_MS, SURF_CHASE_RETREAT_MS, SURF_CHASE_ATTACK_MS,
  SURF_CHASE_BOOST_MS, SURF_CHASE_BOOST_MULTIPLIER, SURF_CHASE_ACTION_MS, SURF_CHASE_INITIAL_GAP,
} from './constants.ts';
import { maintainSurfCourse } from './course.ts';
import { SURF_WORDS } from './words.ts';
import type { SurfChase, SurfControls, SurfEvent, SurfObstacle, SurfState, SurfWord } from './types.ts';

export { SURF_WORDS } from './words.ts';

const FEEDBACK_MS = 650;
const SINK_MS = 1_100;
const MAX_TICK_MS = 10_000;
const SIMULATION_STEP_MS = 10;
const EDGE = 65;
const MAX_STEER_SPEED = 270;
const STEER_RESPONSE = 4.5;
const INVULNERABLE_MS = 1_800;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const validMonster = (id: number) => Number.isInteger(id) && id >= 0 && id <= 6 ? id : 1;
const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/[‐‑]/g, '-');
const isChaseActive = (chase: SurfChase) => chase.phase === 'warning' || chase.phase === 'chasing';
const surfingSpeed = (state: Pick<SurfState, 'correct' | 'chase'>) => SURF_BASE_SPEED * surfSpeedMultiplier(state.correct)
  * (state.chase.boostMs > 0 ? SURF_CHASE_BOOST_MULTIPLIER : 1);
const sinkDuration = (state: SurfState) => state.chase.phase === 'attacking' ? SURF_CHASE_ATTACK_MS : SINK_MS;

function emit(state: SurfState, kind: SurfEvent['kind'], count?: number): SurfState {
  const eventId = state.eventId + 1;
  return { ...state, eventId, event: { id: eventId, kind, ...(count === undefined ? {} : { count }) } };
}

function roundDeck(words: readonly SurfWord[]): readonly SurfWord[] {
  const answers = new Set<string>();
  const ids = new Set<string>();
  const deck: SurfWord[] = [];
  for (const word of words) {
    const answer = normalize(word.answer);
    if (!/^[a-z]+(?:[-'][a-z]+)*$/.test(answer) || answers.has(answer) || word.wordId && ids.has(word.wordId)) continue;
    answers.add(answer);
    if (word.wordId) ids.add(word.wordId);
    deck.push(Object.freeze({ ...word, answer }));
  }
  if (!deck.length) throw new Error('A surf round requires at least one playable word.');
  return Object.freeze(deck);
}

export function createSurfState(monster = 1, words: readonly SurfWord[] = SURF_WORDS): SurfState {
  return maintainSurfCourse({
    phase: 'ready', resumePhase: null, phaseMs: 0, elapsedMs: 0, wordElapsedMs: 0,
    deck: roundDeck(words), endReason: null,
    monster: validMonster(monster), x: SURF_WORLD_WIDTH / 2, vx: 0,
    distance: 0, speed: SURF_BASE_SPEED, checkpoint: 0, nextCheckpoint: SURF_FIRST_CHECKPOINT,
    input: '', hits: 0, correct: 0, streak: 0, bestStreak: 0, coins: 0, score: 0,
    items: [], obstacles: [], navigation: 'waiting', targetX: SURF_WORLD_WIDTH / 2, invulnerableMs: 0,
    chase: { phase: 'dormant', phaseMs: 0, escapeStreak: 0, mistakes: 0, gap: SURF_CHASE_INITIAL_GAP,
      targetGap: SURF_CHASE_INITIAL_GAP, boostMs: 0, action: 'follow', actionMs: 0 },
    feedback: 'ready', event: null, eventId: 0,
  });
}

export function startSurf(monster = 1, words: readonly SurfWord[] = SURF_WORDS): SurfState {
  return { ...createSurfState(monster, words), phase: 'surfing', feedback: 'listen' };
}

export function selectSurfMonster(state: SurfState, id: number): SurfState {
  if (state.phase !== 'ready' || validMonster(id) !== id || state.monster === id) return state;
  return { ...state, monster: id };
}

export function currentSurfWord(state: SurfState): SurfWord {
  // Preserve the final clue on the result screen without wrapping to word one.
  return state.deck[Math.min(state.checkpoint, state.deck.length - 1)];
}

export function setSurfInput(state: SurfState, input: string): SurfState {
  if (state.phase !== 'surfing') return state;
  // Match the settlement log limit, including pasted text. A long wrong answer
  // must not make an otherwise valid paid ride impossible to settle.
  input = input.slice(0, 128);
  const prefix = normalize(input);
  return { ...state, input, feedback: 'listen', navigation: !prefix ? 'waiting'
    : currentSurfWord(state).answer.startsWith(prefix) ? 'guided' : 'locked' };
}

function injure(state: SurfState, collision?: SurfObstacle): SurfState {
  const hits = state.hits + 1;
  const away = collision ? (state.x >= collision.x ? 1 : -1) : 0;
  return emit({
    ...state, phase: hits >= SURF_MAX_HITS ? 'sinking' : 'hurt', phaseMs: 0,
    hits, streak: 0, invulnerableMs: INVULNERABLE_MS,
    endReason: hits >= SURF_MAX_HITS ? 'injuries' : null,
    vx: collision ? away * 200 : state.vx * 0.35,
    feedback: collision ? 'collision' : 'wrong',
    obstacles: collision ? state.obstacles.map(obstacle => obstacle.id === collision.id ? { ...obstacle, hit: true } : obstacle) : state.obstacles,
  }, 'hurt');
}

function chaseMistake(state: SurfState): SurfState {
  const mistakes = state.chase.mistakes + 1;
  const attacking = mistakes >= SURF_CHASE_MAX_MISTAKES;
  const chase: SurfChase = { ...state.chase, mistakes, escapeStreak: 0,
    phase: attacking ? 'attacking' : state.chase.phase,
    phaseMs: attacking ? 0 : state.chase.phaseMs,
    targetGap: attacking ? 20 : Math.max(70, state.chase.targetGap - 90),
    boostMs: 0, action: 'close', actionMs: 0 };
  const next: SurfState = { ...state, phase: attacking ? 'sinking' : 'hurt', phaseMs: 0,
    endReason: attacking ? 'sea-monster' : null,
    chase, streak: 0, invulnerableMs: INVULNERABLE_MS, feedback: 'wrong', vx: state.vx * 0.35 };
  return emit({ ...next, speed: surfingSpeed(next) }, attacking ? 'sea-attack' : 'sea-approach');
}

export function submitSurf(state: SurfState): SurfState {
  if (state.phase !== 'surfing') return state;
  const answer = normalize(state.input);
  if (!answer) return { ...state, feedback: 'empty' };
  if (answer !== currentSurfWord(state).answer) return isChaseActive(state.chase) ? chaseMistake(state) : injure(state);
  const streak = state.streak + 1;
  const correct = state.correct + 1;
  let chase = state.chase;
  let event: SurfEvent['kind'] = 'correct';
  if (chase.phase === 'dormant' && correct === SURF_CHASE_TRIGGER) {
    chase = { ...chase, phase: 'warning', phaseMs: 0 };
    event = 'sea-warning';
  } else if (isChaseActive(chase)) {
    const escapeStreak = chase.escapeStreak + 1;
    const escaping = escapeStreak >= SURF_CHASE_ESCAPE_WORDS;
    chase = { ...chase, escapeStreak, phase: escaping ? 'retreating' : chase.phase,
      phaseMs: escaping ? 0 : chase.phaseMs,
      targetGap: escaping ? 950 : Math.min(650, chase.targetGap + 70),
      boostMs: SURF_CHASE_BOOST_MS, action: 'surge', actionMs: 0 };
    if (escaping) event = 'sea-escape';
  }
  const next: SurfState = {
    ...state, phase: 'cleared', phaseMs: 0, correct, chase,
    streak, bestStreak: Math.max(state.bestStreak, streak), score: state.score + 100,
    feedback: 'correct', invulnerableMs: Math.max(state.invulnerableMs, FEEDBACK_MS),
  };
  return emit({ ...next, speed: surfingSpeed(next) }, event);
}

export function pauseSurf(state: SurfState): SurfState {
  if (state.phase === 'ready' || state.phase === 'paused' || state.phase === 'over') return state;
  return { ...state, resumePhase: state.phase, phase: 'paused' };
}

export function resumeSurf(state: SurfState): SurfState {
  if (state.phase !== 'paused' || state.resumePhase === null) return state;
  return { ...state, phase: state.resumePhase, resumePhase: null };
}

/** A look-ahead planner picks coins, then reserves a clear side of the next island. */
function navigationTarget(state: SurfState): number {
  const lookAhead = Math.max(400, state.speed * 2.8);
  const coin = state.items.find(item => item.collectedAt === null && item.y > state.distance + 35 && item.y < state.distance + 260);
  let target = coin?.guideX ?? coin?.x ?? state.targetX;
  let obstacle: SurfObstacle | undefined;
  let priority = 0;
  const corridorLeft = Math.min(state.x, target) - HERO_RX;
  const corridorRight = Math.max(state.x, target) + HERO_RX;
  for (const island of state.obstacles) {
    if (island.hit || island.y + island.ry + HERO_RY + 20 <= state.distance
      || island.y - state.distance >= lookAhead) continue;
    const clearance = island.rx + HERO_RX + 58;
    const overlap = Math.min(corridorRight, island.x + clearance) - Math.max(corridorLeft, island.x - clearance);
    if (overlap <= 0) continue;
    // A shore barely touching the goal must not hide an island across the whole route.
    const threat = overlap / Math.max(90, island.y - state.distance + island.ry);
    if (threat > priority) { priority = threat; obstacle = island; }
  }
  if (obstacle) {
    const clearance = obstacle.rx + HERO_RX + 58;
    const left = clamp(obstacle.x - clearance, EDGE, SURF_WORLD_WIDTH - EDGE);
    const right = clamp(obstacle.x + clearance, EDGE, SURF_WORLD_WIDTH - EDGE);
    // Once committed, keep the same side until the whole board passes the island.
    const alreadyLeft = state.targetX <= obstacle.x - clearance + 20;
    const alreadyRight = state.targetX >= obstacle.x + clearance - 20;
    const committed = obstacle.y - state.distance < state.speed * 1.8;
    const side = obstacle.x - clearance < EDGE ? right
      : obstacle.x + clearance > SURF_WORLD_WIDTH - EDGE ? left
      : committed && state.x <= left + 20 ? left
      : committed && state.x >= right - 20 ? right
      : alreadyLeft ? left : alreadyRight ? right
      : Math.abs(left - state.x) + Math.abs(left - target) * 0.4
        <= Math.abs(right - state.x) + Math.abs(right - target) * 0.4 ? left : right;
    if (target > obstacle.x - clearance && target < obstacle.x + clearance
      || obstacle.y - state.distance < state.speed * 1.8) target = side;
  }
  return clamp(target, EDGE, SURF_WORLD_WIDTH - EDGE);
}

/** Wrong letters preserve the current heading: there is no hidden obstacle dodge. */
function steer(state: SurfState, seconds: number): { x: number; vx: number; targetX: number } {
  let targetX = state.targetX;
  let vx = state.vx;
  let x = state.x + vx * seconds;
  if (state.navigation === 'guided' && state.phase !== 'hurt') {
    targetX = navigationTarget(state);
    const targetSpeed = clamp((targetX - state.x) * 2.2, -MAX_STEER_SPEED, MAX_STEER_SPEED);
    const decay = Math.exp(-STEER_RESPONSE * seconds);
    vx = targetSpeed + (state.vx - targetSpeed) * decay;
    x = state.x + targetSpeed * seconds + (state.vx - targetSpeed) * (1 - decay) / STEER_RESPONSE;
  }
  const bounded = clamp(x, EDGE, SURF_WORLD_WIDTH - EDGE);
  return { x: bounded, vx: x !== bounded ? 0 : vx, targetX };
}

/** Sweep an expanded ellipse so neither a fast frame nor a narrow island tunnels. */
function collisionAlong(previous: SurfState, state: SurfState): SurfObstacle | undefined {
  if (state.invulnerableMs > 0 || state.phase !== 'surfing') return undefined;
  return state.obstacles.find(obstacle => {
    if (obstacle.hit) return false;
    const rx = obstacle.rx + HERO_RX;
    const ry = obstacle.ry + HERO_RY;
    const px = (previous.x - obstacle.x) / rx;
    const py = (previous.distance - obstacle.y) / ry;
    const dx = (state.x - previous.x) / rx;
    const dy = (state.distance - previous.distance) / ry;
    const lengthSquared = dx * dx + dy * dy;
    const along = lengthSquared === 0 ? 0 : clamp(-(px * dx + py * dy) / lengthSquared, 0, 1);
    return (px + dx * along) ** 2 + (py + dy * along) ** 2 <= 1;
  });
}

function collectCoins(previous: SurfState, state: SurfState): SurfState {
  const radius = surfMagnetRadius(state.correct);
  const dx = state.x - previous.x;
  const dy = state.distance - previous.distance;
  const lengthSquared = dx * dx + dy * dy;
  let count = 0;
  const items = state.items.map(coin => {
    if (coin.collectedAt !== null) return coin;
    const along = lengthSquared === 0 ? 0 : clamp(((coin.x - previous.x) * dx + (coin.y - previous.distance) * dy) / lengthSquared, 0, 1);
    if (Math.hypot(coin.x - previous.x - dx * along, coin.y - previous.distance - dy * along) > radius) return coin;
    count++;
    return { ...coin, collectedAt: state.elapsedMs };
  });
  if (!count) return state;
  // Impact/word feedback must not be replaced by a same-frame coin sound.
  const next = { ...state, items, coins: state.coins + count, score: state.score + count * 10 };
  return state.phase === 'surfing' ? emit(next, 'coin', count) : next;
}

function settleFeedback(state: SurfState): SurfState {
  if (state.phase === 'hurt' && state.phaseMs >= FEEDBACK_MS) return { ...state, phase: 'surfing', phaseMs: 0 };
  if (state.phase === 'cleared' && state.phaseMs >= FEEDBACK_MS) {
    if (state.checkpoint + 1 >= state.deck.length) return emit({ ...state, phase: 'over', phaseMs: 0,
      endReason: 'completed', feedback: 'over', navigation: 'waiting' }, 'over');
    return { ...state, phase: 'surfing', phaseMs: 0, wordElapsedMs: 0, checkpoint: state.checkpoint + 1,
      input: '', navigation: 'waiting', feedback: 'listen' };
  }
  if (state.phase === 'sinking' && state.phaseMs >= sinkDuration(state)) return emit({ ...state, phase: 'over', phaseMs: sinkDuration(state), feedback: 'over' }, 'over');
  return state;
}

/** Independent chase clocks advance only with the active simulation, never wall time. */
function tickChase(state: SurfState, deltaMs: number): SurfState {
  if (state.chase.phase === 'dormant') return state;
  let chase = { ...state.chase, phaseMs: state.chase.phaseMs + deltaMs,
    boostMs: Math.max(0, state.chase.boostMs - deltaMs) };
  if (chase.action !== 'follow') {
    chase.actionMs += deltaMs;
    if (chase.actionMs >= SURF_CHASE_ACTION_MS) { chase.action = 'follow'; chase.actionMs = 0; }
  }
  const response = chase.phase === 'attacking' ? 2.8 : chase.phase === 'retreating' ? 2 : 1.6;
  chase.gap = chase.targetGap + (chase.gap - chase.targetGap) * Math.exp(-response * deltaMs / 1000);
  if (chase.phase === 'warning' && chase.phaseMs >= SURF_CHASE_WARNING_MS) {
    chase = { ...chase, phase: 'chasing', phaseMs: chase.phaseMs - SURF_CHASE_WARNING_MS };
  } else if (chase.phase === 'retreating' && chase.phaseMs >= SURF_CHASE_RETREAT_MS) {
    chase = { ...chase, phase: 'escaped', phaseMs: chase.phaseMs - SURF_CHASE_RETREAT_MS, action: 'follow', actionMs: 0 };
  }
  const next = { ...state, chase };
  return { ...next, speed: surfingSpeed(next) };
}

/** Continuous sea movement. Typing changes the planner; no gates interrupt the run. */
export function tickSurf(state: SurfState, deltaMs: number, _controls?: SurfControls): SurfState {
  if (state.phase === 'ready' || state.phase === 'paused' || state.phase === 'over'
    || !Number.isFinite(deltaMs) || deltaMs <= 0) return state;
  let next = state;
  let remaining = Math.min(deltaMs, MAX_TICK_MS);
  while (remaining > 1e-8) {
    next = settleFeedback(next);
    if (next.phase === 'over') break;
    const feedbackDuration = next.phase === 'sinking' ? sinkDuration(next) : FEEDBACK_MS;
    const timed = next.phase === 'hurt' || next.phase === 'cleared' || next.phase === 'sinking';
    const step = Math.min(remaining, SIMULATION_STEP_MS, timed ? feedbackDuration - next.phaseMs : Infinity,
      next.chase.boostMs > 0 ? next.chase.boostMs : Infinity);
    const previous = next;
    next = { ...next, phaseMs: next.phaseMs + step, elapsedMs: next.elapsedMs + step,
      wordElapsedMs: next.wordElapsedMs === undefined ? undefined : next.wordElapsedMs + (next.phase === 'surfing' ? step : 0),
      invulnerableMs: Math.max(0, next.invulnerableMs - step) };
    if (next.phase !== 'sinking') {
      const pace = next.phase === 'hurt' ? 0.25 : 1;
      next = maintainSurfCourse({ ...next, ...steer(previous, step / 1_000),
        distance: previous.distance + step * next.speed * pace / 1_000 });
      const collision = collisionAlong(previous, next);
      if (collision) next = injure(next, collision);
      if (next.phase !== 'sinking') next = collectCoins(previous, next);
    }
    next = tickChase(next, step);
    next = settleFeedback(next);
    remaining -= step;
  }
  return next;
}
