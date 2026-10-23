// ================================================================
// WORD STRIKE — monster sprite animator (view-layer only).
//
// Owns the daily gunner's four SIDE-VIEW keyframe images (idle / shoot /
// hurt / cheer — all facing right), the timed one-shot animation states, and
// the smoothed aim angle. Image loading NEVER throws: every frame degrades
// independently so the game is playable at any asset-completion stage.
//
// The strike frames are drawn upright, never rotated — the gun is baked into
// the art pointing right. The smoothed aim angle still drives the muzzle FX
// direction and the legacy-tier procedural gun.
//
// Fallback ladder (resolved per draw):
//   strike keyframe → strike idle frame → legacy M{day}.webp (front-view,
//   drawn upright with only the procedural gun rotating) → vector blob.
// ================================================================
import type { WordStrikeSpritePaths } from '../services/wordStrike.ts';

export type MonsterAnimState = 'idle' | 'shoot' | 'hurt' | 'cheer';

const STATES: MonsterAnimState[] = ['idle', 'shoot', 'hurt', 'cheer'];

/** How long each one-shot state holds before relaxing to idle (ms). */
export const ANIM_STATE_MS: Record<Exclude<MonsterAnimState, 'idle'>, number> = {
  shoot: 150,
  cheer: 600,
  hurt: 500,
};

export interface ResolvedMonsterFrame {
  img: HTMLImageElement | null;
  /** True when a side-view strike frame is available (drawn as-is). */
  isStrikeFrame: boolean;
  state: MonsterAnimState;
}

export class WordStrikeMonsterSprite {
  private frames: Record<MonsterAnimState, HTMLImageElement | null> = {
    idle: null,
    shoot: null,
    hurt: null,
    cheer: null,
  };
  /** Mid-tier fallback: the app's existing front-view daily monster. */
  private legacyImg: HTMLImageElement | null = null;
  /** Per-image opaque-bottom fraction (0..1) — transparent padding between the
   *  lowest painted pixel and the frame edge, measured once at load so the
   *  renderer can seat the feet exactly on the platform. */
  private bottomPadFrac = new Map<HTMLImageElement, number>();

  private state: MonsterAnimState = 'idle';
  private stateUntil = 0;
  /** Current smoothed aim (atan2 radians). 0 = straight right (resting gun bearing). */
  private angle = 0;
  private targetAngle: number | null = null;

  /** Fire all four loads in parallel; each slot fills independently. */
  setFrames(paths: WordStrikeSpritePaths): void {
    for (const state of STATES) {
      this.frames[state] = null;
      this.loadInto(paths[state], (img) => {
        this.frames[state] = img;
      });
    }
  }

  /** Mid fallback tier — the pre-rework daily art. */
  setLegacyImage(src: string): void {
    this.legacyImg = null;
    this.loadInto(src, (img) => {
      this.legacyImg = img;
    });
  }

  private loadInto(src: string, assign: (img: HTMLImageElement) => void): void {
    const img = new Image();
    img.onload = () => {
      assign(img);
      this.measureBottomPad(img);
    };
    img.onerror = () => {}; // stay null — fallbacks handle it
    img.src = src;
  }

  /**
   * Generated art keeps a few percent of transparent padding under the feet,
   * which made the gunner float above the elevator board. Scan a downsampled
   * copy once for the lowest opaque row; the renderer offsets the draw by
   * exactly that fraction. Failure (tainted canvas, no 2d) just means the
   * frame draws unseated — same as before.
   */
  private measureBottomPad(img: HTMLImageElement): void {
    try {
      const size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;
      for (let y = size - 1; y >= 0; y -= 1) {
        for (let x = 0; x < size; x += 1) {
          if (data[(y * size + x) * 4 + 3] > 40) {
            this.bottomPadFrac.set(img, (size - 1 - y) / size);
            return;
          }
        }
      }
    } catch {
      // leave unmeasured — draw unseated
    }
  }

  /** Transparent padding (0..1 of frame height) under this image's feet. */
  getBottomPadFrac(img: HTMLImageElement): number {
    return this.bottomPadFrac.get(img) ?? 0;
  }

  /** Trigger a one-shot state; the latest trigger wins. Idle resets the timer. */
  triggerState(state: MonsterAnimState, durationMs?: number): void {
    this.state = state;
    this.stateUntil =
      state === 'idle' ? 0 : performance.now() + (durationMs ?? ANIM_STATE_MS[state]);
  }

  get currentState(): MonsterAnimState {
    return this.state;
  }

  /** per-frame aim feed: null relaxes the gun back to straight right. */
  setAimTarget(angle: number | null): void {
    this.targetAngle = angle;
  }

  get aimAngle(): number {
    return this.angle;
  }

  /** Advance timers + shortest-arc aim smoothing. Call once per draw. */
  update(now: number, dtMs: number): void {
    if (this.state !== 'idle' && now >= this.stateUntil) {
      this.state = 'idle';
      this.stateUntil = 0;
    }
    const target = this.targetAngle ?? 0;
    // Shortest-arc delta — never spins the long way round through ±PI.
    const delta = Math.atan2(Math.sin(target - this.angle), Math.cos(target - this.angle));
    this.angle += delta * Math.min(1, (dtMs / 1000) * 10);
  }

  /**
   * Resolve what to draw right now. A one-shot state falls back to the idle
   * frame when its own keyframe never loaded; when no strike frame exists at
   * all, the legacy front-view art is used upright (`isStrikeFrame: false`).
   */
  resolveFrame(now: number): ResolvedMonsterFrame {
    const state: MonsterAnimState =
      this.state !== 'idle' && now < this.stateUntil ? this.state : 'idle';
    if (this.frames.idle) {
      const img = this.frames[state] ?? this.frames.idle;
      return { img, isStrikeFrame: true, state };
    }
    if (this.legacyImg) {
      return { img: this.legacyImg, isStrikeFrame: false, state };
    }
    return { img: null, isStrikeFrame: false, state };
  }
}
