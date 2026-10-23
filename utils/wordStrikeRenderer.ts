// ================================================================
// WORD STRIKE — canvas renderer (vertical-drop crayon edition).
//
// Custom canvas rendering on top of the physics world (Matter.Render is NOT
// used). The canvas is transparent outside the letterboxed 900×640 logical
// world; the field itself is painted here (side-view meadow backdrop, the
// elevator rig, crayon blocks) so the scene reads as one hand-drawn page.
//
// The monster is an upright side-view gunner sprite (utils/
// wordStrikeMonsterSprite) facing right, standing on the elevator platform,
// with timed one-shot keyframe states — the gun is baked into the art, so
// the sprite is never rotated. All combat feedback runs through the pooled
// particle system (utils/wordStrikeParticles). Per-frame high-frequency
// data arrives via the `view` argument — the React layer keeps it in refs
// and never re-renders per frame.
//
// Draw order: shake → meadow → aim line → elevator → blocks →
// debris → bullets → monster(+gun) → particles → hurt vignette → MISS
// floaters.
// ================================================================
import * as Matter from 'matter-js';
import {
  WordStrikePhysics,
  UnitHandle,
  LOGICAL_WORLD,
  ELEVATOR,
  FLOOR_TOP,
  MONSTER,
  TURRET,
  getGunPivotY,
} from './wordStrikePhysics';
import {
  WordStrikeParticleSystem,
  ParticleBurstUnit,
  CRAYON_PALETTE,
} from './wordStrikeParticles';
import { WordStrikeMonsterSprite, MonsterAnimState } from './wordStrikeMonsterSprite';

const CRAYON = {
  // Paired face/stroke crayon pastels (procedural fallback + debris colors).
  blockFills: CRAYON_PALETTE,
  blockStrokes: ['#C93B34', '#D6823A', '#D9B45F', '#5C8F4A', '#3F7CB0', '#7A5FC0'],
  glyph: '#33323B',
  glyphHalo: 'rgba(255, 248, 231, 0.85)',
  chalk: '#FFF8E7',
  bulletGlow: 'rgba(0, 240, 255, 0.8)',
  bulletCore: '#FFFFFF',
  missColor: '#FF4D4F',
  // The app's classic word font (LargeWordInput / word cards use font-serif).
  glyphFont: '"Playfair Display", Georgia, serif',
  monoFont: '"Space Mono", monospace',
} as const;

export interface WordStrikeGhost {
  unitIndex: number;
  letter: string;
  x: number;
  y: number;
  bornAt: number;
}

export interface WordStrikeFloater {
  x: number;
  y: number;
  text: string;
  color: string;
  bornAt: number;
}

export interface WordStrikeAimTarget {
  /** Smoothed-target angle in atan2 radians (what the gun should point at). */
  angle: number;
  /** Brick center point — anchors the aim line end + reticle. */
  x: number;
  y: number;
}

export interface WordStrikeView {
  ghosts: WordStrikeGhost[];
  floaters: WordStrikeFloater[];
  lastShotAt: number;
  recoil: number;
  /** What the player has typed this attempt — drawn ON the alive units. */
  typed: string;
  /** Letters confirmed correct on earlier attempts — stay drawn (green) until
   *  the brick dies. Empty string at positions not yet revealed. */
  revealed: string;
  /** unitIndex → timestamp until which the tile shows its wrong-input red flash. */
  wrongFlash: Record<number, number>;
  now: number;
  /** Per-frame gun aim feed; null relaxes the gun to straight right. */
  aimTarget?: WordStrikeAimTarget | null;
  /** Elevator platform height (feet Y) this frame — smoothed by the caller. */
  elevatorFeetY: number;
}

const FLOATER_RISE_PX_PER_S = 40;
const FLOATER_LIFETIME_MS = 700;
const GHOST_ALPHA = 0.5;
const DEBRIS_ALPHA_FLOOR = 0.15;
const UNIT_FLASH_MS = 140;
const HURT_FLASH_MS = 500;
/** How long a wrongly-typed tile stays red after a (non-lethal) hit resolves. */
export const WRONG_FLASH_MS = 500;
/** Whole-bar wobble after a non-lethal hit — the hit lands but nothing breaks. */
const BRICK_SHAKE_MS = 450;
/** Visible character height — feet on the platform, head ~MONSTER.height above it. */
const MONSTER_SPRITE_HEIGHT = 105;
/** Generated strike art keeps ~70% of its frame for the body with feet on the
 *  bottom edge, so the full frame is drawn slightly larger than the target. */
const MONSTER_FRAME_SCALE = 1 / 0.7;

/** FNV-1a — stable per-word block color sequence. */
const hashString = (value: string): number => {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

const TAU = Math.PI * 2;

export class WordStrikeRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private dpr = 1;

  private monster = new WordStrikeMonsterSprite();
  private particles = new WordStrikeParticleSystem();

  private bgImg: HTMLImageElement | null = null;
  private bgFallback: HTMLCanvasElement | null = null;
  private blockImgs: HTMLImageElement[] = [];
  private blockFaceCache = new Map<string, HTMLCanvasElement>();

  private unitFlashUntil = 0;
  private brickShakeAt = -Infinity;
  private hurtFlashAt = -Infinity;
  private aimPoint: WordStrikeAimTarget | null = null;
  private lastDrawAt = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('WordStrikeRenderer: 2D canvas context unavailable');
    }
    this.ctx = ctx;
  }

  // ----------------------------------------------------------------
  // asset loading (never throws — every slot degrades independently)
  // ----------------------------------------------------------------

  /** Legacy mid-tier monster art (pre-rework front-view daily webp). */
  setMonsterImage(src: string): void {
    this.monster.setLegacyImage(src);
  }

  /** Side-view gunner keyframe set for the day (see getWordStrikeSpritePaths). */
  setMonsterFrames(paths: { idle: string; shoot: string; hurt: string; cheer: string }): void {
    this.monster.setFrames(paths);
  }

  setBackgroundImage(src: string): void {
    const img = new Image();
    img.onload = () => {
      this.bgImg = img;
    };
    img.onerror = () => {};
    img.src = src;
  }

  /** Blank crayon block faces; typed letters are rendered on top by the game. */
  setBlockTextures(srcs: string[]): void {
    this.blockImgs = [];
    for (const src of srcs) {
      const img = new Image();
      img.onload = () => {
        if (!this.blockImgs.includes(img)) this.blockImgs.push(img);
      };
      img.onerror = () => {};
      img.src = src;
    }
  }

  // ----------------------------------------------------------------
  // event hooks (called by the game component)
  // ----------------------------------------------------------------

  triggerMonsterState(state: MonsterAnimState, durationMs?: number): void {
    this.monster.triggerState(state, durationMs);
  }

  /** Brief white flash on all alive units (bullet connect). */
  triggerUnitFlash(): void {
    this.unitFlashUntil = performance.now() + UNIT_FLASH_MS;
  }

  /** Whole-bar wobble — a non-lethal hit: the brick is struck but holds. */
  triggerBrickShake(): void {
    this.brickShakeAt = performance.now();
  }

  /** Full-field red vignette pulse (life loss). */
  triggerHurtFlash(): void {
    this.hurtFlashAt = performance.now();
  }

  spawnMuzzleFlash(x: number, y: number, angle: number): void {
    this.particles.spawnMuzzleFlash(x, y, angle);
  }

  spawnImpact(x: number, y: number, travelAngle: number): void {
    this.particles.spawnImpact(x, y, travelAngle);
  }

  spawnWordBurst(units: ParticleBurstUnit[], barCenter?: { x: number; y: number }): void {
    this.particles.spawnWordBurst(units, barCenter);
  }

  /** Life-loss explosion — particles carry NO letters (no word spoilers). */
  spawnBrickExplosion(units: ParticleBurstUnit[], barCenter?: { x: number; y: number }): void {
    this.particles.spawnBrickExplosion(units, barCenter);
  }

  // ----------------------------------------------------------------
  // letterbox + main draw
  // ----------------------------------------------------------------

  resize(cssWidth: number, cssHeight: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    this.scale = Math.min(cssWidth / LOGICAL_WORLD.width, cssHeight / LOGICAL_WORLD.height);
    this.offsetX = (cssWidth - LOGICAL_WORLD.width * this.scale) / 2;
    this.offsetY = (cssHeight - LOGICAL_WORLD.height * this.scale) / 2;
    this.dpr = dpr;
  }

  draw(physics: WordStrikePhysics, view: WordStrikeView): void {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const s = this.scale * dpr;
    const dtMs = Math.min(100, Math.max(0, view.now - this.lastDrawAt));
    this.lastDrawAt = view.now;

    this.aimPoint = view.aimTarget ?? null;
    this.monster.setAimTarget(view.aimTarget ? view.aimTarget.angle : null);
    this.monster.update(view.now, dtMs);
    this.particles.update(dtMs);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(s, 0, 0, s, this.offsetX * dpr, this.offsetY * dpr);

    // Screen shake — view-layer only, physics world is never displaced.
    ctx.translate(physics.shakeOffset.x, physics.shakeOffset.y);

    this.drawBackground();
    this.drawAimLine(view);
    this.drawElevator(view.elevatorFeetY);
    // Ghost previews are gone: bars materialize fully visible at the top of
    // the field, so there is nothing to preview (view.ghosts stays in the
    // interface until the component feed is trimmed).
    this.drawUnits(physics.getAliveUnits(), view.typed, view.revealed, view.wrongFlash, view.now);
    this.drawDebris(physics.getDebris(), view.now);
    this.drawBullets(physics.getBullets());
    this.drawMonster(view);
    this.particles.draw(ctx, view.now);
    this.drawHurtVignette(view.now);
    this.drawFloaters(view.floaters, view.now);
  }

  // ----------------------------------------------------------------
  // field: grass backdrop
  // ----------------------------------------------------------------

  private drawBackground(): void {
    const ctx = this.ctx;
    const { width, height } = LOGICAL_WORLD;
    if (this.bgImg && this.bgImg.complete && this.bgImg.naturalWidth > 0) {
      // Cover-fit crop into the logical world.
      const iw = this.bgImg.naturalWidth;
      const ih = this.bgImg.naturalHeight;
      const worldAspect = width / height;
      const imgAspect = iw / ih;
      let sw = iw;
      let sh = ih;
      let sx = 0;
      let sy = 0;
      if (imgAspect > worldAspect) {
        sw = ih * worldAspect;
        sx = (iw - sw) / 2;
      } else {
        sh = iw / worldAspect;
        sy = (ih - sh) / 2;
      }
      ctx.drawImage(this.bgImg, sx, sy, sw, sh, 0, 0, width, height);
    } else {
      ctx.drawImage(this.getBackgroundFallback(), 0, 0, width, height);
    }
  }

  /** Soft watercolor side-view meadow, built once at half resolution (blur = paint). */
  private getBackgroundFallback(): HTMLCanvasElement {
    if (this.bgFallback) return this.bgFallback;
    const scale = 0.5;
    const canvas = document.createElement('canvas');
    canvas.width = LOGICAL_WORLD.width * scale;
    canvas.height = LOGICAL_WORLD.height * scale;
    const c = canvas.getContext('2d');
    if (c) {
      const w = canvas.width;
      const h = canvas.height;
      const floorY = (FLOOR_TOP / LOGICAL_WORLD.height) * h;
      // Sky fills the play field — calm and low-contrast so moving blocks stay
      // readable against it.
      const sky = c.createLinearGradient(0, 0, 0, floorY);
      sky.addColorStop(0, '#CFE7F4');
      sky.addColorStop(0.72, '#E9F1E6');
      sky.addColorStop(1, '#DFEDCC');
      c.fillStyle = sky;
      c.fillRect(0, 0, w, floorY);
      // Blurred warm patches — watercolor blooms drifting in the sky.
      for (const [bx, by, br] of [
        [0.2, 0.18, 0.2],
        [0.75, 0.12, 0.17],
        [0.5, 0.38, 0.24],
        [0.15, 0.55, 0.18],
        [0.85, 0.45, 0.2],
      ] as const) {
        const blob = c.createRadialGradient(w * bx, floorY * by, 0, w * bx, floorY * by, w * br);
        blob.addColorStop(0, 'rgba(255, 250, 236, 0.55)');
        blob.addColorStop(1, 'rgba(255, 250, 236, 0)');
        c.fillStyle = blob;
        c.fillRect(0, 0, w, floorY);
      }
      // Gentle sun glow in the upper left (matches the generated-art prompt).
      const sun = c.createRadialGradient(w * 0.14, h * 0.1, 0, w * 0.14, h * 0.1, w * 0.2);
      sun.addColorStop(0, 'rgba(255, 240, 200, 0.6)');
      sun.addColorStop(1, 'rgba(255, 240, 200, 0)');
      c.fillStyle = sun;
      c.fillRect(0, 0, w, floorY);
      // Grassy ground strip the monster stands on.
      const grass = c.createLinearGradient(0, floorY, 0, h);
      grass.addColorStop(0, '#8FBF72');
      grass.addColorStop(1, '#5E9450');
      c.fillStyle = grass;
      c.fillRect(0, floorY, w, h - floorY);
      // Sparse hand-drawn tufts across the ground strip.
      c.strokeStyle = 'rgba(70, 110, 60, 0.5)';
      c.lineWidth = 1.5;
      c.lineCap = 'round';
      const rand = (seed: number) => {
        const x = Math.sin(seed * 127.1) * 43758.5453;
        return x - Math.floor(x);
      };
      const bandH = h - floorY;
      for (let i = 0; i < 46; i += 1) {
        const tx = rand(i) * w;
        const ty = floorY + rand(i + 200) * bandH;
        for (let b = -1; b <= 1; b += 1) {
          c.beginPath();
          c.moveTo(tx, ty);
          c.quadraticCurveTo(tx + b * 2, ty - 4, tx + b * 4, ty - 7 - rand(i + b) * 3);
          c.stroke();
        }
      }
    }
    this.bgFallback = canvas;
    return canvas;
  }

  // ----------------------------------------------------------------
  // field: the elevator rig (pulley + cable + platform, crayon style)
  // ----------------------------------------------------------------

  private drawElevator(feetY: number): void {
    const ctx = this.ctx;
    const x = MONSTER.x;
    const clampedFeetY = Math.min(ELEVATOR.bottomFeetY, Math.max(ELEVATOR.topFeetY, feetY));
    const pulleyY = 38;

    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = CRAYON.chalk;
    ctx.lineCap = 'round';

    // Pulley wheel up top.
    ctx.fillStyle = CRAYON.chalk;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, pulleyY, 9, 0, TAU);
    ctx.fill();
    ctx.stroke();

    // Cable from the pulley down to the platform (the sprite occludes the
    // middle — reads as the gunner riding the lift).
    ctx.beginPath();
    ctx.moveTo(x, pulleyY + 9);
    ctx.lineTo(x, clampedFeetY - 4);
    ctx.stroke();

    // Crayon platform board under the feet.
    ctx.fillStyle = CRAYON.chalk;
    ctx.beginPath();
    ctx.roundRect(x - 65, clampedFeetY, 130, 13, 6);
    ctx.fill();

    // Hand-drawn shading under the board.
    ctx.strokeStyle = 'rgba(35, 64, 31, 0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 58, clampedFeetY + 13);
    ctx.lineTo(x + 58, clampedFeetY + 13);
    ctx.stroke();

    ctx.restore();
  }

  // ----------------------------------------------------------------
  // field: aim assist line + reticle
  // ----------------------------------------------------------------

  private drawAimLine(view: WordStrikeView): void {
    const target = this.aimPoint;
    if (!target) return;
    const ctx = this.ctx;
    const a = this.monster.aimAngle;
    const pivotY = getGunPivotY(view.elevatorFeetY);
    const mx = TURRET.pivotX + Math.cos(a) * TURRET.muzzleLength;
    const my = pivotY + Math.sin(a) * TURRET.muzzleLength;
    // Bars materialize fully inside the world — the reticle end never leaves
    // the canvas.
    const tx = target.x;
    const ty = target.y;
    const dx = tx - mx;
    const dy = ty - my;
    const dist = Math.hypot(dx, dy);
    if (dist < 48) return;

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 248, 231, 0.38)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.setLineDash([6, 10]);
    ctx.lineDashOffset = -(view.now / 40) % 16;
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.lineTo(tx - (dx / dist) * 26, ty - (dy / dist) * 26);
    ctx.stroke();

    // Reticle pulsing around the aimed bar.
    const pulse = 0.82 + 0.18 * Math.sin(view.now / 220);
    ctx.globalAlpha = 0.45;
    ctx.setLineDash([5, 7]);
    ctx.beginPath();
    ctx.arc(tx, ty, 34 * pulse, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // ----------------------------------------------------------------
  // units: crayon letter blocks
  // ----------------------------------------------------------------

  /**
   * Units are BLANK — this is a dictation game, the target word must never
   * be visible. The player's typed characters render on the blocks in the
   * app's classic serif; letters confirmed on earlier attempts stay drawn in
   * green. The FIRST alive unit carries a little hand-drawn face so the
   * falling bar still reads as a tiny caterpillar critter.
   */
  private drawUnits(
    units: UnitHandle[],
    typed: string,
    revealed: string,
    wrongFlash: Record<number, number>,
    now: number
  ): void {
    const ctx = this.ctx;
    const flashAlpha =
      now < this.unitFlashUntil ? 0.75 * ((this.unitFlashUntil - now) / UNIT_FLASH_MS) : 0;

    ctx.save();
    // Non-lethal hit: the whole bar jiggles horizontally but nothing breaks
    // (render-layer only — the physics bodies keep their exact fall).
    const shakeAge = now - this.brickShakeAt;
    if (shakeAge >= 0 && shakeAge < BRICK_SHAKE_MS) {
      const t = shakeAge / BRICK_SHAKE_MS;
      ctx.translate(Math.sin(t * Math.PI * 5) * 8 * (1 - t), 0);
    }

    units.forEach((handle, aliveIndex) => {
      const body = handle.body;
      const { x, y } = body.position;
      const w = body.bounds.max.x - body.bounds.min.x;
      const h = body.bounds.max.y - body.bounds.min.y;
      const typedChar = typed[handle.unitIndex];
      const wordId = (body.plugin as { wordId?: string } | undefined)?.wordId ?? '';
      const paletteLen = this.blockImgs.length > 0 ? this.blockImgs.length : CRAYON.blockFills.length;
      const colorIndex = (hashString(wordId) + handle.unitIndex) % paletteLen;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(body.angle);

      // Soft drop shadow — lifts blocks off the grass.
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = '#1E3A24';
      ctx.beginPath();
      ctx.roundRect(-w / 2 + 2, -h / 2 + 3, w, h, w * 0.18);
      ctx.fill();
      ctx.restore();

      const img = this.blockImgs[colorIndex % Math.max(this.blockImgs.length, 1)];
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
      } else {
        ctx.drawImage(
          this.getProceduralBlockFace(Math.round((w + h) / 2), colorIndex),
          -w / 2,
          -h / 2,
          w,
          h
        );
      }

      if (flashAlpha > 0) {
        ctx.globalAlpha = flashAlpha;
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.roundRect(-w / 2, -h / 2, w, h, w * 0.18);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Wrongly-typed tile: red flash that fades out — "this letter is wrong",
      // while the bar itself stays intact for the next attempt.
      const wrongUntil = wrongFlash[handle.unitIndex];
      if (wrongUntil != null && now < wrongUntil) {
        ctx.globalAlpha = 0.6 * ((wrongUntil - now) / WRONG_FLASH_MS);
        ctx.fillStyle = '#E23D3D';
        ctx.beginPath();
        ctx.roundRect(-w / 2, -h / 2, w, h, w * 0.18);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Live typed echo wins over the confirmed letters beneath it.
      const revealedChar = revealed[handle.unitIndex] || '';
      const displayChar = typedChar || revealedChar;
      if (displayChar) {
        ctx.font = `600 ${Math.floor(h * 0.58)}px ${CRAYON.glyphFont}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Chalk halo keeps the glyph readable on every pastel.
        ctx.lineWidth = 3;
        ctx.strokeStyle = CRAYON.glyphHalo;
        ctx.strokeText(displayChar, 0, 1);
        // Confirmed letters draw green — progress the player has banked;
        // the live typed echo stays chalk like before.
        ctx.fillStyle = typedChar ? CRAYON.glyph : '#1E9E50';
        ctx.fillText(displayChar, 0, 1);
      } else if (aliveIndex === 0) {
        // The caterpillar's face rides on the leading segment.
        const eyeR = Math.max(3, w * 0.11);
        const pupilR = eyeR * 0.45;
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.arc(-w * 0.18, -h * 0.12, eyeR, 0, TAU);
        ctx.arc(w * 0.18, -h * 0.12, eyeR, 0, TAU);
        ctx.fill();
        ctx.fillStyle = CRAYON.glyph;
        ctx.beginPath();
        ctx.arc(-w * 0.16, -h * 0.08, pupilR, 0, TAU);
        ctx.arc(w * 0.2, -h * 0.08, pupilR, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = CRAYON.glyph;
        ctx.lineWidth = Math.max(1.5, w * 0.05);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(0, h * 0.06, w * 0.18, 0.25 * Math.PI, 0.75 * Math.PI);
        ctx.stroke();
      }

      ctx.restore();
    });

    // Pops the whole-bar shake translate opened above.
    ctx.restore();
  }

  /**
   * Procedural crayon block face (fallback when no block textures are
   * loaded): pastel paper fill, sketchy double-stroke border, corner
   * highlight — cached per (size, color) at 2× for crispness.
   */
  private getProceduralBlockFace(size: number, colorIndex: number): HTMLCanvasElement {
    const key = `${size}|${colorIndex}`;
    const hit = this.blockFaceCache.get(key);
    if (hit) return hit;

    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, size * scale);
    canvas.height = Math.max(2, size * scale);
    const c = canvas.getContext('2d');
    if (c) {
      c.scale(scale, scale);
      const s = size;
      const r = s * 0.18;
      const fill = CRAYON.blockFills[colorIndex % CRAYON.blockFills.length];
      const stroke = CRAYON.blockStrokes[colorIndex % CRAYON.blockStrokes.length];

      c.fillStyle = fill;
      c.beginPath();
      c.roundRect(0.5, 0.5, s - 1, s - 1, r);
      c.fill();

      // Crayon grain: faint diagonal sweeps.
      c.save();
      c.beginPath();
      c.roundRect(0.5, 0.5, s - 1, s - 1, r);
      c.clip();
      c.globalAlpha = 0.09;
      c.strokeStyle = '#FFFFFF';
      c.lineWidth = 2;
      for (let i = -s; i < s * 2; i += 5) {
        c.beginPath();
        c.moveTo(i, 0);
        c.lineTo(i + s, s);
        c.stroke();
      }
      c.restore();

      // Sketchy hand-drawn border: two slightly-rotated passes.
      c.strokeStyle = stroke;
      c.lineCap = 'round';
      c.lineWidth = 2;
      c.save();
      c.translate(s / 2, s / 2);
      c.rotate(0.012);
      c.beginPath();
      c.roundRect(-s / 2 + 2, -s / 2 + 2, s - 4, s - 4, r);
      c.stroke();
      c.restore();
      c.save();
      c.translate(s / 2, s / 2);
      c.rotate(-0.009);
      c.globalAlpha = 0.7;
      c.lineWidth = 1.4;
      c.beginPath();
      c.roundRect(-s / 2 + 2.5, -s / 2 + 2.5, s - 5, s - 5, r * 0.9);
      c.stroke();
      c.restore();

      // Soft top-left highlight.
      c.globalAlpha = 0.35;
      c.fillStyle = '#FFFFFF';
      c.beginPath();
      c.ellipse(s * 0.3, s * 0.22, s * 0.17, s * 0.07, -0.5, 0, TAU);
      c.fill();
      c.globalAlpha = 1;
    }
    this.blockFaceCache.set(key, canvas);
    return canvas;
  }

  // ----------------------------------------------------------------
  // ghosts: retired — spawn positions are off-screen in the side view
  // (the feed type survives in the view interface for component compat)
  // ----------------------------------------------------------------

  private drawGhosts(ghosts: WordStrikeGhost[], now: number): void {
    const ctx = this.ctx;
    for (const ghost of ghosts) {
      const age = now - ghost.bornAt;
      const alpha = GHOST_ALPHA * Math.min(1, age / 160);
      const pulse = 0.85 + 0.15 * Math.sin(now / 300);

      ctx.save();
      ctx.translate(ghost.x, ghost.y);
      ctx.globalAlpha = alpha * pulse;

      ctx.strokeStyle = CRAYON.chalk;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(-21, -21, 42, 42);
      ctx.setLineDash([]);

      ctx.font = `600 30px ${CRAYON.glyphFont}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = CRAYON.chalk;
      ctx.fillText(ghost.letter, 0, 1);

      ctx.restore();
    }
  }

  // ----------------------------------------------------------------
  // debris: crayon paper bits
  // ----------------------------------------------------------------

  private drawDebris(debris: Matter.Body[], now: number): void {
    const ctx = this.ctx;
    for (const body of debris) {
      const bornAt = (body.plugin as { bornAt?: number } | undefined)?.bornAt ?? now;
      const ageRatio = Math.min(1, (now - bornAt) / 1200);
      const alpha = Math.max(DEBRIS_ALPHA_FLOOR, 0.9 - ageRatio * 0.75);
      const colorIndex = body.id % CRAYON.blockFills.length;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = CRAYON.blockFills[colorIndex];
      ctx.strokeStyle = CRAYON.blockStrokes[colorIndex];
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';

      // body.vertices are already world-space (rotation applied) — draw them
      // directly; translating + rotating here would rotate twice.
      const parts = body.parts.length > 1 ? body.parts.slice(1) : body.parts;
      for (const part of parts) {
        ctx.beginPath();
        part.vertices.forEach((v, i) => {
          if (i === 0) ctx.moveTo(v.x, v.y);
          else ctx.lineTo(v.x, v.y);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // ----------------------------------------------------------------
  // bullets: energy bolts with direction-aware trails
  // ----------------------------------------------------------------

  private drawBullets(bullets: Matter.Body[]): void {
    const ctx = this.ctx;
    for (const bullet of bullets) {
      const { x, y } = bullet.position;
      const vx = bullet.velocity.x;
      const vy = bullet.velocity.y;
      const speed = Math.hypot(vx, vy);
      const ux = speed > 0 ? vx / speed : 0;
      const uy = speed > 0 ? vy / speed : -1;

      // Trailing streak opposite the travel direction (any angle).
      ctx.save();
      ctx.strokeStyle = CRAYON.bulletGlow;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - ux * speed * 2.2, y - uy * speed * 2.2);
      ctx.stroke();

      ctx.shadowColor = CRAYON.bulletGlow;
      ctx.shadowBlur = 12;
      ctx.fillStyle = CRAYON.bulletCore;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, TAU);
      ctx.fill();
      ctx.restore();

      // Ambient spark dropout along the trail.
      if (Math.random() < 0.35) {
        this.particles.spawnTrailSpark(x - ux * 8, y - uy * 8);
      }
    }
  }

  // ----------------------------------------------------------------
  // the monster gunner
  // ----------------------------------------------------------------

  private drawMonster(view: WordStrikeView): void {
    const ctx = this.ctx;
    const { now, recoil, lastShotAt } = view;
    // Feet ride the elevator platform (the caller already smooths the Y).
    const feetY = Math.min(ELEVATOR.bottomFeetY, Math.max(ELEVATOR.topFeetY, view.elevatorFeetY));
    const pivotY = feetY - ELEVATOR.gunOffsetY;
    const frame = this.monster.resolveFrame(now);
    const aim = this.monster.aimAngle;
    const breathe = 1 + 0.022 * Math.sin(now / 650);

    // Shadow on the platform under the feet, drawn in world space.
    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = '#23401F';
    ctx.beginPath();
    ctx.ellipse(MONSTER.x + 6, feetY + 3, MONSTER.height * 0.34, MONSTER.height * 0.07, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Recoil kicks the body backwards along the aim axis (level shot: mostly left).
    const kickX = -Math.cos(aim) * recoil * 9;
    const kickY = -Math.sin(aim) * recoil * 9;

    ctx.save();
    ctx.translate(MONSTER.x + kickX, feetY + kickY);

    if (frame.img && frame.isStrikeFrame) {
      // Side-view gunner: drawn upright, NEVER rotated — the gun is baked
      // into the art pointing right; feet stay planted on the platform.
      // The frame's transparent bottom padding is compensated so the painted
      // feet sit ON the board instead of floating above it.
      const frameH = MONSTER_SPRITE_HEIGHT * MONSTER_FRAME_SCALE;
      const pad = this.monster.getBottomPadFrac(frame.img) * frameH;
      ctx.scale(breathe, breathe);
      ctx.drawImage(frame.img, -frameH / 2, -frameH + pad, frameH, frameH);
    } else {
      // Legacy art / vector blob: body upright, only the procedural gun swings.
      if (frame.img) {
        const squash = 1 - recoil * 0.1;
        const s = MONSTER_SPRITE_HEIGHT * 0.84;
        const pad = this.monster.getBottomPadFrac(frame.img) * s;
        ctx.scale(breathe + recoil * 0.06, squash);
        ctx.drawImage(frame.img, -s * 0.5, -s + pad, s, s);
      } else {
        this.drawVectorBlob(MONSTER_SPRITE_HEIGHT, breathe);
      }
      ctx.save();
      // The procedural gun's local frame aims -y; rotate(aim + π/2) sends
      // aim=0 to straight right. Never applied to the baked-in strike art.
      ctx.translate(TURRET.pivotX - MONSTER.x, pivotY - feetY);
      ctx.rotate(aim + Math.PI / 2);
      this.drawToyGun(recoil);
      ctx.restore();
    }
    ctx.restore();

    // Muzzle core flash (world coords, right at the bolt spawn point).
    if (now - lastShotAt < 90) {
      const mx = TURRET.pivotX + Math.cos(aim) * TURRET.muzzleLength;
      const my = pivotY + Math.sin(aim) * TURRET.muzzleLength;
      ctx.save();
      ctx.globalAlpha = 1 - (now - lastShotAt) / 90;
      ctx.shadowColor = '#FFE9A8';
      ctx.shadowBlur = 14;
      ctx.fillStyle = CRAYON.bulletCore;
      ctx.beginPath();
      ctx.arc(mx, my, 9, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  /** Procedural toy blaster for the legacy/blob tiers (local frame, aims -y). */
  private drawToyGun(recoil: number): void {
    const ctx = this.ctx;
    const kick = recoil * 7;
    ctx.save();
    ctx.translate(0, kick);
    ctx.strokeStyle = '#B8A88F';
    ctx.lineWidth = 2;

    ctx.fillStyle = '#F7F1E3'; // cream barrel
    ctx.beginPath();
    ctx.roundRect(-6, -92, 12, 58, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#F4A259'; // muzzle ring
    ctx.beginPath();
    ctx.roundRect(-8, -96, 16, 11, 5);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#7FB069'; // chunky grip body
    ctx.beginPath();
    ctx.roundRect(-9, -38, 18, 26, 8);
    ctx.fill();
    ctx.stroke();

    ctx.restore();
  }

  /** Vector fallback gunner — chubby blob with a face, until any art loads. */
  private drawVectorBlob(size: number, breathe: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(breathe, 2 - breathe);
    ctx.fillStyle = '#E7DCC8';
    ctx.strokeStyle = '#B8A88F';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(0, -size * 0.42, size * 0.4, size * 0.44, 0, 0, TAU);
    ctx.fill();
    ctx.stroke();
    // Face (toward the aim direction, up).
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(-size * 0.1, -size * 0.52, size * 0.055, 0, TAU);
    ctx.arc(size * 0.1, -size * 0.52, size * 0.055, 0, TAU);
    ctx.fill();
    ctx.fillStyle = CRAYON.glyph;
    ctx.beginPath();
    ctx.arc(-size * 0.09, -size * 0.515, size * 0.024, 0, TAU);
    ctx.arc(size * 0.11, -size * 0.515, size * 0.024, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = CRAYON.glyph;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, -size * 0.36, size * 0.07, 0.25 * Math.PI, 0.75 * Math.PI);
    ctx.stroke();
    ctx.restore();
  }

  // ----------------------------------------------------------------
  // hurt vignette + floaters
  // ----------------------------------------------------------------

  private drawHurtVignette(now: number): void {
    const age = now - this.hurtFlashAt;
    if (age > HURT_FLASH_MS) return;
    const decay = 1 - age / HURT_FLASH_MS;
    const ctx = this.ctx;
    const grad = ctx.createRadialGradient(
      LOGICAL_WORLD.width / 2,
      LOGICAL_WORLD.height / 2,
      170,
      LOGICAL_WORLD.width / 2,
      LOGICAL_WORLD.height / 2,
      640
    );
    grad.addColorStop(0, 'rgba(255, 60, 60, 0)');
    grad.addColorStop(1, `rgba(255, 60, 60, ${(0.4 * decay).toFixed(3)})`);
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, LOGICAL_WORLD.width, LOGICAL_WORLD.height);
    ctx.restore();
  }

  private drawFloaters(floaters: WordStrikeFloater[], now: number): void {
    const ctx = this.ctx;
    for (const floater of floaters) {
      const age = now - floater.bornAt;
      if (age > FLOATER_LIFETIME_MS) continue;
      const progress = age / FLOATER_LIFETIME_MS;

      ctx.save();
      ctx.globalAlpha = 1 - progress;
      ctx.font = `700 18px ${CRAYON.monoFont}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255, 248, 231, 0.9)';
      ctx.strokeText(floater.text, floater.x, floater.y - progress * FLOATER_RISE_PX_PER_S);
      ctx.fillStyle = floater.color;
      ctx.fillText(floater.text, floater.x, floater.y - progress * FLOATER_RISE_PX_PER_S);
      ctx.restore();
    }
  }
}
