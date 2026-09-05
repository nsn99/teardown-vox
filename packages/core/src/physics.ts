import { Aabb, Vec3, add, distance, length, normalize, scale, sub, v3 } from './math.js';
import { Body } from './body.js';
import { VoxelWorld } from './world.js';
import { carve } from './destruction.js';

export interface PhysicsBackend {
  /** Завести или обновить тело в солвере. */
  sync(body: Body): void;
  remove(body: Body): void;
  step(dt: number): void;
  applyImpulse(body: Body, impulse: Vec3, point?: Vec3): void;
  /** Взрывная волна: импульс всем телам в радиусе. */
  applyRadialImpulse(center: Vec3, radius: number, strength: number): void;
  dispose(): void;
}

export interface SimplePhysicsOptions {
  /** Высота земли, м. */
  groundY?: number;
  /** 0..1, потеря скорости при ударе. */
  restitution?: number;
  friction?: number;
  /** Импульс (кг·м/с), с которого удар начинает крошить воксели. */
  impactThreshold?: number;
  /** Метров/с ниже которых тело считается покоящимся. */
  sleepVelocity?: number;
  /** Урон от удара масштабируется этим коэффициентом. */
  impactDamageScale?: number;
  maxSpeed?: number;
}

const DEFAULTS = {
  groundY: 0,
  restitution: 0.12,
  friction: 0.55,
  impactThreshold: 900,
  sleepVelocity: 0.08,
  impactDamageScale: 0.0016,
  maxSpeed: 120,
} satisfies Required<SimplePhysicsOptions>;

/**
 * Headless-физика: гравитация, земля, разделение AABB, урон от удара.
 *
 * Это не замена Rapier, а его детерминированный дублёр — на нём гоняются
 * тесты и серверная валидация спидранов, где WASM не нужен и нежелателен.
 * В браузере работает RapierPhysics с тем же интерфейсом.
 */
export class SimplePhysics implements PhysicsBackend {
  private cfg: Required<SimplePhysicsOptions>;
  private tracked = new Set<Body>();

  constructor(
    private world: VoxelWorld,
    opts: SimplePhysicsOptions = {},
  ) {
    this.cfg = { ...DEFAULTS, ...opts };
  }

  sync(body: Body): void {
    if (body.kind === 'dynamic') this.tracked.add(body);
    else this.tracked.delete(body);
    body.collidersDirty = false;
  }

  remove(body: Body): void {
    this.tracked.delete(body);
  }

  applyImpulse(body: Body, impulse: Vec3, _point?: Vec3): void {
    if (body.kind !== 'dynamic') return;
    const m = Math.max(1e-3, body.mass());
    body.velocity = add(body.velocity, scale(impulse, 1 / m));
    body.wake();
  }

  applyRadialImpulse(center: Vec3, radius: number, strength: number): void {
    for (const body of this.world.bodies.values()) {
      if (body.kind !== 'dynamic' || body.destroyed) continue;
      const c = bodyCenter(body);
      const d = distance(c, center);
      if (d > radius) continue;
      const falloff = 1 - d / radius;
      const dir = d < 1e-4 ? v3(0, 1, 0) : normalize(sub(c, center));
      this.applyImpulse(body, scale(dir, strength * falloff * falloff));
    }
  }

  step(dt: number): void {
    const g = this.world.gravity;
    const cfg = this.cfg;

    // Подхватываем всё, что появилось в мире с прошлого шага.
    for (const body of this.world.bodies.values()) {
      if (body.kind === 'dynamic' && !body.destroyed && body.collidersDirty) this.sync(body);
    }

    for (const body of [...this.tracked]) {
      if (body.destroyed || body.kind !== 'dynamic') {
        this.tracked.delete(body);
        continue;
      }
      if (body.sleeping) continue;

      const prev = { ...body.velocity };
      body.velocity = add(body.velocity, scale(g, dt));

      const speed = length(body.velocity);
      if (speed > cfg.maxSpeed) {
        body.velocity = scale(body.velocity, cfg.maxSpeed / speed);
      }

      body.transform.position = add(body.transform.position, scale(body.velocity, dt));

      const box = body.aabb();
      if (box.min.y < cfg.groundY) {
        const penetration = cfg.groundY - box.min.y;
        body.transform.position = add(body.transform.position, v3(0, penetration, 0));

        const impactSpeed = Math.abs(prev.y);
        const mass = body.mass();
        const impulse = impactSpeed * mass;

        body.velocity = v3(
          body.velocity.x * (1 - cfg.friction),
          -body.velocity.y * cfg.restitution,
          body.velocity.z * (1 - cfg.friction),
        );

        if (impulse > cfg.impactThreshold) {
          this.applyImpactDamage(body, null, v3(
            (box.min.x + box.max.x) / 2,
            cfg.groundY,
            (box.min.z + box.max.z) / 2,
          ), impulse);
        }
      }

      if (length(body.velocity) < cfg.sleepVelocity) {
        body.restTime += dt;
        if (body.restTime > this.world.sleepAfter) {
          body.sleeping = true;
          body.velocity = v3();
          body.angularVelocity = v3();
        }
      } else {
        body.restTime = 0;
      }
    }

    this.world.time += dt;
  }

  /**
   * Урон от удара: тяжёлый обломок, падая, крошит и себя, и то, во что попал.
   * Радиус берётся от импульса, чтобы бетонная плита оставляла воронку,
   * а деревянный ящик — вмятину.
   */
  private applyImpactDamage(
    body: Body,
    other: Body | null,
    point: Vec3,
    impulse: number,
  ): void {
    const over = impulse - this.cfg.impactThreshold;
    const radius = Math.min(2.5, 0.15 + over * this.cfg.impactDamageScale);
    const power = Math.min(1.1, 0.25 + over * 3e-4);

    this.world.events.emit('impact', {
      body,
      other,
      point,
      impulse,
      normal: v3(0, 1, 0),
    });

    carve(
      this.world,
      { kind: 'sphere', center: point, radius },
      {
        power,
        damage: 0,
        instant: true,
        falloff: 'quadratic',
        cause: 'impact',
      },
    );
  }

  dispose(): void {
    this.tracked.clear();
  }
}

export function bodyCenter(body: Body): Vec3 {
  const box = body.aabb();
  return v3(
    (box.min.x + box.max.x) / 2,
    (box.min.y + box.max.y) / 2,
    (box.min.z + box.max.z) / 2,
  );
}

export function aabbOf(body: Body): Aabb {
  return body.aabb();
}
