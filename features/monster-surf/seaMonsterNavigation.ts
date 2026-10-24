import type { SurfObstacle } from './types.ts';

export interface SeaMonsterPoint { x: number; y: number; }
export interface SeaMonsterFootprint { rx: number; ry: number; }
/** Limits for the actor's centre, after the caller accounts for its body width. */
export interface SeaMonsterBounds { minX: number; maxX: number; }
export interface SeaMonsterNavigationOptions {
  position: SeaMonsterPoint;
  target: SeaMonsterPoint;
  obstacles: readonly SurfObstacle[];
  footprint: SeaMonsterFootprint;
  bounds: SeaMonsterBounds;
  maxDistance: number;
  /** Only spawn/viewport resizing may relocate an actor already inside land. */
  allowRelocate?: boolean;
}
export interface SeaMonsterNavigationResult {
  position: SeaMonsterPoint;
  target: SeaMonsterPoint;
  route: SeaMonsterPoint[];
  blocked: boolean;
  relocated: boolean;
  navigation: 'direct' | 'detour' | 'waiting';
  /** Minimum squared distance in expanded-ellipse coordinates; >= 1 is clear. */
  clearance: number;
}

const MARGIN = 2;
const VERTICES = 20;
const EPSILON = 1e-7;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const distance = (a: SeaMonsterPoint, b: SeaMonsterPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const bounded = (point: SeaMonsterPoint, bounds: SeaMonsterBounds) => ({ ...point, x: clamp(point.x, bounds.minX, bounds.maxX) });
const radii = (island: SurfObstacle, footprint: SeaMonsterFootprint) => ({
  rx: island.rx + Math.max(0, footprint.rx) + MARGIN,
  ry: island.ry + Math.max(0, footprint.ry) + MARGIN,
});

export function seaMonsterClearance(point: SeaMonsterPoint, obstacles: readonly SurfObstacle[], footprint: SeaMonsterFootprint): number {
  let clearance = Infinity;
  for (const island of obstacles) {
    const { rx, ry } = radii(island, footprint);
    clearance = Math.min(clearance, ((point.x - island.x) / rx) ** 2 + ((point.y - island.y) / ry) ** 2);
  }
  return clearance;
}

export function isSeaMonsterPointClear(point: SeaMonsterPoint, obstacles: readonly SurfObstacle[], footprint: SeaMonsterFootprint, bounds: SeaMonsterBounds): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= bounds.minX && point.x <= bounds.maxX
    && seaMonsterClearance(point, obstacles, footprint) >= 1;
}

/** Exact swept-ellipse check. A clear endpoint alone never permits a land crossing. */
export function isSeaMonsterSegmentClear(from: SeaMonsterPoint, to: SeaMonsterPoint, obstacles: readonly SurfObstacle[], footprint: SeaMonsterFootprint, bounds: SeaMonsterBounds): boolean {
  if (![from.x, from.y, to.x, to.y].every(Number.isFinite)
    || Math.min(from.x, to.x) < bounds.minX || Math.max(from.x, to.x) > bounds.maxX) return false;
  for (const island of obstacles) {
    const { rx, ry } = radii(island, footprint);
    if (Math.min(from.x, to.x) > island.x + rx || Math.max(from.x, to.x) < island.x - rx
      || Math.min(from.y, to.y) > island.y + ry || Math.max(from.y, to.y) < island.y - ry) continue;
    const px = (from.x - island.x) / rx;
    const py = (from.y - island.y) / ry;
    const dx = (to.x - from.x) / rx;
    const dy = (to.y - from.y) / ry;
    const lengthSquared = dx * dx + dy * dy;
    const along = lengthSquared > 0 ? clamp(-(px * dx + py * dy) / lengthSquared, 0, 1) : 0;
    if ((px + dx * along) ** 2 + (py + dy * along) ** 2 < 1) return false;
  }
  return true;
}

/** Circumscribed vertices keep every adjacent chord outside the true ellipse. */
function shorePoints(island: SurfObstacle, footprint: SeaMonsterFootprint): SeaMonsterPoint[] {
  const { rx, ry } = radii(island, footprint);
  const outside = 1 / Math.cos(Math.PI / VERTICES) + 0.006;
  return Array.from({ length: VERTICES }, (_, index) => {
    const angle = index / VERTICES * Math.PI * 2;
    return { x: island.x + Math.cos(angle) * rx * outside, y: island.y + Math.sin(angle) * ry * outside };
  });
}

/** Used to project an aim point, and explicitly for spawn/resize placement only. */
export function findSeaMonsterWaterPoint(point: SeaMonsterPoint, obstacles: readonly SurfObstacle[], footprint: SeaMonsterFootprint, bounds: SeaMonsterBounds): SeaMonsterPoint | null {
  const aim = bounded(point, bounds);
  if (isSeaMonsterPointClear(aim, obstacles, footprint, bounds)) return aim;
  const candidates = obstacles.flatMap(island => shorePoints(island, footprint));
  // At a shoreline clipped by the viewport, also consider its intersection with
  // the permitted centre boundary, instead of squeezing through a closed gap.
  for (const island of obstacles) {
    const { rx, ry } = radii(island, footprint);
    for (const x of [bounds.minX, bounds.maxX]) {
      const dx = (x - island.x) / rx;
      if (Math.abs(dx) <= 1) for (const direction of [-1, 1]) {
        candidates.push({ x, y: island.y + direction * (ry * Math.sqrt(1 - dx * dx) + MARGIN) });
      }
    }
  }
  // A row of overlapping islands may cover each other's local perimeter points.
  // Points beyond the whole row give placement a deterministic, safe fallback.
  if (obstacles.length) {
    const top = Math.min(...obstacles.map(island => island.y - radii(island, footprint).ry)) - MARGIN;
    const bottom = Math.max(...obstacles.map(island => island.y + radii(island, footprint).ry)) + MARGIN;
    candidates.push({ x: aim.x, y: top }, { x: aim.x, y: bottom });
  }
  let nearest: SeaMonsterPoint | null = null;
  let best = Infinity;
  for (const candidate of candidates) {
    if (!isSeaMonsterPointClear(candidate, obstacles, footprint, bounds)) continue;
    const length = distance(candidate, aim);
    if (length < best) { best = length; nearest = candidate; }
  }
  return nearest;
}

function findRoute(from: SeaMonsterPoint, target: SeaMonsterPoint, obstacles: readonly SurfObstacle[], footprint: SeaMonsterFootprint, bounds: SeaMonsterBounds): SeaMonsterPoint[] {
  if (isSeaMonsterSegmentClear(from, target, obstacles, footprint, bounds)) return [target];
  const reach = Math.max(300, ...obstacles.map(island => radii(island, footprint).ry * 2));
  const lowY = Math.min(from.y, target.y) - reach;
  const highY = Math.max(from.y, target.y) + reach;
  const points = [from, target, ...obstacles.filter(island => island.y >= lowY && island.y <= highY)
    .flatMap(island => shorePoints(island, footprint))
    .filter(point => isSeaMonsterPointClear(point, obstacles, footprint, bounds))];
  const costs = points.map(() => Infinity);
  const parents = points.map(() => -1);
  const visited = points.map(() => false);
  costs[0] = 0;
  for (let iteration = 0; iteration < points.length; iteration++) {
    let current = -1;
    for (let i = 0; i < points.length; i++) {
      if (!visited[i] && (current < 0 || costs[i] < costs[current])) current = i;
    }
    if (current < 0 || !Number.isFinite(costs[current])) return [];
    if (current === 1) {
      const path: SeaMonsterPoint[] = [];
      for (let cursor = 1; cursor !== 0; cursor = parents[cursor]) path.unshift(points[cursor]);
      return path;
    }
    visited[current] = true;
    for (let next = 0; next < points.length; next++) {
      if (visited[next]) continue;
      const cost = costs[current] + distance(points[current], points[next]);
      if (cost >= costs[next] || !isSeaMonsterSegmentClear(points[current], points[next], obstacles, footprint, bounds)) continue;
      costs[next] = cost; parents[next] = current;
    }
  }
  return [];
}

export function createSeaMonsterNavigator() {
  let route: SeaMonsterPoint[] = [];
  let lastNavigation: SeaMonsterNavigationResult['navigation'] = 'waiting';
  let lastBlocked = false;
  return {
    reset() { route = []; lastNavigation = 'waiting'; lastBlocked = false; },
    step(options: SeaMonsterNavigationOptions): SeaMonsterNavigationResult {
      const { obstacles, footprint, bounds } = options;
      let position = { ...options.position };
      let relocated = false;
      const result = (target: SeaMonsterPoint, blocked: boolean, navigation: SeaMonsterNavigationResult['navigation']): SeaMonsterNavigationResult => {
        lastBlocked = blocked; lastNavigation = navigation;
        return { position, target, route: route.map(point => ({ ...point })), blocked, relocated, navigation,
          clearance: seaMonsterClearance(position, obstacles, footprint) };
      };
      // A paused step is an identity operation, including during pending resize.
      if (!Number.isFinite(options.maxDistance) || options.maxDistance <= 0) return result(options.target, lastBlocked, lastNavigation);
      if (!isSeaMonsterPointClear(position, obstacles, footprint, bounds)) {
        if (!options.allowRelocate) { route = []; return result(options.target, true, 'waiting'); }
        const water = findSeaMonsterWaterPoint(position, obstacles, footprint, bounds);
        if (!water) { route = []; return result(options.target, true, 'waiting'); }
        position = water; route = []; relocated = true;
      }
      const target = findSeaMonsterWaterPoint(options.target, obstacles, footprint, bounds);
      if (!target) { route = []; return result(options.target, true, 'waiting'); }
      while (route.length && distance(position, route[0]) < EPSILON) route.shift();
      const direct = isSeaMonsterSegmentClear(position, target, obstacles, footprint, bounds);
      if (direct) route = [target];
      else {
        // Retain a safe turn already underway so a moving target cannot flip the
        // actor between the left and right sides of the same island every frame.
        const first = route[0];
        let valid = Boolean(first) && isSeaMonsterSegmentClear(position, first, obstacles, footprint, bounds);
        if (valid) {
          const candidate = [...route.slice(0, -1), target];
          let previous = position;
          for (const point of candidate) {
            if (!isSeaMonsterSegmentClear(previous, point, obstacles, footprint, bounds)) { valid = false; break; }
            previous = point;
          }
          if (valid) route = candidate;
        }
        if (!valid) {
          const committed = first && isSeaMonsterPointClear(first, obstacles, footprint, bounds)
            && isSeaMonsterSegmentClear(position, first, obstacles, footprint, bounds);
          const onward = committed ? findRoute(first, target, obstacles, footprint, bounds) : [];
          route = onward.length ? [first, ...onward] : findRoute(position, target, obstacles, footprint, bounds);
        }
      }
      if (!route.length) return result(target, true, 'waiting');
      let remaining = options.maxDistance;
      while (route.length && remaining > EPSILON) {
        const waypoint = route[0];
        const length = distance(position, waypoint);
        if (length < EPSILON) { route.shift(); continue; }
        const fraction = Math.min(1, remaining / length);
        const next = { x: position.x + (waypoint.x - position.x) * fraction, y: position.y + (waypoint.y - position.y) * fraction };
        if (!isSeaMonsterSegmentClear(position, next, obstacles, footprint, bounds)) { route = []; return result(target, true, 'waiting'); }
        position = next; remaining -= length * fraction;
        if (fraction === 1) route.shift();
        // Renderers interpolate only between frame endpoints. Stop at a corner
        // even after a long frame, rather than visually cutting its landward chord.
        break;
      }
      return result(target, false, direct ? 'direct' : 'detour');
    },
  };
}
