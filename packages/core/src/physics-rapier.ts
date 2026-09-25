import { Vec3, add, distance, normalize, rotateVec, scale, sub, v3 } from './math.js';
import { Body } from './body.js';
import { VoxelWorld } from './world.js';
import { VoxelShape } from './voxel-shape.js';
import { ColliderBox, buildColliders, decomposeCoarse } from './collider.js';
import { VoxelRegion } from './voxel-shape.js';
import { PhysicsBackend } from './physics.js';
import { carve } from './destruction.js';

export interface RapierPhysicsOptions {
  /**
   * Форма крупнее этого числа вокселей коллайдируется огрублённо.
   * Точные коллайдеры для всего уровня — это сотни тысяч боксов и
   * мгновенная смерть солвера.
   */
  coarseAbove?: number;
  /** Во сколько раз огрублять крупные формы. */
  coarseFactor?: number;
  maxBoxesPerShape?: number;
  /**
   * Импульс (кг·м/с), с которого удар начинает крошить воксели.
   * Именно импульс, а не сила контакта: лежащий ящик давит на пол
   * своим весом постоянно, и по силе он неотличим от падения.
   */
  impactThreshold?: number;
  impactDamageScale?: number;
  /** Предфильтр Rapier по силе контакта, Н. Ниже — событие даже не создаётся. */
  contactForceThreshold?: number;
  /**
   * Минимальная потеря скорости, м/с. Тяжёлая плита, мягко осевшая на
   * опору, не должна крошить её только потому, что она тяжёлая.
   */
  minImpactSpeed?: number;
  /** Материалы, которые удар не разрушает (цели миссии). */
  protectedMaterials?: ReadonlySet<number>;
  /** Сколько тел пересобираем за шаг: пересборка коллайдера не бесплатна. */
  rebuildBudget?: number;
  linearDamping?: number;
  angularDamping?: number;
}

const DEFAULTS = {
  coarseAbove: 20_000,
  coarseFactor: 4,
  maxBoxesPerShape: 3000,
  impactThreshold: 60,
  impactDamageScale: 0.0016,
  contactForceThreshold: 1500,
  minImpactSpeed: 2.5,
  protectedMaterials: new Set<number>(),
  rebuildBudget: 8,
  linearDamping: 0.05,
  angularDamping: 0.15,
} satisfies Required<RapierPhysicsOptions>;

/** Минимальный контракт Rapier, который нам нужен. Позволяет не тянуть типы WASM. */
type RapierModule = typeof import('@dimforge/rapier3d-compat');

interface Entry {
  body: Body;
  rb: import('@dimforge/rapier3d-compat').RigidBody;
  colliders: import('@dimforge/rapier3d-compat').Collider[];
  /**
   * Коллайдеры по чанкам: ключ «id формы : индекс чанка». Разрушение
   * задевает один чанк, и пересобрать надо только его — иначе удар по
   * складу тянет за собой декомпозицию всего уровня, а это четверть
   * секунды в кадре.
   */
  chunkColliders: Map<string, import('@dimforge/rapier3d-compat').Collider[]>;
  /** Скорость до шага — из неё считается импульс удара. */
  prevVelocity: Vec3;
  /** Импульс последнего шага, кг·м/с. */
  lastImpulse: number;
  /** Потеря скорости за шаг, м/с. */
  lastSpeedDrop: number;
}

/**
 * Физический бэкенд на Rapier.
 *
 * Воксели превращаются в компаунд из жадно склеенных боксов: обломок из
 * пяти тысяч вокселей даёт десятки коллайдеров вместо тысяч, и солвер
 * остаётся живым при сотне одновременно летящих кусков.
 *
 * Интерфейс тот же, что у headless-дублёра, поэтому тесты игровой логики
 * не зависят от WASM, а браузер получает настоящую физику твёрдых тел.
 */
export class RapierPhysics implements PhysicsBackend {
  private cfg: Required<RapierPhysicsOptions>;
  private entries = new Map<number, Entry>();
  private rapierWorld: import('@dimforge/rapier3d-compat').World;
  private events: import('@dimforge/rapier3d-compat').EventQueue;
  private pending: Body[] = [];

  constructor(
    private RAPIER: RapierModule,
    private world: VoxelWorld,
    opts: RapierPhysicsOptions = {},
  ) {
    this.cfg = { ...DEFAULTS, ...opts };
    this.rapierWorld = new RAPIER.World({
      x: world.gravity.x,
      y: world.gravity.y,
      z: world.gravity.z,
    });
    this.events = new RAPIER.EventQueue(true);
  }

  /**
   * Rapier поставляется как WASM и требует асинхронной инициализации,
   * поэтому конструктор синхронный, а вход — фабрика.
   */
  static async create(world: VoxelWorld, opts: RapierPhysicsOptions = {}): Promise<RapierPhysics> {
    const RAPIER = await import('@dimforge/rapier3d-compat');
    await RAPIER.init();
    return new RapierPhysics(RAPIER, world, opts);
  }

  get bodyCount(): number {
    return this.entries.size;
  }

  /** Сколько всего коллайдеров в солвере — метрика для перф-регрессии. */
  get colliderCount(): number {
    let n = 0;
    for (const e of this.entries.values()) n += e.colliders.length;
    return n;
  }

  sync(body: Body): void {
    if (body.destroyed) {
      this.remove(body);
      return;
    }
    const existing = this.entries.get(body.id);
    if (!existing) {
      this.create(body);
      return;
    }
    if (body.collidersDirty) this.pending.push(body);
    if (body.kind !== 'dynamic') return;

    const p = body.transform.position;
    if (body.kinematic) {
      // Кинематике задаём следующую позицию: солвер сам посчитает,
      // с какой скоростью она въехала в то, что стояло на пути.
      existing.rb.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
      existing.rb.setNextKinematicRotation(body.transform.rotation);
    } else {
      existing.rb.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
      existing.rb.setRotation(body.transform.rotation, true);
    }
  }

  private create(body: Body): void {
    const R = this.RAPIER;
    const desc =
      body.kind !== 'dynamic'
        ? R.RigidBodyDesc.fixed()
        : body.kinematic
          ? R.RigidBodyDesc.kinematicPositionBased()
          : R.RigidBodyDesc.dynamic()
              .setLinearDamping(this.cfg.linearDamping)
              .setAngularDamping(this.cfg.angularDamping);
    desc.setTranslation(
      body.transform.position.x,
      body.transform.position.y,
      body.transform.position.z,
    );
    desc.setRotation(body.transform.rotation);
    const rb = this.rapierWorld.createRigidBody(desc);
    (rb as unknown as { userData: number }).userData = body.id;

    const entry: Entry = {
      body,
      rb,
      colliders: [],
      chunkColliders: new Map(),
      prevVelocity: v3(),
      lastImpulse: 0,
      lastSpeedDrop: 0,
    };
    this.entries.set(body.id, entry);
    this.buildColliders(entry);
    if (body.kind === 'dynamic' && !body.kinematic) {
      rb.setLinvel(body.velocity, true);
      rb.setAngvel(body.angularVelocity, true);
    }
    body.physicsHandle = rb.handle;
    body.collidersDirty = false;
  }

  /** Полная пересборка: все чанки всех форм тела. */
  private buildColliders(entry: Entry): void {
    for (const c of entry.colliders) this.rapierWorld.removeCollider(c, false);
    entry.colliders.length = 0;
    entry.chunkColliders.clear();

    for (const shape of entry.body.shapes) {
      if (shape.solidVoxels === 0) continue;
      for (let chunk = 0; chunk < shape.chunkCount; chunk++) {
        this.buildChunk(entry, shape, chunk);
      }
      shape.dirtyColliderChunks.clear();
    }
  }

  /**
   * Пересобрать коллайдеры одного чанка формы.
   *
   * Возвращает, сколько боксов получилось. Старые коллайдеры этого чанка
   * снимаются, соседние не трогаются: шов между чанками физике не важен,
   * боксы просто стыкуются гранями.
   */
  private buildChunk(entry: Entry, shape: VoxelShape, chunk: number): number {
    const R = this.RAPIER;
    const key = `${shape.id}:${chunk}`;
    const old = entry.chunkColliders.get(key);
    if (old) {
      for (const c of old) {
        this.rapierWorld.removeCollider(c, false);
        const i = entry.colliders.indexOf(c);
        if (i >= 0) entry.colliders.splice(i, 1);
      }
      entry.chunkColliders.delete(key);
    }
    if (shape.solidVoxels === 0) return 0;

    const region = shape.chunkBounds(chunk);
    const boxes = this.boxesFor(shape, region);
    if (boxes.length === 0) return 0;

    const density = cachedDensity(shape);
    const made: import('@dimforge/rapier3d-compat').Collider[] = [];
    for (const b of boxes) {
      const local = v3(b.cx, b.cy, b.cz);
      const world = add(shape.transform.position, rotateVec(shape.transform.rotation, local));
      const desc = R.ColliderDesc.cuboid(b.hx, b.hy, b.hz)
        .setTranslation(world.x, world.y, world.z)
        .setRotation(shape.transform.rotation)
        .setDensity(density)
        .setFriction(0.8)
        .setRestitution(0.05);
      // Урон от удара считаем только для свободно летящих обломков.
      // Кинематическая техника давит на опору с огромной силой просто
      // потому, что стоит на ней, — из этого нельзя делать воронку.
      if (entry.body.kind === 'dynamic' && !entry.body.kinematic) {
        desc.setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS);
        desc.setContactForceEventThreshold(this.cfg.contactForceThreshold);
      }
      const collider = this.rapierWorld.createCollider(desc, entry.rb);
      made.push(collider);
      entry.colliders.push(collider);
    }
    entry.chunkColliders.set(key, made);
    return made.length;
  }

  /** Пересборка только задетых чанков. Возвращает их число. */
  private rebuildDirtyChunks(entry: Entry, budget: number): number {
    let done = 0;
    for (const shape of entry.body.shapes) {
      if (shape.dirtyColliderChunks.size === 0) continue;
      const taken: number[] = [];
      for (const chunk of shape.dirtyColliderChunks) {
        if (done >= budget) break;
        this.buildChunk(entry, shape, chunk);
        taken.push(chunk);
        done++;
      }
      shape.consumeColliderChunks(taken);
      if (done >= budget) break;
    }
    return done;
  }

  private dirtyChunkCount(body: Body): number {
    let n = 0;
    for (const shape of body.shapes) n += shape.dirtyColliderChunks.size;
    return n;
  }

  private boxesFor(shape: VoxelShape, region?: VoxelRegion): ColliderBox[] {
    const opts = { maxBoxes: this.cfg.maxBoxesPerShape, region };
    return shape.solidVoxels > this.cfg.coarseAbove
      ? decomposeCoarse(shape, this.cfg.coarseFactor, opts)
      : buildColliders(shape, opts);
  }

  remove(body: Body): void {
    const entry = this.entries.get(body.id);
    if (!entry) return;
    this.rapierWorld.removeRigidBody(entry.rb);
    this.entries.delete(body.id);
    body.physicsHandle = null;
  }

  applyImpulse(body: Body, impulse: Vec3, point?: Vec3): void {
    const entry = this.entries.get(body.id);
    if (!entry || body.kind !== 'dynamic' || body.kinematic) return;
    if (point) {
      entry.rb.applyImpulseAtPoint(impulse, point, true);
    } else {
      entry.rb.applyImpulse(impulse, true);
    }
    body.wake();
  }

  applyRadialImpulse(center: Vec3, radius: number, strength: number): void {
    for (const entry of this.entries.values()) {
      if (entry.body.kind !== 'dynamic' || entry.body.kinematic) continue;
      const t = entry.rb.worldCom();
      const p = v3(t.x, t.y, t.z);
      const d = distance(p, center);
      if (d > radius) continue;
      const falloff = 1 - d / radius;
      const dir = d < 1e-4 ? v3(0, 1, 0) : normalize(sub(p, center));
      entry.rb.applyImpulse(scale(dir, strength * falloff * falloff), true);
      entry.body.wake();
    }
  }

  step(dt: number): void {
    // Подхватываем новые и изменившиеся тела.
    for (const body of this.world.bodies.values()) {
      if (body.destroyed) continue;
      if (!this.entries.has(body.id) || body.collidersDirty) this.sync(body);
    }
    for (const [id, entry] of this.entries) {
      if (!this.world.bodies.has(id) || entry.body.destroyed) this.remove(entry.body);
    }

    // Пересборка коллайдеров идёт с бюджетом и по чанкам: разрушение стены
    // не должно превращаться в кадр на полсекунды.
    let rebuilt = 0;
    while (this.pending.length > 0 && rebuilt < this.cfg.rebuildBudget) {
      const body = this.pending.shift()!;
      const entry = this.entries.get(body.id);
      if (!entry || body.destroyed) continue;
      if (this.dirtyChunkCount(body) > 0) {
        rebuilt += this.rebuildDirtyChunks(entry, this.cfg.rebuildBudget - rebuilt);
        // Не всё влезло в бюджет — тело остаётся в очереди на следующий шаг.
        if (this.dirtyChunkCount(body) > 0) {
          this.pending.push(body);
          break;
        }
      } else {
        this.buildColliders(entry);
        rebuilt++;
      }
      body.collidersDirty = false;
    }

    // Запоминаем скорости до шага: удар — это её резкая потеря.
    for (const entry of this.entries.values()) {
      if (entry.body.kind !== 'dynamic' || entry.body.kinematic) continue;
      const lv = entry.rb.linvel();
      entry.prevVelocity = v3(lv.x, lv.y, lv.z);
      entry.lastImpulse = 0;
      entry.lastSpeedDrop = 0;
    }

    this.rapierWorld.timestep = dt;
    this.rapierWorld.step(this.events);

    for (const entry of this.entries.values()) {
      if (entry.body.kind !== 'dynamic' || entry.body.kinematic) continue;
      const lv = entry.rb.linvel();
      // Удар — это резкая ПОТЕРЯ скорости. Гравитацию вычитать нельзя:
      // лежащее тело каждый шаг получает от опоры ровно противовес весу,
      // и с поправкой на g оно выглядело бы как вечный удар.
      const dv = Math.hypot(
        lv.x - entry.prevVelocity.x,
        lv.y - entry.prevVelocity.y,
        lv.z - entry.prevVelocity.z,
      );
      entry.lastSpeedDrop = dv;
      entry.lastImpulse = entry.rb.mass() * dv;
    }

    for (const entry of this.entries.values()) {
      if (entry.body.kind !== 'dynamic' || entry.body.kinematic) continue;
      const t = entry.rb.translation();
      const r = entry.rb.rotation();
      const lv = entry.rb.linvel();
      const av = entry.rb.angvel();
      entry.body.transform.position = v3(t.x, t.y, t.z);
      entry.body.transform.rotation = { x: r.x, y: r.y, z: r.z, w: r.w };
      entry.body.velocity = v3(lv.x, lv.y, lv.z);
      entry.body.angularVelocity = v3(av.x, av.y, av.z);
      entry.body.sleeping = entry.rb.isSleeping();
    }

    this.drainImpacts();
    this.world.time += dt;
  }

  private drainImpacts(): void {
    this.events.drainContactForceEvents((event) => {
      const c1 = this.rapierWorld.getCollider(event.collider1());
      const c2 = this.rapierWorld.getCollider(event.collider2());
      if (!c1 || !c2) return;
      const a = this.bodyOf(c1);
      const b = this.bodyOf(c2);

      // Считаем импульс по потере скорости, а не по силе контакта:
      // покоящееся тело давит на опору весом бесконечно долго, и по
      // силе это неотличимо от падения плиты.
      const ea = a ? this.entries.get(a.id) : undefined;
      const eb = b ? this.entries.get(b.id) : undefined;
      const impulse = Math.max(ea?.lastImpulse ?? 0, eb?.lastImpulse ?? 0);
      const speedDrop = Math.max(ea?.lastSpeedDrop ?? 0, eb?.lastSpeedDrop ?? 0);
      if (impulse < this.cfg.impactThreshold) return;
      if (speedDrop < this.cfg.minImpactSpeed) return;

      const t = c1.translation();
      const point = v3(t.x, t.y, t.z);

      this.world.events.emit('impact', {
        body: a ?? b!,
        other: a ? b : null,
        point,
        impulse,
        normal: v3(0, 1, 0),
      });

      const over = impulse - this.cfg.impactThreshold;
      const radius = Math.min(2.5, 0.15 + over * this.cfg.impactDamageScale);
      const power = Math.min(1.1, 0.25 + over * 3e-4);
      carve(
        this.world,
        { kind: 'sphere', center: point, radius },
        {
          power,
          damage: 0,
          instant: true,
          falloff: 'quadratic',
          cause: 'impact',
          protect: this.cfg.protectedMaterials,
        },
      );
    });
  }

  private bodyOf(
    collider: import('@dimforge/rapier3d-compat').Collider,
  ): Body | null {
    const parent = collider.parent();
    if (!parent) return null;
    const id = (parent as unknown as { userData?: number }).userData;
    if (id === undefined) return null;
    return this.world.bodies.get(id) ?? null;
  }

  dispose(): void {
    for (const entry of [...this.entries.values()]) this.remove(entry.body);
    this.entries.clear();
    this.rapierWorld.free();
  }
}

/** Средняя плотность формы, кг/м³ — для массы коллайдеров. */
export function averageDensity(shape: VoxelShape): number {
  const solids = shape.solidVoxels;
  if (solids === 0) return 1;
  const s = shape.voxelSize;
  const volume = solids * s * s * s;
  return shape.mass() / volume;
}

interface DensityCache {
  solids: number;
  value: number;
}

const densityCache = new WeakMap<VoxelShape, DensityCache>();

/**
 * Та же средняя плотность, но с памятью.
 *
 * mass() — проход по всем вокселям формы. При пересборке коллайдеров по
 * чанкам это стоило пять миллионов клеток на каждый чанк грунта, то есть
 * десяток секунд на загрузке. Плотность пересчитывается, только когда
 * заметно поменялось число вокселей: смесь материалов меняется медленно,
 * а точность здесь нужна для инерции, а не для баллистики.
 */
function cachedDensity(shape: VoxelShape): number {
  const solids = shape.solidVoxels;
  if (solids === 0) return 1;
  const hit = densityCache.get(shape);
  if (hit && Math.abs(hit.solids - solids) <= hit.solids * 0.1) return hit.value;
  const value = averageDensity(shape);
  densityCache.set(shape, { solids, value });
  return value;
}
