// ================================================================
// WORD STRIKE — Matter.js physics layer (vertical-drop field).
//
// Framework-agnostic wrapper: React owns the lifecycle (create inside
// useEffect, destroy in cleanup — StrictMode double-mounts), this class owns
// the world. All coordinates are in the FIXED LOGICAL WORLD (900×640); the
// renderer letterboxes that world onto the real canvas, so the physics world
// is never resized at runtime.
//
// Field layout: letter bricks materialize at the TOP of the field (whole
// chain visible at once) inside the horizontal fall zone and sink DOWN at a
// constant set speed (zero gravity, zero air friction — velocity is exact,
// nothing decays). The gunner rides an elevator on the LEFT (no physics
// body — the React layer smooths its height) tracking the word, firing
// level shots. A brick whose bottom edge touches the ground (KILL_LINE_Y =
// the floor top) has reached it unsolved — there is no drawn fence.
//
// Brick design: one body PER LETTER linked to its neighbours by TWO stiff
// constraints pinned at the shared corners. Matter.js cannot remove parts
// from a compound body, but individual bodies + constraints can be removed
// mid-flight — shattering unit k leaves the rest of the bar rigid and
// sinking, which is exactly the word-bar feel.
//
// Collision rules:
//   bullet × unit   → bullet consumed (one per shot), onBulletHit(unit, contact)
//   unit  × killzone → onBrickReachedGround() — once per brick
// Debris only collides with walls (no self-intersection chaos) and is
// FIFO-culled at a hard cap so long sessions cannot accumulate bodies.
// NOTE: there is NO right wall — bullets/debris exiting right are handled
// by the cull predicates instead.
// ================================================================
import Matter from 'matter-js';

export const CATEGORY = {
  UNIT: 0x0001,
  BULLET: 0x0002,
  WALL: 0x0004,
  DEBRIS: 0x0008,
  KILLZONE: 0x0010,
} as const;

/** Fixed logical resolution — the renderer scales this to the canvas. */
export const LOGICAL_WORLD = { width: 900, height: 640 } as const;

/**
 * Gun geometry — the elevator gunner's chest/shoulder pivot. pivotX is fixed
 * on the elevator column; pivotY is DYNAMIC (rides the elevator platform),
 * so bullets spawn from `pivotX, pivotY(angle)` passed per shot. The muzzle
 * sits `muzzleLength` px from the pivot along the aim direction — steady
 * state aims ≈ level (angle ≈ 0), matching the baked-in side-view art gun.
 */
export const TURRET = {
  pivotX: 150,
  muzzleLength: 67,
} as const;

/**
 * Elevator geometry: the gunner stands on a platform that tracks the word's
 * height. feetY clamps to [topFeetY, bottomFeetY]; the gun pivot sits
 * gunOffsetY px above the feet. topFeetY keeps the full sprite frame
 * (≈150px tall) on-screen at the highest stop; bottomFeetY = the ground.
 */
export const ELEVATOR = {
  topFeetY: 154,
  bottomFeetY: LOGICAL_WORLD.height - 28,
  gunOffsetY: 78,
} as const;

/** Gun pivot Y for a (clamped) elevator feet position. */
export const getGunPivotY = (feetY: number): number =>
  Math.min(ELEVATOR.bottomFeetY, Math.max(ELEVATOR.topFeetY, feetY)) - ELEVATOR.gunOffsetY;

/** Ground surface under the elevator's lowest stop (top of the floor body). */
export const FLOOR_TOP = LOGICAL_WORLD.height - 28;

/**
 * Failure line = the ground itself: a brick whose bottom edge touches the
 * floor has reached it unsolved. No drawn fence — the meadow's grass strip
 * IS the defense line.
 */
export const KILL_LINE_Y = FLOOR_TOP;

/** Renderer anchor X + sprite scale source for the elevator gunner. */
export const MONSTER = { x: 150, height: 105 } as const;

const STEP_MS = 1000 / 60;
const STEP_MS_PER_FRAME = 3; // max physics steps per frame (avoid spiral of death)
// MUST stay exactly 0: bricks march at a constant set velocity, and any air
// friction silently decays that velocity to a crawl across a full crossing.
// Wobble (if any) is a constraint-damping problem, never an air-friction one.
const UNIT_FRICTION_AIR = 0;
// px/step, speed MAGNITUDE is fixed: with any aim angle each per-axis
// component is <= 26 = min unit size, so diagonal shots cannot tunnel either.
const BULLET_SPEED = 26;
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
  onBulletHit: (unit: UnitHandle, contact: BulletContact) => void;
  /** A unit touched down on the ground — the brick failed (once per brick). */
  onBrickReachedGround: () => void;
}

/** Where/how a bullet connected — feeds the renderer's impact particles. */
export interface BulletContact {
  x: number;
  y: number;
  vx: number;
  vy: number;
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

  /** Set downward sink speed (px/step, positive value = downward). Stored so
   *  spawnBrick can apply it to fresh bodies — the component calls the setter
   *  BEFORE spawning, when there are no alive units to re-apply to yet. */
  private brickSpeed = 0;

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
    // Zero gravity on both axes: bricks march at a constant set speed. (There
    // is no per-body gravityScale in matter-js 0.20 — engine-level zero is
    // the only clean way to exempt the marching bricks while keeping debris
    // behaviour predictable.)
    this.engine.gravity.x = 0;
    this.engine.gravity.y = 0;
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
      // Gentle rebound: a drifting bar that reaches a side wall eases back
      // instead of pinging off (pair restitution = max(unit 0.05, wall 0.2)).
      // Harmless elsewhere: the killzone explodes a bar the same step it
      // meets the floor, debris keeps its own higher 0.4, bullets are sensors.
      restitution: 0.2,
      label: 'wall',
      collisionFilter: { category: CATEGORY.WALL, mask: CATEGORY.UNIT | CATEGORY.BULLET | CATEGORY.DEBRIS },
    };

    const left = Matter.Bodies.rectangle(-30, height / 2, 60, height * 2, wallOpts);
    // Right wall at the exact screen edge: the WHOLE bar must stay visible at
    // all times (user rule) — a unit's right edge stops flush at x = width and
    // the low restitution eases it back left. Bullets pass through untouched
    // (sensor) and are still removed by the off-screen cull predicates.
    const right = Matter.Bodies.rectangle(width + 30, height / 2, 60, height * 2, wallOpts);
    const top = Matter.Bodies.rectangle(width / 2, -30, width * 2, 60, wallOpts);
    // Ground strip under the elevator's lowest stop: debris in a zero-g world
    // still has a floor to settle against after the sinking bar shatters.
    const floor = Matter.Bodies.rectangle(width / 2, height - 14, width + 120, 28, wallOpts);

    // Sensor (no physical push): the moment a unit overlaps it, the brick has
    // touched down and failed. A thin horizontal slab hugging the floor top —
    // overlap begins exactly when a unit's bottom edge meets the ground;
    // spans the full width (×2) to cover the whole fall zone. Units sink
    // ≤ ~2.2px/step vs an 8px sensor, so collisionStart can never tunnel.
    const killzone = Matter.Bodies.rectangle(width / 2, KILL_LINE_Y + 4, width * 2, 8, {
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

  spawnBrick(
    word: string,
    wordId: string,
    opts: { centerX: number; y: number; unitSize: number }
  ): void {
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

    // Sink speed: the stored set speed (see setBrickSpeed). The whole bar
    // moves as one because every unit gets the same velocity — the joint
    // chain stays inert.
    for (const unit of this.units) {
      Matter.Body.setVelocity(unit.body, { x: 0, y: this.brickSpeed });
    }

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

  /**
   * Bottom (lowest) edge of the surviving bar — the side that touches the
   * ground first. Null when no brick is live.
   */
  getBrickBottomY(): number | null {
    if (this.units.length === 0) return null;
    let bottom = -Infinity;
    for (const unit of this.units) {
      if (unit.body.bounds.max.y > bottom) bottom = unit.body.bounds.max.y;
    }
    return bottom;
  }

  /**
   * Average position + velocity of the surviving bar — the elevator gunner's
   * aim point. The bar moves as one rigid body (joint chain), so the average
   * is its effective center; null when no brick is live.
   */
  getBrickCenter(): { x: number; y: number; vx: number; vy: number } | null {
    if (this.units.length === 0) return null;
    let x = 0;
    let y = 0;
    let vx = 0;
    let vy = 0;
    for (const unit of this.units) {
      x += unit.body.position.x;
      y += unit.body.position.y;
      vx += unit.body.velocity.x;
      vy += unit.body.velocity.y;
    }
    const n = this.units.length;
    return { x: x / n, y: y / n, vx: vx / n, vy: vy / n };
  }

  // ----------------------------------------------------------------
  // bullets
  // ----------------------------------------------------------------

  /**
   * Fire an energy bolt from the elevator gun's muzzle along `angle`
   * (atan2 radians) from the given pivot height (rides the elevator). The
   * speed MAGNITUDE stays BULLET_SPEED for every angle, so each per-axis
   * component stays <= the 26px minimum unit size — the anti-tunnelling
   * invariant survives the rework.
   */
  fireBullet(angle: number, pivotY: number): Matter.Body {
    const x = TURRET.pivotX + Math.cos(angle) * TURRET.muzzleLength;
    const y = pivotY + Math.sin(angle) * TURRET.muzzleLength;
    const bullet = Matter.Bodies.circle(x, y, 7, {
      label: 'bullet',
      frictionAir: 0,
      restitution: 0,
      // Sensor: the bullet must NEVER resolve physically. A solid body here
      // dumps its 26px/step momentum into the hit unit — and because units
      // run frictionAir exactly 0, any sideways velocity it imparts never
      // decays and the surviving bar (wrong-word hit) drifts off-screen.
      // Sensors still fire collisionStart, so hit detection is unchanged.
      isSensor: true,
      collisionFilter: { category: CATEGORY.BULLET, mask: CATEGORY.UNIT | CATEGORY.WALL },
      plugin: { kind: 'bullet', angle },
    });
    Matter.Body.setVelocity(bullet, {
      x: Math.cos(angle) * BULLET_SPEED,
      y: Math.sin(angle) * BULLET_SPEED,
    });
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
   * bridges each gap and keeps sinking as one body.
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
          const support = pair.collision.supports[0];
          this.callbacks.onBulletHit(unit, {
            x: support ? support.x : bullet.position.x,
            y: support ? support.y : bullet.position.y,
            vx: bullet.velocity.x,
            vy: bullet.velocity.y,
          });
        }
        continue;
      }

      if (unitBody && killzone && !this.killzoneTriggered) {
        this.killzoneTriggered = true;
        this.callbacks.onBrickReachedGround();
      }
    }
  }

  // ----------------------------------------------------------------
  // difficulty + stepping
  // ----------------------------------------------------------------

  /**
   * Set the downward sink speed (px/step, positive value). Stores it (so the
   * NEXT spawnBrick applies it to fresh bodies) and re-applies it to any
   * alive units — a mid-flight gear change takes effect on the in-flight bar
   * immediately. Uniform velocity, so the stiffness-1 joint chain stays inert.
   */
  setBrickSpeed(pxPerStep: number): void {
    this.brickSpeed = pxPerStep;
    for (const unit of this.units) {
      Matter.Body.setVelocity(unit.body, { x: 0, y: pxPerStep });
    }
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
      (b) =>
        now - b.bornAt > BULLET_LIFETIME_MS ||
        b.body.position.y < -80 ||
        // Level shots can exit through the side walls' collision gaps, and
        // over-pitched shots can dip below the field.
        b.body.position.y > LOGICAL_WORLD.height + 80 ||
        b.body.position.x < -80 ||
        b.body.position.x > LOGICAL_WORLD.width + 80
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
    this.callbacks = {
      onBulletHit: () => {},
      onBrickReachedGround: () => {},
    };
  }

  private nowMs(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }
}
