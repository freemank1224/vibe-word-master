// ================================================================
// WORD STRIKE — Matter.js physics layer.
//
// Framework-agnostic wrapper: React owns the lifecycle (create inside
// useEffect, destroy in cleanup — StrictMode double-mounts), this class owns
// the world. All coordinates are in the FIXED LOGICAL WORLD (900×640); the
// renderer letterboxes that world onto the real canvas, so the physics world
// is never resized at runtime.
//
// Brick design: one body PER LETTER linked to its neighbours by TWO
// zero-length stiff constraints pinned at the shared corners. Matter.js
// cannot remove parts from a compound body, but individual bodies +
// constraints can be removed mid-flight — shattering unit k leaves the rest
// of the bar rigid and falling, which is exactly the Tetris-bar feel.
//
// Collision rules:
//   bullet × unit   → bullet consumed (one per shot), onBulletHit(unit)
//   unit  × killzone → onBrickReachedLauncher(unit) — once per brick
// Debris only collides with walls (no self-intersection chaos) and is
// FIFO-culled at a hard cap so long sessions cannot accumulate bodies.
// ================================================================
import * as Matter from 'matter-js';

export const CATEGORY = {
  UNIT: 0x0001,
  BULLET: 0x0002,
  WALL: 0x0004,
  DEBRIS: 0x0008,
  KILLZONE: 0x0010,
} as const;

/** Fixed logical resolution — the renderer scales this to the canvas. */
export const LOGICAL_WORLD = { width: 900, height: 640 } as const;

/** Launcher geometry (logical coords) — shared with the renderer. */
export const LAUNCHER = {
  x: LOGICAL_WORLD.width / 2,
  barrelTopY: LOGICAL_WORLD.height - 104,
  baseY: LOGICAL_WORLD.height - 34,
} as const;

/** Brick contacting this line = it reached the launcher. */
export const KILL_LINE_Y = LAUNCHER.barrelTopY + 18;

const STEP_MS = 1000 / 60;
const STEP_MS_PER_FRAME = 3; // max physics steps per frame (avoid spiral of death)
const UNIT_FRICTION_AIR = 0.02;
const BULLET_SPEED = 26; // px/step — <= min unit size (26px): no tunnelling
const DEBRIS_PER_UNIT = 5;
const DEBRIS_LIFETIME_MS = 1200;
const DEBRIS_HARD_CAP = 120;
const BULLET_LIFETIME_MS = 2500; // safety cull for bullets that hit walls

export interface UnitHandle {
  unitIndex: number;
  letter: string;
  body: Matter.Body;
}

export interface BrickState {
  wordId: string;
  aliveCount: number;
  totalCount: number;
}

export interface WordStrikePhysicsCallbacks {
  /** Bullet reached a unit — the game layer decides hits/misses via matchTypedWord. */
  onBulletHit: (unit: UnitHandle) => void;
  /** Brick touched the kill line above the launcher. */
  onBrickReachedLauncher: () => void;
}

interface DebrisEntry {
  body: Matter.Body;
  bornAt: number;
}

interface BulletEntry {
  body: Matter.Body;
  bornAt: number;
}

export class WordStrikePhysics {
  private engine: Matter.Engine;
  private world: Matter.World;
  private callbacks: WordStrikePhysicsCallbacks;

  private units: UnitHandle[] = [];
  private joints: Matter.Constraint[] = [];
  private unitCount = 0;
  private brickWordId: string | null = null;
  /** Cell size + body size of the live brick — needed to rebuild joints
   *  with correct rest lengths when gaps get bridged after a hit. */
  private unitCellSize = 0;
  private unitBodySize = 0;

  private debris: DebrisEntry[] = [];
  private bullets: BulletEntry[] = [];
  private consumedBulletIds = new Set<number>();
  private killzoneTriggered = false;

  private accumulator = 0;
  private paused = false;
  private destroyed = false;

  private shakeMag = 0;
  private shakeOffX = 0;
  private shakeOffY = 0;

  private collisionHandler: (event: Matter.IEventCollision<Matter.Engine>) => void;

  constructor(callbacks: WordStrikePhysicsCallbacks) {
    this.callbacks = callbacks;

    this.engine = Matter.Engine.create();
    this.engine.gravity.x = 0;
    this.engine.gravity.y = 0.05;
    this.engine.gravity.scale = 0.001;
    this.world = this.engine.world;

    this.buildStaticGeometry();

    this.collisionHandler = (event) => this.handleCollisions(event);
    Matter.Events.on(this.engine, 'collisionStart', this.collisionHandler);
  }

  // ----------------------------------------------------------------
  // world setup
  // ----------------------------------------------------------------

  private buildStaticGeometry() {
    const { width, height } = LOGICAL_WORLD;
    const wallOpts: Matter.IBodyDefinition = {
      isStatic: true,
      label: 'wall',
      collisionFilter: { category: CATEGORY.WALL, mask: CATEGORY.UNIT | CATEGORY.BULLET | CATEGORY.DEBRIS },
    };

    const left = Matter.Bodies.rectangle(-30, height / 2, 60, height * 2, wallOpts);
    const right = Matter.Bodies.rectangle(width + 30, height / 2, 60, height * 2, wallOpts);
    const top = Matter.Bodies.rectangle(width / 2, -30, width * 2, 60, wallOpts);
    // Floor sits BELOW the kill line: shattered debris (and post-hit fragments)
    // rest at the base of the launcher rather than falling out of the world.
    const floor = Matter.Bodies.rectangle(width / 2, height - 14, width + 120, 28, wallOpts);

    // Sensor (no physical push): the moment a unit overlaps it, the brick has
    // reached the launcher. Sits at the kill line so contact reads visually.
    const killzone = Matter.Bodies.rectangle(LAUNCHER.x, KILL_LINE_Y + 10, width, 12, {
      isStatic: true,
      isSensor: true,
      label: 'killzone',
      collisionFilter: { category: CATEGORY.KILLZONE, mask: CATEGORY.UNIT },
    });

    Matter.Composite.add(this.world, [left, right, top, floor, killzone]);
  }

  // ----------------------------------------------------------------
  // brick lifecycle
  // ----------------------------------------------------------------

  spawnBrick(word: string, wordId: string, opts: { centerX: number; y: number; unitSize: number }): void {
    this.clearBrick();

    const letters = word.trim().toLowerCase().split('');
    const size = opts.unitSize;
    const bodySize = size * 0.94; // small seam between units for readability
    const totalWidth = letters.length * size;
    const startX = opts.centerX - totalWidth / 2 + size / 2;

    const unitCategory = CATEGORY.UNIT;
    letters.forEach((letter, index) => {
      const body = Matter.Bodies.rectangle(startX + index * size, opts.y, bodySize, bodySize, {
        label: 'unit',
        frictionAir: UNIT_FRICTION_AIR,
        restitution: 0.05,
        friction: 0.1,
        collisionFilter: {
          category: unitCategory,
          mask: CATEGORY.UNIT | CATEGORY.BULLET | CATEGORY.WALL | CATEGORY.KILLZONE,
        },
        plugin: { kind: 'unit', unitIndex: index, letter, wordId },
      });
      this.units.push({ unitIndex: index, letter, body });
    });

    // Two constraints per joint, pinned at the facing corners: one pin alone
    // still lets the pair shear/rotate; two make it rigid. The bodies are
    // slightly smaller than the cell (visual seam), so each corner pair is
    // `size - bodySize` apart at rest — the constraint length MUST equal that
    // gap. A zero rest length here makes Matter treat the slack as penetration
    // and the resulting impulse detonates the bar on frame one.
    this.unitCellSize = size;
    this.unitBodySize = bodySize;
    this.buildJoints();

    this.unitCount = letters.length;
    this.brickWordId = wordId;
    this.killzoneTriggered = false;

    Matter.Composite.add(this.world, [...this.units.map((u) => u.body), ...this.joints]);
  }

  /**
   * (Re)build the joint chain linking ALIVE units in letter order. Called on
   * spawn and after every shatter: when middle units are destroyed the
   * neighbours BRIDGE the gap, so the surviving bar always moves as ONE rigid
   * body in the word's original letter order (it may wobble on impact, but
   * pieces never drift apart).
   */
  private buildJoints(): void {
    this.joints = [];
    const half = this.unitBodySize / 2;

    for (let i = 0; i < this.units.length - 1; i += 1) {
      const a = this.units[i];
      const b = this.units[i + 1];
      // Rest length spans every destroyed cell between the pair.
      const jointLength = Math.max(
        0,
        (b.unitIndex - a.unitIndex) * this.unitCellSize - this.unitBodySize
      );

      this.joints.push(
        Matter.Constraint.create({
          bodyA: a.body,
          bodyB: b.body,
          length: jointLength,
          stiffness: 1,
          damping: 0.1,
          pointA: { x: half, y: -half },
          pointB: { x: -half, y: -half },
        }),
        Matter.Constraint.create({
          bodyA: a.body,
          bodyB: b.body,
          length: jointLength,
          stiffness: 1,
          damping: 0.1,
          pointA: { x: half, y: half },
          pointB: { x: -half, y: half },
        })
      );
    }
  }

  /** Silently remove whatever remains of the current brick (no debris). */
  clearBrick(): void {
    if (this.units.length === 0 && this.joints.length === 0) {
      this.brickWordId = null;
      return;
    }

    Matter.Composite.remove(this.world, this.units.map((u) => u.body));
    Matter.Composite.remove(this.world, this.joints);
    this.units = [];
    this.joints = [];
    this.unitCount = 0;
    this.brickWordId = null;
    this.killzoneTriggered = false;
  }

  getBrickState(): BrickState | null {
    if (this.brickWordId == null || this.units.length === 0) return null;
    return {
      wordId: this.brickWordId,
      aliveCount: this.units.length,
      totalCount: this.unitCount,
    };
  }

  getAliveUnits(): UnitHandle[] {
    return this.units;
  }

  /** Lowest edge of the surviving bar — used by the danger proximity HUD. */
  getBrickBottomY(): number | null {
    if (this.units.length === 0) return null;
    let bottom = -Infinity;
    for (const unit of this.units) {
      if (unit.body.bounds.max.y > bottom) bottom = unit.body.bounds.max.y;
    }
    return bottom;
  }

  // ----------------------------------------------------------------
  // bullets
  // ----------------------------------------------------------------

  fireBullet(x: number, y: number): Matter.Body {
    const bullet = Matter.Bodies.circle(x, y, 7, {
      label: 'bullet',
      frictionAir: 0,
      restitution: 0,
      collisionFilter: { category: CATEGORY.BULLET, mask: CATEGORY.UNIT | CATEGORY.WALL },
      plugin: { kind: 'bullet' },
    });
    Matter.Body.setVelocity(bullet, { x: 0, y: -BULLET_SPEED });
    this.bullets.push({ body: bullet, bornAt: this.nowMs() });
    Matter.Composite.add(this.world, bullet);
    return bullet;
  }

  // ----------------------------------------------------------------
  // shattering
  // ----------------------------------------------------------------

  /**
   * Shatter specific units (hit letters, or ALL remaining on a life-loss
   * explosion). Removes bodies and spawns physics debris, then REBUILDS the
   * joint chain so the surviving units stay linked in letter order — the bar
   * bridges each gap and keeps falling as one body.
   */
  shatterUnits(unitIndexes: number[]): void {
    const indexSet = new Set(unitIndexes);
    const shattered = this.units.filter((u) => indexSet.has(u.unitIndex));
    if (shattered.length === 0) return;

    for (const unit of shattered) {
      // Debris first (uses the body's position/velocity before removal).
      this.spawnDebrisForUnit(unit);
      Matter.Composite.remove(this.world, unit.body);
      this.units = this.units.filter((u) => u !== unit);
    }

    // Rebuild connectivity: drop every old joint and chain the surviving
    // units (in unitIndex order) back together, bridging the gaps.
    Matter.Composite.remove(this.world, this.joints);
    this.buildJoints();
    if (this.joints.length > 0) {
      Matter.Composite.add(this.world, this.joints);
    }
  }

  private spawnDebrisForUnit(unit: UnitHandle): void {
    const { position, velocity } = unit.body;
    for (let i = 0; i < DEBRIS_PER_UNIT; i += 1) {
      if (this.debris.length >= DEBRIS_HARD_CAP) {
        const oldest = this.debris.shift();
        if (oldest) Matter.Composite.remove(this.world, oldest.body);
      }

      const radius = 4 + Math.random() * 7;
      const bornAt = this.nowMs();
      // Candy-bit squares with chamfered (rounded) corners — matches the
      // cute monster art direction far better than sharp polygons.
      const debris = Matter.Bodies.rectangle(position.x, position.y, radius * 1.7, radius * 1.7, {
        label: 'debris',
        frictionAir: 0.015,
        restitution: 0.4,
        chamfer: { radius: radius * 0.45 },
        collisionFilter: { category: CATEGORY.DEBRIS, mask: CATEGORY.WALL },
        plugin: { kind: 'debris', bornAt },
      });
      Matter.Body.setVelocity(debris, {
        x: velocity.x + (Math.random() - 0.5) * 9,
        y: velocity.y - 2 - Math.random() * 5,
      });
      Matter.Body.setAngularVelocity(debris, (Math.random() - 0.5) * 0.4);

      this.debris.push({ body: debris, bornAt: this.nowMs() });
      Matter.Composite.add(this.world, debris);
    }
  }

  // ----------------------------------------------------------------
  // collision routing
  // ----------------------------------------------------------------

  private handleCollisions(event: Matter.IEventCollision<Matter.Engine>): void {
    if (this.destroyed) return;

    for (const pair of event.pairs) {
      const { bodyA, bodyB } = pair;
      const bullet = bodyA.label === 'bullet' ? bodyA : bodyB.label === 'bullet' ? bodyB : null;
      const unitBody =
        bodyA.plugin?.kind === 'unit' ? bodyA : bodyB.plugin?.kind === 'unit' ? bodyB : null;
      const killzone = bodyA.label === 'killzone' ? bodyA : bodyB.label === 'killzone' ? bodyB : null;

      if (bullet && unitBody) {
        if (this.consumedBulletIds.has(bullet.id)) continue;
        this.consumedBulletIds.add(bullet.id);
        Matter.Composite.remove(this.world, bullet);
        const unit = this.units.find((u) => u.body.id === unitBody.id);
        if (unit) {
          this.callbacks.onBulletHit(unit);
        }
        continue;
      }

      if (unitBody && killzone && !this.killzoneTriggered) {
        this.killzoneTriggered = true;
        this.callbacks.onBrickReachedLauncher();
      }
    }
  }

  // ----------------------------------------------------------------
  // difficulty + stepping
  // ----------------------------------------------------------------

  /** Difficulty ramp: 0.05 (floaty) → 0.18 (brisk). See services/wordStrike.ts. */
  setGravityScale(value: number): void {
    this.engine.gravity.y = value;
  }

  update(dtMs: number): void {
    if (this.paused || this.destroyed) return;

    this.accumulator += Math.min(dtMs, 100);
    let steps = 0;
    while (this.accumulator >= STEP_MS && steps < STEP_MS_PER_FRAME) {
      Matter.Engine.update(this.engine, STEP_MS);
      this.accumulator -= STEP_MS;
      steps += 1;
    }
    if (steps === STEP_MS_PER_FRAME && this.accumulator > STEP_MS * STEP_MS_PER_FRAME) {
      // Dropped far behind (tab was hidden): drop the backlog instead of
      // teleporting the brick on the next frames.
      this.accumulator = 0;
    }

    this.cullExpired();
    this.decayShake();
  }

  private cullExpired(): void {
    const now = this.nowMs();

    const expiredDebris = this.debris.filter((d) => now - d.bornAt > DEBRIS_LIFETIME_MS);
    if (expiredDebris.length > 0) {
      Matter.Composite.remove(this.world, expiredDebris.map((d) => d.body));
      this.debris = this.debris.filter((d) => now - d.bornAt <= DEBRIS_LIFETIME_MS);
    }

    const expiredBullets = this.bullets.filter(
      (b) => now - b.bornAt > BULLET_LIFETIME_MS || b.body.position.y < -80
    );
    if (expiredBullets.length > 0) {
      Matter.Composite.remove(this.world, expiredBullets.map((b) => b.body));
      this.bullets = this.bullets.filter((b) => !expiredBullets.includes(b));
    }
  }

  // ----------------------------------------------------------------
  // screen shake (render-layer only — never touches physics)
  // ----------------------------------------------------------------

  shake(magnitude: number): void {
    this.shakeMag = Math.max(this.shakeMag, magnitude);
  }

  private decayShake(): void {
    if (this.shakeMag < 0.15) {
      this.shakeMag = 0;
      this.shakeOffX = 0;
      this.shakeOffY = 0;
      return;
    }
    this.shakeMag *= 0.86;
    this.shakeOffX = (Math.random() - 0.5) * 2 * this.shakeMag;
    this.shakeOffY = (Math.random() - 0.5) * 2 * this.shakeMag;
  }

  get shakeOffset(): { x: number; y: number } {
    return { x: this.shakeOffX, y: this.shakeOffY };
  }

  getBullets(): Matter.Body[] {
    return this.bullets.map((b) => b.body);
  }

  getDebris(): Matter.Body[] {
    return this.debris.map((d) => d.body);
  }

  // ----------------------------------------------------------------
  // lifecycle
  // ----------------------------------------------------------------

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (this.paused) {
      this.paused = false;
      this.accumulator = 0; // don't replay the paused gap as a huge step
    }
  }

  get isPaused(): boolean {
    return this.paused;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    Matter.Events.off(this.engine, 'collisionStart', this.collisionHandler);
    Matter.World.clear(this.world, false);
    Matter.Engine.clear(this.engine);
    this.units = [];
    this.joints = [];
    this.debris = [];
    this.bullets = [];
    this.consumedBulletIds.clear();
    this.callbacks = { onBulletHit: () => {}, onBrickReachedLauncher: () => {} };
  }

  private nowMs(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }
}
