import { SURF_HERO_Y, SURF_WORLD_WIDTH, SURF_RIDER_SCALE, SURF_MAX_VISIBLE_GULLS, surfMagnetRadius } from './constants.ts';
import { createSeaMonsterRenderer, seaChaseCameraOffset, seaNavigationCameraOffset } from './seaMonsterRenderer.ts';
import { INKFIN_CROPS } from './seaMonsterArt.ts';
import { SURF_CHARACTER_CROPS } from './surfCharacterArt.ts';
import { chooseSurfPose, smoothSurfHeading, SURF_POSE_INDEX, type SurfPose } from './surfPose.ts';
import { SURF_GULL_CROPS } from './art.ts';
import { SURF_ISLAND_ART, SURF_ISLAND_SOURCE_TO_WORLD } from './islandArt.ts';
import type { SurfObstacle, SurfRenderer, SurfState } from './types';

const TAU = Math.PI * 2;
const GULL_WINGSPAN = Math.max(1, ...SURF_GULL_CROPS.map(crop => crop.width));
const GULL_FLAP_SEQUENCE = [0, 3, 1, 2, 1, 3];
// Body anchors keep folded and extended wings at the same physical scale.
const GULL_BODY_ANCHORS = [0.74, 0.57, 0.45, 0.70];
const clamp = (n: number, min = 0, max = 1) => Math.max(min, Math.min(max, n));
const random = (n: number) => { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
type WakePoint = { x: number; distance: number; time: number };
type CrystalBurst = { group: number; count: number; bornAt: number; updatedAt: number };

/** Original Canvas 2D ocean art. This module never changes game state or awards pickups. */
export function createSurfRenderer(
  canvas: HTMLCanvasElement,
  sprites: HTMLImageElement[],
  environment?: HTMLImageElement,
  gullSprite?: HTMLImageElement,
  seaMonsterSprite?: HTMLImageElement,
): SurfRenderer {
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return { render: () => undefined, destroy: () => undefined };
  const ctx = context;
  const seaMonster = createSeaMonsterRenderer(ctx, seaMonsterSprite);
  let width = 1000;
  let height = 580;
  let unit = 1;
  let heroY = 220;
  let disposed = false;
  let wake: WakePoint[] = [];
  let previousTime = 0;
  let previousDistance = 0;
  let lastWake = -100;
  let sceneTime = 0;
  let readyStarted = performance.now();
  let wasReady = true;
  let gullArrivals: number[] = [];
  let previousGullCount = 0;
  let smoothedHeading = 0;
  let selectedPose: SurfPose = 'straight';
  let previousMonster = -1;
  let previousCrystals = 0;
  let crystalBursts: CrystalBurst[] = [];
  let navigationCameraOffset = 0;

  function ellipse(x: number, y: number, rx: number, ry: number, fill: string, rotation = 0) {
    ctx.beginPath(); ctx.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), rotation, 0, TAU);
    ctx.fillStyle = fill; ctx.fill();
  }
  function line(points: number[], stroke: string, lineWidth: number) {
    ctx.beginPath(); ctx.moveTo(points[0], points[1]);
    for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
    ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke();
  }
  function polygon(points: number[], fill: string, stroke?: string, lineWidth = 1) {
    ctx.beginPath(); ctx.moveTo(points[0], points[1]);
    for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
  }
  const screenY = (worldY: number, state: SurfState) => heroY + (worldY - state.distance) * unit;
  // Attached effects share the character's physical scale, independently of world projection.
  const riderPaintUnit = () => Math.min(1.1, Math.max(0.85, unit)) * SURF_RIDER_SCALE;
  const setCanvasData = (name: string, value: string) => { if (canvas.dataset[name] !== value) canvas.dataset[name] = value; };

  function water(state: SurfState, reduced: boolean) {
    const sea = ctx.createLinearGradient(0, 0, width, height);
    sea.addColorStop(0, '#6CD7E3'); sea.addColorStop(0.48, '#75DFE7'); sea.addColorStop(1, '#42C4D8');
    ctx.fillStyle = sea; ctx.fillRect(0, 0, width, height);
    // Soft shoals at the margins keep the sailing corridor clear and readable.
    for (const side of [-0.07, 1.07]) {
      const shoal = ctx.createRadialGradient(width * side, height * 0.53, 0, width * side, height * 0.53, width * 0.34);
      shoal.addColorStop(0, '#B0F3D981'); shoal.addColorStop(0.6, '#A5EFD534'); shoal.addColorStop(1, '#88DFD900');
      ctx.fillStyle = shoal; ctx.fillRect(0, 0, width, height);
    }
    const start = Math.floor((state.distance - heroY / unit) / 73) - 1;
    const end = Math.ceil((state.distance + (height - heroY) / unit) / 73) + 1;
    for (let row = start; row <= end; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const seed = row * 19 + col * 7;
        const x = (col * 143 + random(seed) * 72 - 30) * unit;
        const y = screenY(row * 73 + random(seed + 9) * 35, state);
        const length = (14 + random(seed + 3) * 37) * unit;
        const drift = reduced ? 0 : Math.sin(sceneTime * 0.8 + seed) * 2;
        const alpha = 0.20 + random(seed + 13) * 0.21;
        ctx.lineCap = 'round';
        line([x, y + drift, x + length * 0.27, y + drift + 2 * unit, x + length * 0.66, y + drift + 2 * unit, x + length, y + drift], `rgba(231,255,252,${alpha})`, 2 * unit);
        if (col % 3 === 0) line([x + 7 * unit, y + 5 * unit, x + length * 0.7, y + 5 * unit], '#229DBA18', unit);
        if (random(seed + 43) > 0.55) ellipse(x + length + 12 * unit, y + 11 * unit, 1.2 * unit, 1 * unit, '#D5FBF77A');
      }
    }
    ctx.lineCap = 'round';
  }

  function underwaterPlants(state: SurfState, reduced: boolean) {
    const first = Math.floor((state.distance - heroY / unit - 100) / 225);
    const last = Math.ceil((state.distance + (height - heroY) / unit + 100) / 225);
    // These submerged plants are water detail, not solid scenery.
    for (let row = first; row <= last; row += 1) {
      for (let side = 0; side < 2; side += 1) {
        const seed = row * 37 + side * 53;
        const x = (side === 0 ? 40 + random(seed) * 70 : 890 + random(seed) * 70) * unit;
        const y = screenY(row * 225 + random(seed + 2) * 100, state);
        ctx.save(); ctx.globalAlpha = 0.13;
        for (let i = 0; i < 5; i += 1) {
          const sway = reduced ? 0 : Math.sin(sceneTime + i) * 4 * unit;
          line([x + (i - 2) * 4 * unit, y, x + (i - 2) * 8 * unit + sway, y - 10 * unit, x + (i - 2) * 7 * unit + sway, y - (17 + random(seed + i) * 11) * unit], '#237C88', 3.2 * unit);
        }
        ctx.restore();
      }
    }
  }

  function obstacle(item: SurfObstacle, state: SurfState, reduced: boolean) {
    const art = SURF_ISLAND_ART[item.variant % SURF_ISLAND_ART.length];
    if (!art) return;
    const x = item.x * unit;
    const y = screenY(item.y, state);
    const rx = art.collisionRx * unit;
    const ry = art.collisionRy * unit;
    const { crop } = art;
    // Trees and buildings share one source-to-world scale across every island.
    // Native artwork supplies the extra land and objects on a larger island.
    const sourceScale = SURF_ISLAND_SOURCE_TO_WORLD * unit;
    const spriteWidth = crop.width * sourceScale;
    const spriteHeight = crop.height * sourceScale;
    const left = x - art.anchorX * sourceScale;
    const top = y - art.anchorY * sourceScale;
    if (top > height + 30 || top + spriteHeight < -30 || left > width + 30 || left + spriteWidth < -30) return;
    ctx.save();
    if (environment?.complete && environment.naturalWidth > 0) {
      // The native coastline includes its own shoals and foam, including inlets.
      ctx.drawImage(environment, crop.x, crop.y, crop.width, crop.height,
        left, top, spriteWidth, spriteHeight);
    } else {
      // A compact loading fallback; the playable scene uses the generated island atlas.
      const ripple = reduced ? 0 : Math.sin(sceneTime * 1.6 + item.id) * unit;
      ellipse(x, y + ripple, rx * 1.06, ry * 1.06, '#B8F6E96A');
      ellipse(x, y, rx, ry, '#E8C78B');
      ellipse(x - rx * 0.08, y - ry * 0.1, rx * 0.87, ry * 0.81, '#F5DEA3');
    }
    const actionPhase = state.phase === 'paused' ? state.resumePhase : state.phase;
    if (item.hit && (actionPhase === 'hurt' || actionPhase === 'sinking') && state.phaseMs < 180) {
      ctx.beginPath(); ctx.ellipse(x, y, rx * 1.04, ry * 1.04, 0, 0, TAU);
      ctx.strokeStyle = `rgba(255,112,94,${(1 - state.phaseMs / 180) * 0.6})`;
      ctx.lineWidth = 3 * unit; ctx.stroke();
    }
    ctx.restore();
  }

  /** Sea Crystals are run pickups; the legacy state.coins counter is not wallet currency. */
  function crystal(x: number, y: number, size: number, shine: number, alpha = 1) {
    ctx.save(); ctx.globalAlpha *= alpha;
    ellipse(x + unit, y + size * 0.85, size * 0.7, size * 0.22, '#276C972E');
    // A faceted silhouette stays legible against the sea without resembling a gold coin.
    const face = 0.94 + Math.cos(shine) * 0.06;
    const left = x - size * 0.79 * face;
    const right = x + size * 0.79 * face;
    const crownY = y - size * 0.35;
    const topY = y - size * 0.94;
    const bottomY = y + size;
    polygon([left, crownY, x - size * 0.38 * face, topY, x + size * 0.38 * face, topY,
      right, crownY, x, bottomY], '#815CE9', '#3A4C91', Math.max(1, size * 0.13));
    polygon([left, crownY, x - size * 0.38 * face, topY, x, crownY], '#B8FFFF');
    polygon([x - size * 0.38 * face, topY, x + size * 0.38 * face, topY, x, crownY], '#F2FFFE');
    polygon([x + size * 0.38 * face, topY, right, crownY, x, crownY], '#52EAF0');
    polygon([left, crownY, x, crownY, x, bottomY], '#44BBDD');
    polygon([x, crownY, right, crownY, x, bottomY], '#8172EC');
    line([left, crownY, right, crownY], '#C2FEFFB3', Math.max(0.7, size * 0.07));
    // Sparse, short glints keep large matrices readable instead of blinking as one mass.
    const shimmer = Math.max(0, Math.sin(shine)) ** 12;
    if (shimmer > 0.2) {
      const starX = right - size * 0.12;
      const starY = topY + size * 0.12;
      const length = size * (0.15 + shimmer * 0.24);
      ctx.globalAlpha *= shimmer;
      line([starX - length, starY, starX + length, starY], '#FFFFFF', Math.max(0.7, size * 0.09));
      line([starX, starY - length, starX, starY + length], '#FFFFFF', Math.max(0.7, size * 0.09));
    }
    ctx.restore();
  }

  function updateCrystalBursts(state: SurfState, reset: boolean) {
    if (reset || state.coins < previousCrystals) {
      crystalBursts = []; previousCrystals = state.coins; return;
    }
    crystalBursts = crystalBursts.filter(burst => state.elapsedMs - burst.updatedAt < 850);
    const gained = state.coins - previousCrystals;
    previousCrystals = state.coins;
    if (gained < 1) return;
    const groups = new Map<number, number>();
    for (const item of state.items) {
      if (item.collectedAt === null || item.collectedAt <= previousTime || item.collectedAt > state.elapsedMs) continue;
      const group = item.group ?? -1;
      groups.set(group, (groups.get(group) ?? 0) + 1);
    }
    if (groups.size === 0) groups.set(-1, gained);
    for (const [group, count] of groups) {
      const recent = crystalBursts.find(burst => burst.group === group && state.elapsedMs - burst.updatedAt < 260 && state.elapsedMs - burst.bornAt < 1500);
      if (recent) { recent.count += count; recent.updatedAt = state.elapsedMs; }
      else crystalBursts.push({ group, count, bornAt: state.elapsedMs, updatedAt: state.elapsedMs });
    }
    crystalBursts = crystalBursts.slice(-3);
  }

  function crystals(state: SurfState, reduced: boolean) {
    const hx = state.x * unit;
    const artUnit = Math.min(1.1, Math.max(0.85, unit));
    let flights = 0;
    let trails = 0;
    for (const item of state.items) {
      let x = item.x * unit;
      let y = screenY(item.y, state);
      let alpha = 1;
      let radius = 8.5 * unit;
      if (item.collectedAt !== null) {
        const age = state.elapsedMs - item.collectedAt;
        if (reduced) {
          if (age >= 180) continue;
          alpha = 1 - clamp(age / 180);
        } else {
          const delay = Math.abs(item.id % 6) * 18;
          const t = clamp((age - delay) / 340);
          if (t >= 1 || flights >= 48) continue;
          flights += 1;
          const startX = x; const startY = y;
          const targetY = heroY - 8 * riderPaintUnit();
          const dx = hx - startX; const dy = targetY - startY;
          const length = Math.hypot(dx, dy) || 1;
          const bend = (random(item.id + 81) - 0.5) * Math.min(52 * artUnit, length * 0.28);
          const controlX = (startX + hx) / 2 - dy / length * bend;
          const controlY = (startY + targetY) / 2 + dx / length * bend;
          const position = (progress: number) => {
            const eased = progress * progress * (3 - 2 * progress);
            return { x: (1 - eased) ** 2 * startX + 2 * (1 - eased) * eased * controlX + eased ** 2 * hx,
              y: (1 - eased) ** 2 * startY + 2 * (1 - eased) * eased * controlY + eased ** 2 * targetY };
          };
          const current = position(t); x = current.x; y = current.y;
          alpha = 1 - t ** 4; radius *= 1 - t * 0.42;
          if (t > 0.1 && t < 0.92 && trails < 16) {
            trails += 1;
            const previous = position(Math.max(0, t - 0.09));
            const trailLength = Math.hypot(x - previous.x, y - previous.y) || 1;
            const limit = Math.min(1, 22 * artUnit / trailLength);
            line([x - (x - previous.x) * limit, y - (y - previous.y) * limit, x, y], `rgba(201,255,255,${alpha * 0.78})`, 2.4 * artUnit);
            if (item.id % 3 === 0) {
              const sparkle = (1 - t) * 3 * artUnit;
              line([x - sparkle, y, x + sparkle, y], '#E9FFFFD9', artUnit);
              line([x, y - sparkle, x, y + sparkle], '#E9FFFFD9', artUnit);
            }
          }
        }
      }
      if (y < -25 || y > height + 25 || x < -25 || x > width + 25) continue;
      crystal(x, y, radius, reduced ? 0 : sceneTime * 2.6 + (item.group ?? item.id) * 0.45 + item.id * 0.13, alpha);
    }
  }

  function pickupFeedback(state: SurfState, reduced: boolean) {
    const phase = state.phase === 'paused' ? state.resumePhase : state.phase;
    if (phase === 'ready' || phase === 'sinking' || phase === 'over') return;
    const artUnit = Math.min(1.1, Math.max(0.85, unit));
    const riderUnit = riderPaintUnit();
    const visible = crystalBursts.slice(-2).reverse();
    visible.forEach((burst, index) => {
      const age = state.elapsedMs - burst.updatedAt;
      const life = clamp(age / 850);
      const opacity = Math.min(1, (1 - life) * 2.5);
      const impact = (state.elapsedMs - burst.bornAt - 170) / 340;
      if (!reduced && impact >= 0 && impact < 1 && index === 0) {
        ctx.save(); ctx.globalAlpha = (1 - impact) * 0.55;
        ctx.beginPath(); ctx.ellipse(state.x * unit, heroY + 2 * riderUnit, (15 + impact * 23) * riderUnit, (8 + impact * 12) * riderUnit, 0, 0, TAU);
        ctx.strokeStyle = '#B6FBFF'; ctx.lineWidth = 2 * riderUnit; ctx.stroke();
        for (let i = 0; i < Math.min(6, burst.count); i += 1) {
          const angle = i / 6 * TAU;
          const distance = (19 + impact * 22) * riderUnit;
          ellipse(state.x * unit + Math.cos(angle) * distance, heroY + Math.sin(angle) * distance * 0.42,
            1.8 * riderUnit, 1.8 * riderUnit, '#CFFBFF');
        }
        ctx.restore();
      }
      const side = state.x > 800 ? -1 : 1;
      const x = state.x * unit + side * 47 * riderUnit;
      const y = heroY + (8 - (reduced ? 0 : life * 15)) * riderUnit - index * 27 * artUnit;
      ctx.save(); ctx.globalAlpha = opacity;
      ctx.font = `700 ${15 * artUnit}px "Space Mono", monospace`;
      const label = `+${burst.count}`;
      const pillWidth = ctx.measureText(label).width + 30 * artUnit;
      const pillLeft = side > 0 ? x : x - pillWidth;
      const scale = reduced ? 1 : 1 + Math.max(0, 1 - age / 130) * 0.08;
      ctx.translate(pillLeft + pillWidth / 2, y); ctx.scale(scale, scale);
      ctx.beginPath(); ctx.roundRect(-pillWidth / 2, -12 * artUnit, pillWidth, 24 * artUnit, 10 * artUnit);
      ctx.fillStyle = '#18233CEB'; ctx.fill(); ctx.strokeStyle = '#8EEEF3AA'; ctx.lineWidth = artUnit; ctx.stroke();
      const iconX = -pillWidth / 2 + 11 * artUnit;
      crystal(iconX, 0, 5.7 * artUnit, 0);
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#C7FDFF';
      ctx.fillText(label, -pillWidth / 2 + 22 * artUnit, artUnit);
      ctx.restore();
    });
  }

  function wakeTrail(state: SurfState, reduced: boolean) {
    if (reduced || wake.length < 2) return;
    const riderUnit = riderPaintUnit();
    for (let i = 1; i < wake.length; i += 1) {
      const point = wake[i]; const previous = wake[i - 1];
      const age = clamp((state.elapsedMs - point.time) / 1250);
      const spread = (12 + age * 27) * riderUnit;
      const x = point.x * unit;
      const y = screenY(point.distance, state) - 20 * riderUnit;
      const previousY = screenY(previous.distance, state) - 20 * riderUnit;
      const opacity = (1 - age) * 0.58;
      for (const side of [-1, 1]) line([previous.x * unit + side * spread, previousY, x + side * spread, y], `rgba(245,255,250,${opacity})`, (1.7 + (1 - age) * 2.4) * riderUnit);
      if (i % 3 === 0) ellipse(x + Math.sin(i * 7) * spread, y - 3 * riderUnit, (1.5 + age) * riderUnit, 1.4 * riderUnit, `rgba(245,255,250,${opacity * 0.8})`);
    }
  }

  function splash(x: number, y: number, progress: number, reduced: boolean, paintUnit = unit) {
    const t = clamp(progress);
    const ring = (12 + t * 55) * paintUnit;
    ctx.save(); ctx.globalAlpha = 1 - t * 0.8;
    ctx.beginPath(); ctx.ellipse(x, y, ring, ring * 0.4, 0, 0, TAU); ctx.strokeStyle = '#FFFFFFE0'; ctx.lineWidth = (4 - t * 3) * paintUnit; ctx.stroke();
    if (!reduced) {
      for (let i = 0; i < 15; i += 1) {
        const angle = i / 15 * TAU;
        const speed = 20 + random(i + 11) * 31;
        const dx = Math.cos(angle) * speed * t * paintUnit;
        const dy = Math.sin(angle) * speed * t * paintUnit * 0.5 - Math.sin(t * Math.PI) * (16 + random(i + 4) * 30) * paintUnit;
        ellipse(x + dx, y + dy, (2 + random(i + 14) * 2) * paintUnit * (1 - t * 0.6), (4 + random(i + 9) * 3) * paintUnit * (1 - t * 0.6), '#F2FFFB', angle * 0.15);
      }
    }
    ctx.restore();
  }

  function gulls(state: SurfState, reduced: boolean, foreground: boolean) {
    if (state.correct < 1 || state.phase === 'over') return;
    const phase = state.phase === 'paused' ? state.resumePhase : state.phase;
    const riderUnit = riderPaintUnit();
    const cx = state.x * unit;
    const cy = heroY - 118 * riderUnit;
    for (let i = 0; i < gullArrivals.length; i += 1) {
      const ring = Math.floor(i / 7);
      // A fixed angular seed prevents the existing flock from snapping when a new gull joins.
      const angle = i * TAU * 0.381966 + ring * 0.7 + (reduced ? 0 : sceneTime * (1.5 - Math.min(ring, 5) * 0.12));
      const front = Math.sin(angle) > 0;
      if (front !== foreground) continue;
      const orbitX = (34 + Math.sqrt(ring) * 19) * riderUnit;
      const orbitY = (11 + Math.sqrt(ring) * 10) * riderUnit;
      const targetX = cx + Math.cos(angle) * orbitX;
      const targetY = cy + Math.sin(angle) * orbitY - ring * 4 * riderUnit;
      const age = state.elapsedMs - (gullArrivals[i] ?? 0);
      const arrival = reduced ? 1 : clamp(age / 1000);
      const ease = 1 - (1 - arrival) ** 3;
      let x = (width + 40 * riderUnit) + (targetX - width - 40 * riderUnit) * ease;
      let y = (cy - 65 * riderUnit) + (targetY - cy + 65 * riderUnit) * ease;
      if (phase === 'sinking') {
        const flightMs = Math.max(0, state.phaseMs - (state.chase.phase === 'attacking' ? 800 : 0));
        x += flightMs * 0.12 * riderUnit; y -= flightMs * 0.055 * riderUnit;
      }
      const flapStep = reduced ? 2 : Math.floor(sceneTime * 8 + i * 1.7) % GULL_FLAP_SEQUENCE.length;
      const pose = GULL_FLAP_SEQUENCE[flapStep];
      const crop = SURF_GULL_CROPS[pose];
      const wingspan = (front ? 36 : 32) * riderUnit;
      const spriteScale = wingspan / GULL_WINGSPAN;
      const gullWidth = crop ? crop.width * spriteScale : wingspan;
      const gullHeight = crop ? crop.height * spriteScale : wingspan * 0.55;
      ctx.save(); ctx.translate(x, y);
      ctx.rotate(reduced ? 0 : Math.cos(angle) * 0.17 - state.vx / 3000);
      if (!front) ctx.globalAlpha = 0.88;
      if (gullSprite?.complete && gullSprite.naturalWidth > 0 && crop) {
        ctx.drawImage(gullSprite, crop.x, crop.y, crop.width, crop.height,
          -gullWidth / 2, -gullHeight * GULL_BODY_ANCHORS[pose], gullWidth, gullHeight);
      } else {
        const flapHeight = (reduced ? 2 : Math.sin(sceneTime * 9 + i) * 4) * riderUnit;
        line([-gullWidth * 0.48, -flapHeight, -gullWidth * 0.24, -4 * riderUnit, 0, 1 * riderUnit, gullWidth * 0.24, -4 * riderUnit, gullWidth * 0.48, -flapHeight], '#347F97', 4.6 * riderUnit);
        line([-gullWidth * 0.48, -flapHeight - riderUnit, -gullWidth * 0.24, -5 * riderUnit, 0, 0, gullWidth * 0.24, -5 * riderUnit, gullWidth * 0.48, -flapHeight - riderUnit], '#FFFEF2', 3.3 * riderUnit);
        ellipse(0, 1 * riderUnit, 3 * riderUnit, 6 * riderUnit, '#FFFCEF');
        polygon([-2 * riderUnit, 5 * riderUnit, 2 * riderUnit, 5 * riderUnit, 0, 8 * riderUnit], '#E6A94A');
      }
      ctx.restore();
    }
  }

  function monster(state: SurfState, reduced: boolean) {
    const phase = state.phase === 'paused' ? state.resumePhase : state.phase;
    const monsterId = Number.isInteger(state.monster) && state.monster >= 0 && state.monster < 7 ? state.monster : 1;
    const sprite = sprites[monsterId];
    const crops = SURF_CHARACTER_CROPS[monsterId];
    const crop = crops?.[SURF_POSE_INDEX[selectedPose]];
    const baseCrop = crops?.[0];
    const x = state.x * unit;
    const riderUnit = riderPaintUnit();
    const moving = phase === 'surfing' || phase === 'cleared' || phase === 'hurt';
    const ready = phase === 'ready';
    const lean = moving && !reduced ? -clamp(smoothedHeading / 6_000, -0.025, 0.025) : 0;
    const bob = reduced ? 0 : Math.sin(sceneTime * (moving ? 5.5 : 2.4)) * (moving ? 0.8 : 1.4) * riderUnit;
    const hurt = phase === 'hurt';
    const sinking = phase === 'sinking';
    const over = phase === 'over';
    const hurtProgress = clamp(state.phaseMs / 650);
    const attacked = state.chase.phase === 'attacking';
    const fallMs = Math.max(0, state.phaseMs - (attacked ? 800 : 0));
    const fallProgress = clamp(fallMs / (attacked ? 1000 : 1100));
    const ringRadius = surfMagnetRadius(state.correct) * unit;
    if (!sinking && !over) {
      ctx.save();
      if (!ready && ringRadius < Math.max(width, height) * 1.1) {
        ctx.strokeStyle = state.navigation === 'locked' ? '#FFFFFF3D' : '#FFFAAA8C';
        ctx.lineWidth = 1.2; ctx.setLineDash([2, 8]);
        ctx.beginPath(); ctx.arc(x, heroY, ringRadius, 0, TAU); ctx.stroke();
      }
      if (phase === 'cleared') {
        const t = clamp(state.phaseMs / 720);
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(x, heroY, 45 * riderUnit + (reduced ? 0 : t * 70 * riderUnit), 0, TAU);
        ctx.lineWidth = (3.5 - t * 2) * riderUnit; ctx.strokeStyle = `rgba(255,249,174,${(1 - t) * 0.85})`; ctx.stroke();
      }
      if (state.navigation === 'locked') {
        ctx.setLineDash([]); ctx.strokeStyle = '#EA755F7D'; ctx.lineWidth = 2 * riderUnit;
        ctx.beginPath(); ctx.ellipse(x, heroY, 28 * riderUnit, 36 * riderUnit, lean, 0, TAU); ctx.stroke();
      }
      ctx.restore();
    }
    if (moving) {
      ellipse(x, heroY - 18 * riderUnit, 22 * riderUnit, 6 * riderUnit, '#E6FFF1A0', lean);
      if (!reduced) {
        for (const side of [-1, 1]) {
          line([x + side * 12 * riderUnit, heroY + 5 * riderUnit, x + side * 25 * riderUnit, heroY - 15 * riderUnit, x + side * 30 * riderUnit, heroY - 27 * riderUnit], '#EFFFF2C1', 2.3 * riderUnit);
        }
      }
    }
    if (!over && (!sinking || fallProgress < 0.9) && sprite?.complete && sprite.naturalWidth > 0 && crop && baseCrop) {
      // All poses use one source-pixel scale. A wider carve or taller celebration
      // changes its silhouette without resizing the monster's head and body.
      const scale = (ready ? 160 : 120) * riderUnit / baseCrop.height;
      const drawWidth = crop.width * scale;
      const drawHeight = crop.height * scale;
      const anchorX = (crop.anchorX ?? crop.width * 0.5) * scale;
      const anchorY = (crop.anchorY ?? crop.height * 0.8) * scale;
      const wobble = hurt && !reduced ? Math.sin(hurtProgress * Math.PI * 4) * 0.018 * (1 - hurtProgress) : 0;
      const dropX = sinking && !reduced ? Math.sin(fallProgress * Math.PI * 0.75) * 13 * riderUnit : 0;
      const dropY = sinking ? fallProgress * 29 * riderUnit : 0;
      setCanvasData('riderVisible', 'true');
      setCanvasData('riderWidth', drawWidth.toFixed(2));
      setCanvasData('riderHeight', drawHeight.toFixed(2));
      setCanvasData('riderX', (x + dropX - anchorX).toFixed(2));
      setCanvasData('riderY', (heroY + bob + dropY - anchorY).toFixed(2));
      setCanvasData('riderScale', String(SURF_RIDER_SCALE));
      setCanvasData('riderBoardX', x.toFixed(2));
      setCanvasData('riderBoardY', heroY.toFixed(2));
      ctx.save(); ctx.translate(x + dropX, heroY + bob + dropY);
      ctx.rotate(lean + wobble);
      if (sinking) ctx.globalAlpha = clamp((0.9 - fallProgress) / 0.38);
      else if ((hurt || (state.invulnerableMs > 0 && phase !== 'cleared')) && Math.floor(state.elapsedMs / 95) % 2 === 0) ctx.globalAlpha = 0.67;
      ellipse(1 * riderUnit, 7 * riderUnit, (ready ? 31 : 23) * riderUnit, (ready ? 10 : 7) * riderUnit, '#1D4C6729');
      // Each generated frame already includes its surfboard and action pose.
      // No standing portrait, separate board, image tween or cross-fade is layered underneath.
      ctx.drawImage(sprite, crop.x, crop.y, crop.width, crop.height,
        -anchorX, -anchorY, drawWidth, drawHeight);
      ctx.restore();
      if (hurt && !reduced) {
        for (let i = 0; i < 3; i += 1) {
          const a = sceneTime * 5 + i * TAU / 3;
          const sx = x + Math.cos(a) * 23 * riderUnit;
          const sy = heroY - 102 * riderUnit + Math.sin(a) * 6 * riderUnit;
          polygon([sx, sy - 4 * riderUnit, sx + 2 * riderUnit, sy - riderUnit, sx + 5 * riderUnit, sy, sx + 2 * riderUnit, sy + 2 * riderUnit, sx, sy + 5 * riderUnit, sx - 2 * riderUnit, sy + riderUnit, sx - 5 * riderUnit, sy, sx - riderUnit, sy - 2 * riderUnit], '#FFF4A7');
        }
      }
    } else setCanvasData('riderVisible', 'false');
    if (sinking && fallMs > 0) splash(x + 19 * riderUnit, heroY + 14 * riderUnit, clamp((fallProgress - 0.14) / 0.86), reduced, riderUnit);
    if (hurt) splash(x + 16 * riderUnit, heroY + 7 * riderUnit, hurtProgress, reduced, riderUnit);
  }

  function render(state: SurfState, reducedMotion: boolean) {
    if (disposed) return;
    const box = canvas.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;
    width = box.width; height = box.height; unit = width / SURF_WORLD_WIDTH;
    heroY = height * SURF_HERO_Y + seaChaseCameraOffset(height, state.chase);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * dpr); const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.lineJoin = 'round';
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    const ready = state.phase === 'ready';
    if (ready && !wasReady) readyStarted = performance.now();
    wasReady = ready;
    sceneTime = ready ? (performance.now() - readyStarted) / 1000 : state.elapsedMs / 1000;
    const resetMotion = state.elapsedMs < previousTime || state.distance < previousDistance || ready || state.monster !== previousMonster;
    if (resetMotion) { wake = []; lastWake = -100; smoothedHeading = ready || !Number.isFinite(state.vx) ? 0 : state.vx; selectedPose = 'straight'; seaMonster.reset(); navigationCameraOffset = 0; }
    else smoothedHeading = smoothSurfHeading(smoothedHeading, state.vx, Math.max(0, state.elapsedMs - previousTime));
    const actionPhase = state.phase === 'paused' ? state.resumePhase : state.phase;
    // The attack coils before contact; falling early would make the sea creature miss its target.
    const posePhase = actionPhase === 'sinking' && state.chase.phase === 'attacking' && state.phaseMs < 800 ? 'surfing' : actionPhase;
    selectedPose = chooseSurfPose(posePhase, smoothedHeading, selectedPose);
    if (canvas.dataset.surfPose !== selectedPose) canvas.dataset.surfPose = selectedPose;
    if (canvas.dataset.surfCharacter !== String(state.monster)) canvas.dataset.surfCharacter = String(state.monster);
    previousMonster = state.monster;
    if ((state.phase === 'surfing' || state.phase === 'hurt' || state.phase === 'cleared') && state.elapsedMs - lastWake >= 25) {
      wake.push({ x: state.x, distance: state.distance, time: state.elapsedMs }); lastWake = state.elapsedMs;
    }
    wake = wake.filter(point => state.elapsedMs - point.time < 1250);
    updateCrystalBursts(state, resetMotion);
    previousTime = state.elapsedMs; previousDistance = state.distance;
    const visibleGulls = Math.min(SURF_MAX_VISIBLE_GULLS, state.correct);
    if (resetMotion || state.correct < previousGullCount) gullArrivals = [];
    if (gullArrivals.length > visibleGulls) gullArrivals.length = visibleGulls;
    while (gullArrivals.length < visibleGulls) gullArrivals.push(state.elapsedMs);
    // Every new correct answer still brings a fresh bird into view; older
    // companions leave the visible flock so long runs keep a bounded draw cost.
    if (state.correct > SURF_MAX_VISIBLE_GULLS && state.correct > previousGullCount) {
      gullArrivals[(state.correct - 1) % SURF_MAX_VISIBLE_GULLS] = state.elapsedMs;
    }
    previousGullCount = state.correct;
    setCanvasData('gullVisibleCount', String(visibleGulls));
    setCanvasData('gullEarnedCount', String(state.correct));
    const visualState = ready ? { ...state, distance: 400, x: 750 } : state;
    const preparedSeaFrame = seaMonster.prepare(visualState, { width, height, heroX: visualState.x * unit, heroY }, reducedMotion);
    if (visualState.chase.phase !== 'dormant') {
      // A fixed head envelope avoids camera pulses as left/right sprite crops change.
      const seaTop = preparedSeaFrame ? preparedSeaFrame.y - 365 * preparedSeaFrame.scale - 10 : undefined;
      navigationCameraOffset = seaNavigationCameraOffset(width, height, heroY, seaTop, navigationCameraOffset);
    }
    heroY += navigationCameraOffset;
    const seaFrame = preparedSeaFrame ? { ...preparedSeaFrame,
      y: preparedSeaFrame.y + navigationCameraOffset, top: preparedSeaFrame.top + navigationCameraOffset } : null;
    setCanvasData('seaMonsterCameraOffset', navigationCameraOffset.toFixed(3));
    water(visualState, reducedMotion); underwaterPlants(visualState, reducedMotion);
    wakeTrail(visualState, reducedMotion); crystals(visualState, reducedMotion);
    setCanvasData('gullMaxWingspan', (36 * riderPaintUnit()).toFixed(2));
    setCanvasData('gullOrbitY', (heroY - 118 * riderPaintUnit()).toFixed(2));
    setCanvasData('seaMonsterVisible', String(Boolean(seaFrame && seaFrame.opacity > 0.02)));
    setCanvasData('seaMonsterPose', seaFrame?.pose ?? 'hidden');
    if (seaFrame) {
      const seaCrop = INKFIN_CROPS[seaFrame.pose];
      setCanvasData('seaMonsterX', String(Math.round(seaFrame.x - seaCrop.anchorX * seaFrame.scale)));
      setCanvasData('seaMonsterY', String(Math.round(seaFrame.top)));
      setCanvasData('seaMonsterWidth', String(Math.round(seaCrop.width * seaFrame.scale)));
      setCanvasData('seaMonsterHeight', String(Math.round(Math.min(seaCrop.height * seaFrame.scale, seaFrame.y + 26 - seaFrame.top))));
      setCanvasData('seaMonsterWorldX', seaFrame.worldX.toFixed(3));
      setCanvasData('seaMonsterWorldY', seaFrame.worldY.toFixed(3));
      setCanvasData('seaMonsterFootprintRx', seaFrame.footprintRx.toFixed(3));
      setCanvasData('seaMonsterFootprintRy', seaFrame.footprintRy.toFixed(3));
      setCanvasData('seaMonsterNavigation', seaFrame.navigation);
      setCanvasData('seaMonsterClearance', seaFrame.clearance.toFixed(4));
      setCanvasData('seaMonsterRoutePoints', String(seaFrame.routePoints));
    } else {
      setCanvasData('seaMonsterNavigation', 'hidden');
    }
    // Sort by contact with the water, rather than putting every sea-creature frame
    // above islands behind the player. A nearby roof can now obscure a distant swimmer.
    const layers: { depth: number; draw: () => void }[] = visualState.obstacles.map(item => ({
      depth: item.y, draw: () => obstacle(item, visualState, reducedMotion),
    }));
    const boardDepth = visualState.distance + 12;
    layers.push({ depth: boardDepth, draw: () => {
      gulls(visualState, reducedMotion, false);
      monster(visualState, reducedMotion);
      gulls(visualState, reducedMotion, true);
    } });
    if (seaFrame) layers.push({ depth: seaFrame.foreground ? Math.max(boardDepth + 1, seaFrame.worldY) : seaFrame.worldY,
      draw: () => { seaMonster.draw(seaFrame, false); seaMonster.draw(seaFrame, true); } });
    layers.sort((a, b) => a.depth - b.depth);
    for (const layer of layers) layer.draw();
    pickupFeedback(visualState, reducedMotion);
    const visualPhase = state.phase === 'paused' ? state.resumePhase : state.phase;
    const impactMs = state.phaseMs - (visualPhase === 'sinking' && state.chase.phase === 'attacking' ? 800 : 0);
    if ((visualPhase === 'hurt' || visualPhase === 'sinking') && impactMs >= 0 && impactMs < 190) {
      const opacity = reducedMotion ? 0 : (1 - impactMs / 190) * 0.10;
      ctx.fillStyle = `rgba(251,82,88,${opacity})`; ctx.fillRect(0, 0, width, height);
    }
  }
  return { render, destroy() { disposed = true; wake = []; gullArrivals = []; crystalBursts = []; seaMonster.reset(); } };
}
