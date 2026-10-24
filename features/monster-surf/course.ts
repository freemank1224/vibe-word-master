import type { SurfCoin, SurfCoinFormation, SurfObstacle, SurfState } from './types.ts';
import { SURF_ISLAND_ART } from './islandArt.ts';
import { SURF_RIDER_COLLISION_RX, SURF_RIDER_COLLISION_RY } from './constants.ts';

const FIRST_ISLAND = 1050;
const ISLAND_GAP = 670;
export const SURF_COIN_SECTION_LENGTH = 600;
const COIN_ID_STRIDE = 32;
// Alternate edge islets halfway between main islands. The original independent
// spacing eventually overlapped two enlarged land footprints in the same water.
const MARGIN_GAP = ISLAND_GAP / 2;
const FIRST_MARGIN = FIRST_ISLAND - MARGIN_GAP * 2.5;
const RETAIN_BEHIND = 2600;
const SPAWN_AHEAD = 2400;
const ISLAND_X = [500, 290, 720, 430, 650, 245, 755, 515];
const MAIN_VARIANTS = [3, 4, 5, 6, 7, 3, 5, 4];
const MARGIN_VARIANTS = [0, 1, 2];
const ROUTE_X = [265, 545, 440, 700, 350, 520, 470, 755];

export function courseObstacle(id: number): SurfObstacle {
  const index = id % ISLAND_X.length;
  const variant = MAIN_VARIANTS[index];
  const art = SURF_ISLAND_ART[variant];
  return { id, x: ISLAND_X[index], y: FIRST_ISLAND + id * ISLAND_GAP,
    rx: art.collisionRx, ry: art.collisionRy, variant, hit: false };
}

/** Shores use native small-island art, never shrunken versions of the village islands. */
export function courseMarginObstacle(index: number): SurfObstacle {
  const variant = MARGIN_VARIANTS[index % MARGIN_VARIANTS.length];
  const art = SURF_ISLAND_ART[variant];
  const inset = [92, 88, 124, 116, 76, 104, 110, 80][index % 8];
  return { id: -index - 1, x: index % 2 === 0 ? inset : 1000 - inset,
    y: FIRST_MARGIN + index * MARGIN_GAP,
    rx: art.collisionRx, ry: art.collisionRy, variant, hit: false };
}

/** The coin ribbon threads the open side of each island, with gently curved links. */
function routeX(y: number): number {
  if (y < FIRST_ISLAND) {
    const t = Math.min(1, y / FIRST_ISLAND);
    return 500 + (ROUTE_X[0] - 500) * (t * t * (3 - 2 * t));
  }
  const section = Math.floor((y - FIRST_ISLAND) / ISLAND_GAP);
  const t = ((y - FIRST_ISLAND) % ISLAND_GAP) / ISLAND_GAP;
  const eased = t * t * (3 - 2 * t);
  const from = ROUTE_X[section % ROUTE_X.length];
  return from + (ROUTE_X[(section + 1) % ROUTE_X.length] - from) * eased;
}

interface CoinPoint { x: number; y: number; }

function seeded(index: number): number {
  const hash = Math.imul(index + 11, 0x45d9f3b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 0x100000000;
}

/** Native formations are not rows visited left-to-right; their guide is the middle. */
function formationPoints(section: number): { kind: SurfCoinFormation; points: CoinPoint[] } {
  const kind = (['matrix', 'diamond', 'arc', 'matrix', 'fan'] as const)[section % 5];
  const points: CoinPoint[] = [];
  if (kind === 'matrix') {
    const rows = section % 5 === 3 ? 4 : 3;
    for (let row = 0; row < rows; row++) for (let column = 0; column < 3; column++) {
      points.push({ x: (column - 1) * 44, y: (row - (rows - 1) / 2) * 46 });
    }
  } else if (kind === 'diamond') {
    const counts = [1, 2, 3, 2, 1];
    for (let row = 0; row < counts.length; row++) for (let column = 0; column < counts[row]; column++) {
      points.push({ x: (column - (counts[row] - 1) / 2) * 46, y: (row - 2) * 40 });
    }
  } else if (kind === 'arc') {
    const direction = seeded(section) > 0.5 ? 1 : -1;
    for (let index = 0; index < 7; index++) {
      const angle = (index / 6 - 0.5) * 2.5;
      points.push({ x: Math.sin(angle) * 105, y: direction * (Math.cos(angle) * 78 - 45) });
    }
  } else {
    for (let row = 0; row < 4; row++) {
      const columns = row * 2 + 1;
      for (let column = 0; column < columns; column++) {
        points.push({ x: (column - (columns - 1) / 2) * 38, y: (row - 1.5) * 42 });
      }
    }
  }
  return { kind, points };
}

function nearbyObstacles(y: number): SurfObstacle[] {
  const main = Math.floor((y - FIRST_ISLAND) / ISLAND_GAP);
  const shore = Math.floor((y - FIRST_MARGIN) / MARGIN_GAP);
  const obstacles: SurfObstacle[] = [];
  for (let id = Math.max(0, main - 1); id <= main + 2; id++) obstacles.push(courseObstacle(id));
  for (let index = Math.max(0, shore - 2); index <= shore + 2; index++) obstacles.push(courseMarginObstacle(index));
  return obstacles;
}

function safeCoin(point: CoinPoint, obstacles: SurfObstacle[]): boolean {
  return point.x >= 150 && point.x <= 850 && obstacles.every(obstacle =>
    ((point.x - obstacle.x) / (obstacle.rx + SURF_RIDER_COLLISION_RX + 6)) ** 2
      + ((point.y - obstacle.y) / (obstacle.ry + SURF_RIDER_COLLISION_RY + 6)) ** 2 > 1);
}

/** Seeded clusters sit in clear water; all columns share a stable navigation spine. */
export function courseCoins(section: number): SurfCoin[] {
  const start = section * SURF_COIN_SECTION_LENGTH;
  const baseY = start + (section === 0 ? 130 : 250);
  const { kind, points } = formationPoints(section);
  const obstacles = nearbyObstacles(baseY);
  const preferred = Math.max(300, Math.min(700, routeX(baseY) + (section === 0 ? 0 : (seeded(section + 31) - 0.5) * 30)));
  const candidates = [preferred, preferred - 50, preferred + 50, preferred - 100, preferred + 100,
    500, 350, 650, 275, 725];
  const heights = section === 0 ? [baseY] : [baseY, start + 190, start + 310, start + 150, start + 350];
  let placement: CoinPoint | undefined;
  for (const y of heights) {
    const x = candidates.find(candidate => points.every(point => safeCoin({ x: candidate + point.x, y: y + point.y }, obstacles)));
    if (x !== undefined) { placement = { x, y }; break; }
  }
  // Search the open water without dropping columns or changing the native shape.
  if (!placement) {
    search: for (let y = start + 150; y <= start + 350; y += 10) {
      for (let x = 250; x <= 750; x += 10) {
        if (points.every(point => safeCoin({ x: x + point.x, y: y + point.y }, obstacles))) { placement = { x, y }; break search; }
      }
    }
  }
  if (!placement) throw new Error(`No safe coin formation for section ${section}`);
  const center = placement;
  const arranged = points.map(point => ({ x: center.x + point.x, y: center.y + point.y, formation: kind, guideX: center.x }));
  const firstY = Math.min(...arranged.map(coin => coin.y));
  const lastY = Math.max(...arranged.map(coin => coin.y));
  const incoming = firstY - start >= 120 ? [35, 75] : [35];
  const outgoingCount = 5 - incoming.length;
  const outgoingStart = lastY + 55;
  const ribbonY = [...incoming.map(offset => start + offset), ...Array.from({ length: outgoingCount }, (_, index) =>
    outgoingStart + (start + 550 - outgoingStart) * index / (outgoingCount - 1))];
  for (const y of ribbonY) {
    const x = routeX(y);
    arranged.push({ x, y, formation: 'ribbon', guideX: x });
  }
  arranged.sort((left, right) => left.y - right.y || left.x - right.x);
  return arranged.map((coin, index) => ({ ...coin, id: section * COIN_ID_STRIDE + index,
    group: section, collectedAt: null }));
}

/** Only a bounded active part of the endless sea exists, even with a huge magnet. */
export function maintainSurfCourse(state: SurfState): SurfState {
  const firstSection = Math.max(0, Math.floor((state.distance - RETAIN_BEHIND) / SURF_COIN_SECTION_LENGTH));
  const lastSection = Math.floor((state.distance + SPAWN_AHEAD) / SURF_COIN_SECTION_LENGTH);
  const firstIsland = Math.max(0, Math.ceil((state.distance - RETAIN_BEHIND - FIRST_ISLAND) / ISLAND_GAP));
  const lastIsland = Math.floor((state.distance + SPAWN_AHEAD - FIRST_ISLAND) / ISLAND_GAP);
  const firstMargin = Math.max(0, Math.ceil((state.distance - RETAIN_BEHIND - FIRST_MARGIN) / MARGIN_GAP));
  const lastMargin = Math.floor((state.distance + SPAWN_AHEAD - FIRST_MARGIN) / MARGIN_GAP);
  const coinsUnchanged = state.items[0]?.group === firstSection && state.items.at(-1)?.group === lastSection;
  const islandsUnchanged = state.obstacles.length === lastIsland - firstIsland + lastMargin - firstMargin + 2
    && [firstIsland, lastIsland, -firstMargin - 1, -lastMargin - 1].every(id => state.obstacles.some(obstacle => obstacle.id === id));
  if (coinsUnchanged && islandsUnchanged) return state;
  let items = state.items;
  let obstacles = state.obstacles;
  if (!coinsUnchanged) {
    const existing = new Map(state.items.map(coin => [coin.id, coin]));
    items = [];
    for (let section = firstSection; section <= lastSection; section++) {
      for (const coin of courseCoins(section)) items.push(existing.get(coin.id) ?? coin);
    }
  }
  if (!islandsUnchanged) {
    const existing = new Map(state.obstacles.map(obstacle => [obstacle.id, obstacle]));
    obstacles = [];
    for (let id = firstIsland; id <= lastIsland; id++) obstacles.push(existing.get(id) ?? courseObstacle(id));
    for (let index = firstMargin; index <= lastMargin; index++) obstacles.push(existing.get(-index - 1) ?? courseMarginObstacle(index));
    obstacles.sort((left, right) => left.y - right.y);
  }
  return { ...state, items, obstacles };
}
