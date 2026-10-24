import { SURF_CHASE_ATTACK_MS, SURF_CHASE_RETREAT_MS, SURF_WORLD_WIDTH } from './constants.ts';
import { INKFIN_CROPS, type SeaMonsterPose } from './seaMonsterArt.ts';
import { createSeaMonsterNavigator, findSeaMonsterWaterPoint, type SeaMonsterPoint } from './seaMonsterNavigation.ts';
import type { SurfState } from './types.ts';

const TAU = Math.PI * 2;
const clamp = (n: number, min = 0, max = 1) => Math.max(min, Math.min(max, n));
const smooth = (n: number) => { const t = clamp(n); return t * t * (3 - 2 * t); };
/** Short desktop screens gain room behind the board as the chase arrives.
 * Keep the new framing until restart so escaping never jerks the camera back. */
export function seaChaseCameraOffset(height: number, chase: SurfState['chase']): number {
  if (chase.phase === 'dormant') return 0;
  const entry = chase.phase === 'warning' ? smooth(chase.phaseMs / 1000) : 1;
  return 54 * clamp((680 - height) / 84) * entry;
}

/** Move the whole ocean to frame a real detour; never move the swimmer off its route.
 * Hold the gained framing until restart, leaving space ahead of the board. */
export function seaNavigationCameraOffset(width: number, height: number, boardY: number, actorTop: number | undefined, previous: number): number {
  const maximum = Math.max(0, height - boardY - 110);
  const safeTop = width >= 1900 ? 222 : 216;
  const needed = actorTop === undefined ? 0 : safeTop - actorTop;
  return clamp(Math.max(previous, needed), 0, maximum);
}

export interface SeaMonsterViewport { width: number; height: number; heroX: number; heroY: number; }
export interface SeaMonsterFrame {
  pose: SeaMonsterPose; x: number; y: number; scale: number; opacity: number;
  time: number; bob: number; angle: number; submerged: number; stroke: number;
  emergence: number; retreat: number; attack: number; close: number; foreground: boolean;
  top: number; reduced: boolean;
  worldX: number; worldY: number; footprintRx: number; footprintRy: number;
  navigation: 'direct' | 'detour' | 'waiting'; clearance: number; routePoints: number;
}

/** A visual actor only. Chase outcome and distance remain owned by the simulation. */
export function createSeaMonsterRenderer(ctx: CanvasRenderingContext2D, sprite?: HTMLImageElement) {
  let lastTime = -1;
  const navigator = createSeaMonsterNavigator();
  let position: SeaMonsterPoint | null = null;
  let previousWidth = 0;
  let previousHeight = 0;
  let heading = 0;
  let side = 1;
  let active = false;

  function prepare(state: SurfState, viewport: SeaMonsterViewport, reduced: boolean): SeaMonsterFrame | null {
    const { chase } = state;
    if (chase.phase === 'dormant' || chase.phase === 'escaped' || state.phase === 'ready' || state.phase === 'over') {
      active = false; lastTime = state.elapsedMs; position = null; heading = 0; navigator.reset(); return null;
    }
    const { width, height, heroX, heroY } = viewport;
    const unit = width / SURF_WORLD_WIDTH;
    const compact = height < 680;
    const artUnit = clamp(width / 1366, 0.94, 1.08);
    const baseScale = (compact ? 0.32 : 0.36) * artUnit;
    const hudBottom = width >= 1900 ? 214 : 208;
    const safeTop = Math.min(hudBottom + 8, heroY - 95);
    const separation = clamp(chase.gap, 20, 650);
    const distanceRatio = clamp((separation - 70) / 580);
    const lateral = (120 + distanceRatio * 185) * artUnit;
    const desiredLift = (26 + distanceRatio * 94) * artUnit;
    const elapsed = state.elapsedMs / 1000;
    const entering = !active || state.elapsedMs < lastTime;
    const resized = width !== previousWidth || height !== previousHeight;
    if (entering) {
      active = true; side = heroX < width * 0.5 ? 1 : -1;
      position = null; heading = 0; navigator.reset();
    }
    const dt = entering ? 0 : clamp(state.elapsedMs - lastTime, 0, 1000);
    lastTime = state.elapsedMs;
    previousWidth = width; previousHeight = height;
    const targetX = clamp(heroX + side * lateral, 85 * artUnit, width - 85 * artUnit);

    const emergence = chase.phase === 'warning' ? smooth(chase.phaseMs / 1000) : 1;
    const retreat = chase.phase === 'retreating' ? clamp(chase.phaseMs / SURF_CHASE_RETREAT_MS) : 0;
    const attack = chase.phase === 'attacking' ? clamp(chase.phaseMs / SURF_CHASE_ATTACK_MS) : 0;
    const close = chase.action === 'close' && chase.phase !== 'attacking' ? 1 - clamp(chase.actionMs / 700) : 0;
    // Alternating strokes use real left/right drawings, with a brief frontal recovery.
    const paddle = Math.floor(state.elapsedMs / 440) % 6;
    let pose: SeaMonsterPose = paddle < 2 ? 'paddle-left' : paddle < 4 ? 'paddle-right' : 'emerge';
    if (chase.phase === 'warning' && emergence < 1) pose = 'emerge';
    if (chase.mistakes >= 2 || close > 0) pose = 'close';
    if (chase.phase === 'attacking') pose = attack < 0.23 ? 'close' : 'attack';
    if (chase.phase === 'retreating') pose = 'retreat';
    if (reduced && chase.phase === 'chasing' && chase.mistakes < 2 && close === 0) pose = 'emerge';
    const scale = baseScale * (1 + (chase.phase === 'attacking' ? smooth(attack / 0.5) * 0.10 : 0));
    // Keep the entire silhouette below the three HUD cards at the shortest desktop height.
    // Horizontal separation communicates the remaining chase gap when vertical space is tight.
    const baseY = Math.max(heroY - desiredLift, safeTop + 365 * scale);
    let x = targetX;
    let y = baseY;
    let opacity = 1;
    let submerged = (1 - emergence) * 72 * scale;
    const swim = reduced ? 0 : Math.sin(elapsed * 5.2);
    const bob = swim * 2.4 * artUnit;
    let angle = reduced ? 0 : Math.sin(elapsed * 2.6) * 0.022;
    const stroke = reduced ? 0 : (Math.sin(elapsed * 7.1) + 1) / 2;
    if (chase.phase === 'warning') opacity = 0.28 + 0.72 * emergence;
    if (chase.phase === 'retreating') {
      const turn = smooth(retreat / 0.35);
      x += side * smooth(retreat) * (reduced ? 25 : 120) * artUnit;
      y = Math.max(y - smooth(retreat) * (reduced ? 0 : 28) * artUnit, safeTop + INKFIN_CROPS.retreat.anchorY * scale + 8);
      angle = reduced ? 0 : side * turn * -0.12;
      submerged = smooth((retreat - 0.35) / 0.65) * 150 * scale;
      opacity = 1 - smooth((retreat - 0.52) / 0.48);
    }
    if (chase.phase === 'attacking') {
      // Coil, then lunge. The rider only starts falling after the tentacles reach the board.
      const lunge = smooth((attack - 0.20) / 0.34);
      x += (heroX + side * 8 * artUnit - x) * lunge;
      y += (heroY + 10 * artUnit - y) * lunge;
      if (!reduced) angle = side * -0.06 * Math.sin(lunge * Math.PI);
      submerged = smooth((attack - 0.76) / 0.24) * 100 * scale;
      opacity = 1 - smooth((attack - 0.87) / 0.13);
    }
    // Follow in world space: scrolling the camera must never carry the actor through land.
    // Reserve the widest tentacle gesture up front, including the attack's 10% expansion.
    // Its water footprint excludes the tall head and horns, just as islands exclude treetops.
    const footprint = { rx: 64 * (baseScale / 0.32) * 1.1 / unit, ry: 22 * (baseScale / 0.32) * 1.1 / unit };
    const target = { x: x / unit, y: state.distance + (y - heroY) / unit };
    const bounds = { minX: 88 * artUnit / unit, maxX: (width - 88 * artUnit) / unit };
    // Placement is separate from stepping: a zero-time first frame must still
    // emerge in water, while repeated paused frames remain strict identities.
    if (entering || resized) position = findSeaMonsterWaterPoint(position ?? target, state.obstacles, footprint, bounds) ?? position;
    const previous = position ?? target;
    const route = navigator.step({ position: previous, target, obstacles: state.obstacles, footprint,
      bounds,
      maxDistance: dt / 1000 * (chase.phase === 'attacking' ? 900 : Math.max(260, state.speed * 1.65)),
      allowRelocate: entering || resized });
    position = route.position;
    if (dt > 0) {
      const lateralSpeed = (position.x - previous.x) * 1000 / dt;
      heading += (clamp(lateralSpeed / 220, -1, 1) - heading) * (1 - Math.exp(-dt / 140));
    }
    // Steering selects a matching stroke and banks the body without moving it off its safe path.
    if (!reduced && chase.phase === 'chasing' && chase.mistakes < 2 && close === 0) {
      if (heading < -0.18) pose = 'paddle-left';
      else if (heading > 0.18) pose = 'paddle-right';
      angle += heading * 0.08;
    }
    x = position.x * unit;
    y = heroY + (position.y - state.distance) * unit;
    const crop = INKFIN_CROPS[pose];
    return { pose, x, y, scale, opacity, time: elapsed, bob, angle, submerged, stroke, emergence,
      retreat, attack, close, foreground: chase.phase === 'attacking' && attack >= 0.35,
      top: y - crop.anchorY * scale + bob + submerged, reduced,
      worldX: position.x, worldY: position.y, footprintRx: footprint.rx, footprintRy: footprint.ry,
      navigation: route.navigation, clearance: route.clearance, routePoints: route.route.length };
  }

  function ellipse(x: number, y: number, rx: number, ry: number, fill: string) {
    ctx.beginPath(); ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, TAU);
    ctx.fillStyle = fill; ctx.fill();
  }
  function ripples(frame: SeaMonsterFrame, foreground: boolean) {
    const { x, y, scale, time, reduced } = frame;
    const k = scale / 0.32;
    const step = reduced ? 0.4 : (time * 0.95) % 1;
    ctx.save();
    for (let i = 0; i < 3; i++) {
      const t = (step + i / 3) % 1;
      const spread = (28 + t * 61) * k;
      ctx.beginPath();
      ctx.ellipse(x, y + 8 * k, spread, spread * 0.24, 0, foreground ? 0 : Math.PI, foreground ? Math.PI : TAU);
      ctx.strokeStyle = `rgba(231,255,251,${(1 - t) * 0.54 * frame.opacity})`;
      ctx.lineWidth = (1 + (1 - t) * 2) * k; ctx.stroke();
    }
    ctx.restore();
  }
  function wake(frame: SeaMonsterFrame) {
    const { x, y, scale, time, reduced } = frame;
    const k = scale / 0.32;
    ctx.save(); ctx.globalAlpha = frame.opacity;
    ellipse(x, y + 7 * k, 58 * k, 16 * k, '#196F8D30');
    if (!reduced) {
      // The broad forked wake is distinct from the small board's wake.
      for (const direction of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(x + direction * 36 * k, y + 5 * k);
        ctx.bezierCurveTo(x + direction * 52 * k, y - 8 * k, x + direction * 67 * k,
          y - 36 * k, x + direction * 49 * k, y - 69 * k);
        ctx.strokeStyle = '#ECFFF56B'; ctx.lineWidth = 3 * k; ctx.stroke();
        for (let i = 0; i < 6; i++) {
          const t = ((time * 1.1 + i / 6) % 1);
          ellipse(x + direction * (43 + t * 23) * k, y - t * 58 * k,
            (2.4 - t * 1.3) * k, (1.3 - t * 0.6) * k, `rgba(245,255,253,${(1 - t) * 0.75})`);
        }
      }
    }
    // Each paddle stroke throws a short fan of water from the working tentacle.
    if (!reduced && frame.attack === 0 && frame.retreat === 0) {
      const direction = frame.pose === 'paddle-left' ? -1 : frame.pose === 'paddle-right' ? 1 : 0;
      const stroke = frame.stroke;
      const impact = frame.close > 0 ? frame.close : 0;
      for (let i = 0; i < (direction ? 5 : 3); i++) {
        const side = direction || (i % 2 ? -1 : 1);
        const reach = (47 + stroke * 23 + i * 3 + impact * 9) * k;
        const lift = Math.sin(stroke * Math.PI) * (9 + i * 3) * k;
        ellipse(x + side * reach, y + (i - 2) * 2 * k - lift,
          (2.3 - stroke) * k, (3.8 - stroke * 2) * k,
          `rgba(244,255,253,${(1 - stroke) * 0.7 * frame.opacity})`);
      }
    }
    ctx.restore();
  }
  function fallback(frame: SeaMonsterFrame) {
    const k = frame.scale / 0.32;
    // Asset-failure fallback preserves this character's navy body, coral horns and gold eyes.
    ctx.save(); ctx.translate(frame.x, frame.y + frame.submerged); ctx.scale(k, k);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(side * 28, -12);
      ctx.bezierCurveTo(side * 81, -33, side * 82, 16, side * 50, 12);
      ctx.strokeStyle = '#373A79'; ctx.lineWidth = 17; ctx.stroke();
      ctx.strokeStyle = '#F69584'; ctx.lineWidth = 6; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(side * 27, -61); ctx.quadraticCurveTo(side * 47, -113, side * 17, -100);
      ctx.strokeStyle = '#F58577'; ctx.lineWidth = 13; ctx.stroke();
    }
    ellipse(0, -42, 44, 51, '#343B7F'); ellipse(0, -13, 31, 18, '#ACAECF');
    for (const side of [-1, 1]) {
      ellipse(side * 21, -43, 13, 16, '#FFC94D'); ellipse(side * 19, -42, 5, 10, '#162645');
      ellipse(side * 23, -48, 2.5, 3, '#FFFDE4');
      ellipse(side * 34, -20, 3, 2, '#4BE1E7');
    }
    if (frame.pose === 'attack') ellipse(0, -9, 17, 13, '#40214B');
    ctx.restore();
  }
  function impact(frame: SeaMonsterFrame) {
    if (frame.attack < 0.45) return;
    const progress = clamp((frame.attack - 0.45) / 0.55);
    const k = frame.scale / 0.32;
    ctx.save(); ctx.globalAlpha = (1 - progress) * frame.opacity;
    ctx.beginPath(); ctx.ellipse(frame.x, frame.y + 14 * k,
      (25 + progress * 90) * k, (12 + progress * 28) * k, 0, 0, TAU);
    ctx.lineWidth = (5 - progress * 3) * k; ctx.strokeStyle = '#F8FFFE'; ctx.stroke();
    if (!frame.reduced) for (let i = 0; i < 16; i++) {
      const angle = i / 16 * TAU;
      const reach = (25 + progress * (55 + i % 4 * 9)) * k;
      ellipse(frame.x + Math.cos(angle) * reach,
        frame.y + Math.sin(angle) * reach * 0.4 - Math.sin(progress * Math.PI) * 31 * k,
        (2 + i % 3) * k, (4 + i % 4) * k, '#F1FFFD');
    }
    ctx.restore();
  }
  function draw(frame: SeaMonsterFrame | null, foreground: boolean) {
    if (!frame) return;
    if (!foreground) { wake(frame); ripples(frame, false); }
    if (frame.foreground !== foreground) return;
    const crop = INKFIN_CROPS[frame.pose];
    ctx.save(); ctx.globalAlpha = frame.opacity;
    // Hide the lower body under the waterline as it rises and dives; foam stays on the surface.
    ctx.beginPath(); ctx.rect(frame.x - 220, frame.y - 260, 440, 286); ctx.clip();
    if (sprite?.complete && sprite.naturalWidth > 0) {
      ctx.translate(frame.x, frame.y + frame.bob + frame.submerged);
      ctx.rotate(frame.angle);
      const breadth = frame.reduced ? 1 : 1 + Math.sin(frame.time * 5.2) * 0.008;
      ctx.scale(breadth, 1 / breadth);
      ctx.drawImage(sprite, crop.x, crop.y, crop.width, crop.height,
        -crop.anchorX * frame.scale, -crop.anchorY * frame.scale,
        crop.width * frame.scale, crop.height * frame.scale);
    } else fallback(frame);
    ctx.restore();
    ripples(frame, true);
    impact(frame);
  }
  return {
    prepare, draw,
    reset() { active = false; lastTime = -1; position = null; heading = 0; navigator.reset(); },
  };
}
