// ================================================================
// WORD STRIKE — lightweight canvas particle system (view-layer only).
//
// A fixed pool of 256 slots (cursor overwrite, zero allocation per frame)
// drives all combat feedback: muzzle flashes, impact shockwaves, star
// sparks, letter debris on word kills, crayon chunks, hurt bursts. The
// system is purely decorative — it never touches physics bodies, and it is
// the ONLY place letters may fly around as particles: the life-loss
// explosion path (spawnBrickExplosion) deliberately carries NO letters so a
// lost brick never spoils the word (dictation anti-cheat).
//
// Coordinates are logical-world (900×640); the renderer draws this under its
// letterbox transform. Velocities are px/second.
// ================================================================

export type ParticleKind = 'spark' | 'ring' | 'star' | 'letter' | 'chunk' | 'muzzle';

export interface Particle {
  active: boolean;
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** ms remaining. */
  life: number;
  /** ms total — used for easing by the draw pass. */
  maxLife: number;
  size: number;
  rot: number;
  /** rad/s spin. */
  vr: number;
  color: string;
  /** 'letter' particles only. */
  letter?: string;
  /** px/s² downward pull ('letter' and 'chunk' particles). */
  gravity: number;
}

/** One falling-bar unit snapshot for burst emitters. Letters are OPTIONAL —
 *  only ever provided on the word-kill path, never on life loss. */
export interface ParticleBurstUnit {
  x: number;
  y: number;
  letter?: string;
  color?: string;
}

const MAX_PARTICLES = 256;
const TAU = Math.PI * 2;

export const CRAYON_PALETTE = ['#F25C54', '#F4A259', '#F7D488', '#7FB069', '#5B9BD1', '#9B7EDE'] as const;

export class WordStrikeParticleSystem {
  private pool: Particle[] = [];
  private cursor = 0;

  constructor() {
    for (let i = 0; i < MAX_PARTICLES; i += 1) {
      this.pool.push({
        active: false,
        kind: 'spark',
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        life: 0,
        maxLife: 1,
        size: 0,
        rot: 0,
        vr: 0,
        color: '#FFFFFF',
        gravity: 0,
      });
    }
  }

  get activeCount(): number {
    let n = 0;
    for (const p of this.pool) if (p.active) n += 1;
    return n;
  }

  /** First free slot from the cursor; if the pool is saturated, overwrite the
   *  oldest frontier instead of growing — bursts stay visually capped. */
  private next(): Particle {
    for (let i = 0; i < MAX_PARTICLES; i += 1) {
      const idx = (this.cursor + i) % MAX_PARTICLES;
      if (!this.pool[idx].active) {
        this.cursor = (idx + 1) % MAX_PARTICLES;
        return this.pool[idx];
      }
    }
    const p = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    return p;
  }

  private spawn(init: {
    kind: ParticleKind;
    x: number;
    y: number;
    vx?: number;
    vy?: number;
    life: number;
    size?: number;
    rot?: number;
    vr?: number;
    color?: string;
    letter?: string;
    gravity?: number;
  }): void {
    const p = this.next();
    p.active = true;
    p.kind = init.kind;
    p.x = init.x;
    p.y = init.y;
    p.vx = init.vx ?? 0;
    p.vy = init.vy ?? 0;
    p.life = init.life;
    p.maxLife = init.life;
    p.size = init.size ?? 3;
    p.rot = init.rot ?? 0;
    p.vr = init.vr ?? 0;
    p.color = init.color ?? '#FFF8E7';
    p.letter = init.letter;
    p.gravity = init.gravity ?? 0;
  }

  // ----------------------------------------------------------------
  // integration
  // ----------------------------------------------------------------

  update(dtMs: number): void {
    const dt = dtMs / 1000;
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life -= dtMs;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
  }

  // ----------------------------------------------------------------
  // emitters
  // ----------------------------------------------------------------

  /** Gun discharge: expanding 4-point star + forward spark cone. */
  spawnMuzzleFlash(x: number, y: number, angle: number): void {
    this.spawn({ kind: 'muzzle', x, y, life: 130, size: 9, rot: angle, color: '#FFF3C4' });
    for (let i = 0; i < 6; i += 1) {
      const spread = ((Math.random() - 0.5) * 50 * Math.PI) / 180;
      const a = angle + spread;
      const speed = 160 + Math.random() * 180;
      this.spawn({
        kind: 'spark',
        x,
        y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        life: 180 + Math.random() * 160,
        size: 1.4 + Math.random() * 1.6,
        color: Math.random() < 0.5 ? '#FFE9A8' : '#9FE8FF',
      });
    }
  }

  /** Bullet ↔ block connect: double shockwave ring + back-splashing stars. */
  spawnImpact(x: number, y: number, travelAngle: number): void {
    this.spawn({ kind: 'ring', x, y, life: 240, size: 30, color: '#9FE8FF' });
    this.spawn({ kind: 'ring', x, y, life: 360, size: 52, color: '#FFFFFF' });
    const count = 8 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i += 1) {
      const a = travelAngle + Math.PI + (Math.random() - 0.5) * 2.6;
      const speed = 110 + Math.random() * 240;
      const star = Math.random() < 0.35;
      this.spawn({
        kind: star ? 'star' : 'spark',
        x,
        y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        life: 260 + Math.random() * 220,
        size: star ? 3.5 + Math.random() * 2.5 : 1.6 + Math.random() * 1.4,
        rot: Math.random() * TAU,
        vr: (Math.random() - 0.5) * 14,
        color: star ? '#FFE9A8' : Math.random() < 0.5 ? '#9FE8FF' : '#FFFFFF',
        gravity: star ? 260 : 0,
      });
    }
  }

  /**
   * WORD-KILL celebration: every letter of the word pops off its block and
   * tumbles away, plus crayon chunks. Letters are reveal-allowed here — the
   * word was just completed, nothing left to spoil.
   */
  spawnWordBurst(units: ParticleBurstUnit[], barCenter?: { x: number; y: number }): void {
    if (barCenter) {
      this.spawn({ kind: 'ring', x: barCenter.x, y: barCenter.y, life: 420, size: 90, color: '#FFE9A8' });
    }
    for (const unit of units) {
      if (unit.letter) {
        this.spawn({
          kind: 'letter',
          x: unit.x,
          y: unit.y,
          vx: (Math.random() - 0.5) * 260,
          vy: -120 - Math.random() * 160,
          life: 820 + Math.random() * 180,
          size: 26,
          rot: (Math.random() - 0.5) * 0.8,
          vr: (Math.random() - 0.5) * 7,
          color: '#33323B',
          letter: unit.letter,
          gravity: 460,
        });
      }
      for (let i = 0; i < 3; i += 1) {
        const a = Math.random() * TAU;
        const speed = 60 + Math.random() * 190;
        this.spawn({
          kind: 'chunk',
          x: unit.x,
          y: unit.y,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed - 70,
          life: 520 + Math.random() * 260,
          size: 3 + Math.random() * 4.5,
          rot: Math.random() * TAU,
          vr: (Math.random() - 0.5) * 12,
          color: unit.color ?? CRAYON_PALETTE[Math.floor(Math.random() * CRAYON_PALETTE.length)],
          gravity: 420,
        });
      }
    }
  }

  /**
   * LIFE-LOSS explosion: chunks and sparks ONLY — deliberately no letters,
   * so a brick that reached the fence never reveals its word.
   */
  spawnBrickExplosion(units: ParticleBurstUnit[], barCenter?: { x: number; y: number }): void {
    if (barCenter) {
      this.spawn({ kind: 'ring', x: barCenter.x, y: barCenter.y, life: 420, size: 100, color: '#FF5A4E' });
      this.spawn({ kind: 'ring', x: barCenter.x, y: barCenter.y, life: 560, size: 60, color: '#FFFFFF' });
    }
    for (const unit of units) {
      for (let i = 0; i < 5; i += 1) {
        const a = Math.random() * TAU;
        const speed = 80 + Math.random() * 240;
        this.spawn({
          kind: 'chunk',
          x: unit.x,
          y: unit.y,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed - 90,
          life: 560 + Math.random() * 280,
          size: 3.5 + Math.random() * 5,
          rot: Math.random() * TAU,
          vr: (Math.random() - 0.5) * 14,
          color: unit.color ?? CRAYON_PALETTE[Math.floor(Math.random() * CRAYON_PALETTE.length)],
          gravity: 430,
        });
      }
      this.spawn({
        kind: 'star',
        x: unit.x,
        y: unit.y,
        vx: (Math.random() - 0.5) * 160,
        vy: -80 - Math.random() * 140,
        life: 400 + Math.random() * 200,
        size: 4 + Math.random() * 3,
        rot: Math.random() * TAU,
        vr: (Math.random() - 0.5) * 10,
        color: '#FFB3A7',
        gravity: 300,
      });
    }
  }

  /** Small ambient spark dropped behind a travelling bullet. */
  spawnTrailSpark(x: number, y: number): void {
    this.spawn({
      kind: 'spark',
      x,
      y,
      vx: (Math.random() - 0.5) * 40,
      vy: (Math.random() - 0.5) * 40 + 20,
      life: 160 + Math.random() * 120,
      size: 1.2 + Math.random() * 1.2,
      color: '#9FE8FF',
    });
  }

  // ----------------------------------------------------------------
  // draw
  // ----------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D, now: number): void {
    for (const p of this.pool) {
      if (!p.active) continue;
      const progress = 1 - p.life / p.maxLife; // 0 → 1
      const alpha = Math.max(0, 1 - progress);

      switch (p.kind) {
        case 'spark': {
          ctx.save();
          ctx.globalAlpha = alpha * 0.9;
          ctx.shadowColor = p.color;
          ctx.shadowBlur = 6;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * (1 - progress * 0.5), 0, TAU);
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'ring': {
          ctx.save();
          ctx.globalAlpha = alpha * 0.75;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 2.5 * (1 - progress) + 0.5;
          ctx.beginPath();
          // Ease-out expansion: fast burst, gentle settle.
          const eased = 1 - (1 - progress) * (1 - progress);
          ctx.arc(p.x, p.y, 4 + eased * p.size, 0, TAU);
          ctx.stroke();
          ctx.restore();
          break;
        }
        case 'star': {
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.color;
          this.drawStar(ctx, p.size * (1 - progress * 0.4));
          ctx.restore();
          break;
        }
        case 'muzzle': {
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.shadowColor = '#FFE9A8';
          ctx.shadowBlur = 12;
          ctx.fillStyle = p.color;
          this.drawStar(ctx, p.size + progress * 26, 0.42);
          ctx.restore();
          break;
        }
        case 'chunk': {
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.color;
          const s = p.size;
          ctx.beginPath();
          ctx.roundRect(-s / 2, -s / 2, s, s, s * 0.3);
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'letter': {
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          // Pop-in scale: overshoot then settle.
          const pop = progress < 0.25 ? 0.6 + (progress / 0.25) * 0.55 : 1.15 - (progress - 0.25) * 0.2;
          ctx.scale(pop, pop);
          ctx.font = `700 ${p.size}px "Playfair Display", Georgia, serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.lineWidth = 4;
          ctx.strokeStyle = 'rgba(255, 248, 231, 0.9)';
          ctx.strokeText(p.letter ?? '', 0, 0);
          ctx.fillStyle = p.color;
          ctx.fillText(p.letter ?? '', 0, 0);
          ctx.restore();
          break;
        }
      }
    }
  }

  /** 4-point sparkle star (elongated diamond cross). */
  private drawStar(ctx: CanvasRenderingContext2D, radius: number, inner = 0.36): void {
    ctx.beginPath();
    for (let i = 0; i < 8; i += 1) {
      const r = i % 2 === 0 ? radius : radius * inner;
      const a = (i / 8) * TAU - Math.PI / 2;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }
}
