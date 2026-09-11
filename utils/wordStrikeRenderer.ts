// ================================================================
// WORD STRIKE — canvas renderer.
//
// Custom neon rendering on top of the physics world (Matter.Render is NOT
// used — the app's dark/neon theme needs real drawing control). The canvas is
// transparent; the game component's CSS overlay supplies the radial-gradient
// + grid backdrop shared by all game modes.
//
// The renderer letterboxes the FIXED 900×640 logical world onto whatever
// canvas size the ResizeObserver reports, multiplying by devicePixelRatio so
// strokes stay crisp on retina. All per-frame high-frequency data (ghosts,
// floaters, typed echo) arrives via the `view` argument — the React layer
// keeps it in refs and never re-renders for animation frames.
//
// Draw order: shake → units → ghosts (revealed letters) → debris → bullets →
// MISS floaters → launcher turret → kill line.
// ================================================================
import * as Matter from 'matter-js';
import { WordStrikePhysics, UnitHandle, LOGICAL_WORLD, LAUNCHER, KILL_LINE_Y } from './wordStrikePhysics';

const THEME = {
  unitFill: '#0F0F20',
  unitStroke: '#00F0FF',
  unitGlow: 'rgba(0, 240, 255, 0.55)',
  ghostStroke: '#2EE67C',
  ghostGlow: 'rgba(46, 230, 124, 0.4)',
  bulletCore: '#FFFFFF',
  bulletTrail: 'rgba(0, 240, 255, 0.8)',
  missColor: '#FF4D4F',
  launcherStroke: '#00F0FF',
  launcherFill: '#1A1A2E',
  killLine: 'rgba(187, 0, 255, 0.5)',
  debrisStroke: '#00F0FF',
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

export interface WordStrikeView {
  ghosts: WordStrikeGhost[];
  floaters: WordStrikeFloater[];
  lastShotAt: number;
  recoil: number;
  /** What the player has typed this attempt — drawn ON the alive units. */
  typed: string;
  /** Danger glow 0-1 as the brick nears the kill line (computed by the caller). */
  danger: number;
  now: number;
}

const FLOATER_RISE_PX_PER_S = 40;
const FLOATER_LIFETIME_MS = 700;
const GHOST_ALPHA = 0.45;
const DEBRIS_ALPHA_FLOOR = 0.15;

export class WordStrikeRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private dpr = 1;
  /** The app's daily monster (public/monsterImages/M{day}.webp) mans the turret. */
  private monsterImg: HTMLImageElement | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('WordStrikeRenderer: 2D canvas context unavailable');
    }
    this.ctx = ctx;
  }

  /** Preload the daily monster art; falls back to a vector turret until loaded. */
  setMonsterImage(src: string): void {
    const img = new Image();
    img.onload = () => {
      this.monsterImg = img;
    };
    img.src = src;
  }

  /**
   * Letterbox fit: uniform scale + centering offsets. Physics world stays
   * untouched — only the view transform changes.
   */
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

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(s, 0, 0, s, this.offsetX * dpr, this.offsetY * dpr);

    // Screen shake — view-layer only, physics world is never displaced.
    ctx.translate(physics.shakeOffset.x, physics.shakeOffset.y);

    this.drawKillLine(view.danger);
    this.drawDebris(physics.getDebris(), view.now);
    this.drawGhosts(view.ghosts, view.now);
    this.drawUnits(physics.getAliveUnits(), view.typed);
    this.drawBullets(physics.getBullets());
    this.drawFloaters(view.floaters, view.now);
    this.drawLauncher(view.lastShotAt, view.recoil, view.now);
  }

  // ----------------------------------------------------------------
  // world pieces
  // ----------------------------------------------------------------

  /**
   * Units are BLANK — this is a dictation game, the target word must never
   * be visible. The player's typed characters render directly on the units
   * (typed[i] on the unit whose position is i), in the app's classic serif.
   *
   * Visual: soft candy tiles; the FIRST alive unit carries a little face, so
   * the falling bar reads as a tiny caterpillar monster (matches the app's
   * cute MONSTER art direction).
   */
  private drawUnits(units: UnitHandle[], typed: string): void {
    const ctx = this.ctx;
    units.forEach((handle, aliveIndex) => {
      const body = handle.body;
      const { x, y } = body.position;
      const w = body.bounds.max.x - body.bounds.min.x;
      const h = body.bounds.max.y - body.bounds.min.y;
      const radius = Math.min(w, h) * 0.28;
      const typedChar = typed[handle.unitIndex];

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(body.angle);

      // Candy body: soft vertical gradient.
      const grad = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
      grad.addColorStop(0, '#34345a');
      grad.addColorStop(1, '#14142b');
      ctx.shadowColor = THEME.unitGlow;
      ctx.shadowBlur = 12;
      ctx.fillStyle = grad;
      this.roundRect(-w / 2, -h / 2, w, h, radius);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Glossy top highlight.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.09)';
      this.roundRect(-w / 2 + 3, -h / 2 + 3, w - 6, h * 0.3, radius * 0.7);
      ctx.fill();

      ctx.lineWidth = 2;
      ctx.strokeStyle = THEME.unitStroke;
      this.roundRect(-w / 2, -h / 2, w, h, radius);
      ctx.stroke();

      if (typedChar) {
        ctx.font = `600 ${Math.floor(h * 0.58)}px ${THEME.glyphFont}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.fillText(typedChar, 0, 1);
      } else if (aliveIndex === 0) {
        // The caterpillar's face rides on the leading segment.
        const eyeR = Math.max(3, w * 0.11);
        const pupilR = eyeR * 0.45;
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.arc(-w * 0.18, -h * 0.12, eyeR, 0, Math.PI * 2);
        ctx.arc(w * 0.18, -h * 0.12, eyeR, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#1A1A2E';
        ctx.beginPath();
        ctx.arc(-w * 0.16, -h * 0.08, pupilR, 0, Math.PI * 2);
        ctx.arc(w * 0.2, -h * 0.08, pupilR, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = Math.max(1.5, w * 0.05);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(0, h * 0.06, w * 0.18, 0.25 * Math.PI, 0.75 * Math.PI);
        ctx.stroke();
      }

      ctx.restore();
    });
  }

  /** Revealed letters: frozen outline slots where units were destroyed. */
  private drawGhosts(ghosts: WordStrikeGhost[], now: number): void {
    const ctx = this.ctx;
    for (const ghost of ghosts) {
      const age = now - ghost.bornAt;
      const alpha = GHOST_ALPHA * Math.min(1, age / 160);
      const pulse = 0.85 + 0.15 * Math.sin(now / 300);

      ctx.save();
      ctx.translate(ghost.x, ghost.y);
      ctx.globalAlpha = alpha * pulse;
      ctx.shadowColor = THEME.ghostGlow;
      ctx.shadowBlur = 10;

      ctx.strokeStyle = THEME.ghostStroke;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(-21, -21, 42, 42);
      ctx.setLineDash([]);

      ctx.font = `600 30px ${THEME.glyphFont}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = THEME.ghostStroke;
      ctx.fillText(ghost.letter, 0, 1);

      ctx.restore();
    }
  }

  private drawDebris(debris: Matter.Body[], now: number): void {
    const ctx = this.ctx;
    for (const body of debris) {
      const bornAt = (body.plugin as { bornAt?: number } | undefined)?.bornAt ?? now;
      const ageRatio = Math.min(1, (now - bornAt) / 1200);
      const alpha = Math.max(DEBRIS_ALPHA_FLOOR, 0.9 - ageRatio * 0.75);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#34345a';
      // Alternate candy tints so the burst feels playful, not metallic.
      ctx.strokeStyle = body.id % 2 === 0 ? THEME.debrisStroke : '#BB00FF';
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

  private drawBullets(bullets: Matter.Body[]): void {
    const ctx = this.ctx;
    for (const bullet of bullets) {
      const { x, y } = bullet.position;
      const vy = bullet.velocity.y;

      // Trailing streak opposite the travel direction.
      ctx.save();
      ctx.strokeStyle = THEME.bulletTrail;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - vy * 2.2);
      ctx.stroke();

      ctx.shadowColor = THEME.bulletTrail;
      ctx.shadowBlur = 12;
      ctx.fillStyle = THEME.bulletCore;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawFloaters(floaters: WordStrikeFloater[], now: number): void {
    const ctx = this.ctx;
    for (const floater of floaters) {
      const age = now - floater.bornAt;
      if (age > FLOATER_LIFETIME_MS) continue;
      const progress = age / FLOATER_LIFETIME_MS;

      ctx.save();
      ctx.globalAlpha = 1 - progress;
      ctx.font = `700 18px ${THEME.monoFont}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = floater.color;
      ctx.shadowBlur = 8;
      ctx.fillStyle = floater.color;
      ctx.fillText(floater.text, floater.x, floater.y - progress * FLOATER_RISE_PX_PER_S);
      ctx.restore();
    }
  }

  // ----------------------------------------------------------------
  // launcher turret — the app's daily MONSTER mans a cute little cannon
  // ----------------------------------------------------------------

  private drawLauncher(lastShotAt: number, recoil: number, now: number): void {
    const ctx = this.ctx;
    const x = LAUNCHER.x;
    const barrelWidth = 20;
    const barrelHeight = LAUNCHER.baseY - 52 - LAUNCHER.barrelTopY;
    const kick = recoil * 8;

    ctx.save();

    // The daily monster (cute 3D blob) squashes on recoil — drawn FIRST so
    // the cannon it holds stays visible in front.
    const monsterSize = 92;
    const monsterBottom = LAUNCHER.baseY + 8;
    const squash = 1 - recoil * 0.12;
    ctx.save();
    ctx.translate(x, monsterBottom);
    ctx.scale(1 + recoil * 0.08, squash);
    if (this.monsterImg) {
      ctx.drawImage(this.monsterImg, -monsterSize / 2, -monsterSize, monsterSize, monsterSize);
    } else {
      // Vector fallback: chubby blob with a face, until the art loads.
      ctx.fillStyle = THEME.launcherFill;
      ctx.strokeStyle = THEME.launcherStroke;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, -monsterSize / 2, monsterSize * 0.42, monsterSize * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(-10, -monsterSize * 0.6, 6, 0, Math.PI * 2);
      ctx.arc(10, -monsterSize * 0.6, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1A1A2E';
      ctx.beginPath();
      ctx.arc(-8.5, -monsterSize * 0.57, 2.6, 0, Math.PI * 2);
      ctx.arc(11.5, -monsterSize * 0.57, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Cannon barrel sticking up in front of the monster, recoil dip.
    const barrelY = LAUNCHER.barrelTopY + kick;
    ctx.fillStyle = THEME.launcherFill;
    ctx.strokeStyle = THEME.launcherStroke;
    ctx.lineWidth = 2;
    ctx.shadowColor = THEME.launcherStroke;
    ctx.shadowBlur = 10;
    this.roundRect(x - barrelWidth / 2, barrelY, barrelWidth, barrelHeight + 16, barrelWidth / 2);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Muzzle flash
    if (now - lastShotAt < 90) {
      ctx.globalAlpha = 1 - (now - lastShotAt) / 90;
      ctx.fillStyle = THEME.bulletCore;
      ctx.beginPath();
      ctx.arc(x, barrelY - 4, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  private drawKillLine(danger: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = THEME.killLine;
    ctx.lineWidth = danger > 0 ? 1.5 + danger * 1.5 : 1;
    if (danger > 0) {
      ctx.shadowColor = THEME.missColor;
      ctx.shadowBlur = danger * 12;
    }
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.moveTo(30, KILL_LINE_Y);
    ctx.lineTo(LOGICAL_WORLD.width - 30, KILL_LINE_Y);
    ctx.stroke();
    ctx.restore();
  }

  // ----------------------------------------------------------------
  // helpers
  // ----------------------------------------------------------------

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.arcTo(x + w, y, x + w, y + radius, radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
    ctx.lineTo(x + radius, y + h);
    ctx.arcTo(x, y + h, x, y + h - radius, radius);
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.closePath();
  }
}
