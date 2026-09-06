import {
  Body,
  CarveResult,
  Mat,
  Simulation,
  Vec3,
  VoxelShape,
  VoxelWorld,
  add,
  carve,
  distance,
  explode,
  length,
  normalize,
  paint,
  quatIdentity,
  scale,
  sub,
  v3,
} from '@tvox/core';
import { Inventory } from './inventory.js';
import { ToolId, toolStats } from './tools.js';

export interface ToolContext {
  sim: Simulation;
  inventory: Inventory;
  /** Точка глаз игрока. */
  origin: Vec3;
  /** Направление взгляда, нормализованное. */
  direction: Vec3;
  /** Тела, которые инструмент не трогает (сам игрок, техника под ним). */
  ignoreBodies?: ReadonlySet<number>;
  /** Материалы, которые нельзя разрушать (цели миссии). */
  protect?: ReadonlySet<number>;
  /** Индекс цвета для баллончика. */
  paintColor?: number;
}

export type ToolFailure =
  | 'cooldown'
  | 'no-ammo'
  | 'no-target'
  | 'needs-second-point'
  | 'too-far';

export interface ToolUseResult {
  used: boolean;
  tool: ToolId;
  reason?: ToolFailure;
  removed?: number;
  painted?: number;
  ignited?: number;
  doused?: number;
  /** Куда пришёлся эффект. */
  point?: Vec3;
  spawned?: Body;
}

const fail = (tool: ToolId, reason: ToolFailure): ToolUseResult => ({
  used: false,
  tool,
  reason,
});

/**
 * Применение активного инструмента к миру.
 *
 * Единая точка входа: списание расходника, откат, трассировка прицела и
 * вызов соответствующей операции ядра. Никаких инструментов, которые
 * «как бы» работают мимо физики.
 */
export function useTool(ctx: ToolContext): ToolUseResult {
  const inv = ctx.inventory;
  const id = inv.active;
  const stats = inv.activeStats;
  const dir = normalize(ctx.direction);

  if (inv.cooldown(id) > 0) return fail(id, 'cooldown');
  if (!inv.canUse(id)) return fail(id, 'no-ammo');

  const world = ctx.sim.world;
  const hit = world.raycast(ctx.origin, dir, {
    maxDistance: stats.range,
    ignore: ctx.ignoreBodies,
  });

  switch (id) {
    case 'sledge':
      return meleeOrRanged(ctx, id, stats.range, hit, (point) =>
        sphereCarve(ctx, point, dir, stats.radius, stats.power, stats.damage, 'sledge'),
      );

    case 'blowtorch':
      return meleeOrRanged(ctx, id, stats.range, hit, (point) => {
        const res = capsuleCarve(ctx, point, dir, stats.radius, stats.power, stats.damage);
        const ignited = ctx.sim.fire.igniteArea(world, point, stats.radius * 3, 0.9);
        inv.consume(id);
        return { used: true, tool: id, removed: res.removed, ignited, point };
      });

    case 'shotgun': {
      inv.consume(id);
      const res = carve(
        world,
        {
          kind: 'cone',
          apex: ctx.origin,
          direction: dir,
          length: stats.range,
          angle: Math.atan2(stats.radius, 1.2),
        },
        {
          power: stats.power,
          damage: stats.damage,
          falloff: 'linear',
          cause: 'shotgun',
          protect: ctx.protect,
          ignoreBodies: ctx.ignoreBodies,
        },
      );
      return { used: true, tool: id, removed: res.removed, point: res.center };
    }

    case 'extinguisher': {
      inv.consume(id);
      const point = hit ? hit.point : add(ctx.origin, scale(dir, stats.range));
      const doused = ctx.sim.fire.extinguish(world, point, stats.radius, stats.power);
      return { used: true, tool: id, doused, point };
    }

    case 'spraycan': {
      if (!hit) return fail(id, 'no-target');
      inv.consume(id);
      const painted = paint(world, hit.point, stats.radius, ctx.paintColor ?? 0);
      return { used: true, tool: id, painted, point: hit.point };
    }

    case 'explosive':
    case 'planks':
      // Эти два ставят объекты, а не бьют по миру: см. ChargeSystem и PlankBuilder.
      return fail(id, 'no-target');
  }
}

function meleeOrRanged(
  ctx: ToolContext,
  id: ToolId,
  range: number,
  hit: ReturnType<VoxelWorld['raycast']>,
  apply: (point: Vec3) => ToolUseResult,
): ToolUseResult {
  if (!hit) return fail(id, 'no-target');
  if (hit.distance > range) return fail(id, 'too-far');
  return apply(hit.point);
}

function sphereCarve(
  ctx: ToolContext,
  point: Vec3,
  dir: Vec3,
  radius: number,
  power: number,
  damage: number,
  cause: string,
): ToolUseResult {
  const id = ctx.inventory.active;
  ctx.inventory.consume(id);
  // Смещаем центр внутрь поверхности, иначе половина сферы уходит в воздух.
  const center = add(point, scale(dir, radius * 0.5));
  const res = carve(
    ctx.sim.world,
    { kind: 'sphere', center, radius },
    {
      power,
      damage,
      falloff: 'linear',
      cause,
      protect: ctx.protect,
      ignoreBodies: ctx.ignoreBodies,
    },
  );
  return { used: true, tool: id, removed: res.removed, point: center };
}

function capsuleCarve(
  ctx: ToolContext,
  point: Vec3,
  dir: Vec3,
  radius: number,
  power: number,
  damage: number,
): CarveResult {
  const a = add(point, scale(dir, -radius));
  const b = add(point, scale(dir, radius * 4));
  return carve(
    ctx.sim.world,
    { kind: 'capsule', a, b, radius },
    {
      power,
      damage,
      falloff: 'none',
      cause: 'blowtorch',
      protect: ctx.protect,
      ignoreBodies: ctx.ignoreBodies,
    },
  );
}

// ---------------------------------------------------------------------------
// Взрывчатка
// ---------------------------------------------------------------------------

export interface Charge {
  id: number;
  position: Vec3;
  radius: number;
  power: number;
  /** Секунд до подрыва. Infinity — ждёт детонатора. */
  fuse: number;
  armed: boolean;
}

export interface ChargeOptions {
  /** Задержка по умолчанию, с. Infinity — только по кнопке. */
  fuse?: number;
  /** Импульс, который взрыв даёт телам. */
  impulse?: number;
}

/**
 * Заряды: ставятся на поверхность, взрываются по таймеру или все разом.
 * Взрыв — это carve + радиальный импульс + поджиг, именно в таком порядке:
 * сначала дыра, потом расталкивание того, что от неё осталось.
 */
export class ChargeSystem {
  private charges = new Map<number, Charge>();
  private nextId = 1;
  private fuse: number;
  private impulse: number;

  constructor(opts: ChargeOptions = {}) {
    this.fuse = opts.fuse ?? 3;
    this.impulse = opts.impulse ?? 900;
  }

  get count(): number {
    return this.charges.size;
  }

  list(): Charge[] {
    return [...this.charges.values()];
  }

  /** Поставить заряд по прицелу. Возвращает null, если не во что ставить. */
  place(ctx: ToolContext): Charge | null {
    const inv = ctx.inventory;
    if (inv.active !== 'explosive') return null;
    if (!inv.canUse('explosive')) return null;
    const stats = toolStats('explosive', inv.tier('explosive'));
    const dir = normalize(ctx.direction);
    const hit = ctx.sim.world.raycast(ctx.origin, dir, {
      maxDistance: stats.range,
      ignore: ctx.ignoreBodies,
    });
    if (!hit) return null;

    inv.consume('explosive');
    const charge: Charge = {
      id: this.nextId++,
      position: add(hit.point, scale(hit.normal, 0.05)),
      radius: stats.radius,
      power: stats.power,
      fuse: this.fuse,
      armed: true,
    };
    this.charges.set(charge.id, charge);
    return charge;
  }

  /** Подорвать всё сразу — детонатор. */
  detonateAll(sim: Simulation, protect?: ReadonlySet<number>): number {
    let n = 0;
    for (const c of [...this.charges.values()]) {
      this.detonate(sim, c.id, protect);
      n++;
    }
    return n;
  }

  detonate(sim: Simulation, id: number, protect?: ReadonlySet<number>): boolean {
    const c = this.charges.get(id);
    if (!c) return false;
    this.charges.delete(id);

    // Воронку выгрызаем сразу, но не больше кадрового бюджета: заряд
    // верхней ступени в плотной кладке снимает сотни тысяч вокселей, и
    // одним куском это провал кадра на четверть секунды. Остаток доедает
    // очередь в следующих кадрах — на глаз это по-прежнему один хлопок.
    const budget = sim.destruction.budget;
    const res = explode(sim.world, {
      center: c.position,
      radius: c.radius,
      power: c.power,
      cause: 'explosive',
      protect,
      maxVoxels: budget,
    });
    if (res.removed >= budget) {
      sim.destruction.enqueue(
        { kind: 'sphere', center: c.position, radius: c.radius },
        {
          power: c.power,
          damage: 0,
          instant: true,
          falloff: 'quadratic',
          cause: 'explosive',
          protect,
        },
      );
    }

    sim.physics.applyRadialImpulse(c.position, c.radius * 2, this.impulse);
    sim.fire.igniteArea(sim.world, c.position, c.radius * 0.8, 1);
    sim.settle();
    return true;
  }

  step(sim: Simulation, dt: number, protect?: ReadonlySet<number>): number {
    let blown = 0;
    for (const c of [...this.charges.values()]) {
      if (!c.armed || !Number.isFinite(c.fuse)) continue;
      c.fuse -= dt;
      if (c.fuse <= 0) {
        this.detonate(sim, c.id, protect);
        blown++;
      }
    }
    return blown;
  }

  clear(): void {
    this.charges.clear();
  }
}

// ---------------------------------------------------------------------------
// Доски
// ---------------------------------------------------------------------------

export interface PlankPlacement {
  body: Body;
  from: Vec3;
  to: Vec3;
  length: number;
}

/**
 * Строительство мостов и пандусов.
 *
 * Первый клик ставит точку, второй — тянет доску. Доска попадает в мир
 * статическим телом, поэтому её тут же подхватывает структурная
 * целостность: мост, у которого выбили опору, честно падает.
 */
export class PlankBuilder {
  private pending: Vec3 | null = null;
  /** Толщина доски в вокселях. */
  thickness = 2;
  width = 4;

  get anchor(): Vec3 | null {
    return this.pending ? { ...this.pending } : null;
  }

  cancel(): void {
    this.pending = null;
  }

  /**
   * Клик инструментом «доски». Первый вызов запоминает точку,
   * второй — строит.
   */
  click(ctx: ToolContext): ToolUseResult {
    const inv = ctx.inventory;
    if (inv.active !== 'planks') return fail('planks', 'no-target');
    if (!inv.canUse('planks')) return fail('planks', 'no-ammo');
    const stats = inv.activeStats;
    const dir = normalize(ctx.direction);
    const hit = ctx.sim.world.raycast(ctx.origin, dir, {
      maxDistance: stats.range,
      ignore: ctx.ignoreBodies,
    });
    if (!hit) return fail('planks', 'no-target');

    const point = add(hit.point, scale(hit.normal, 0.02));
    if (!this.pending) {
      this.pending = point;
      return { used: false, tool: 'planks', reason: 'needs-second-point', point };
    }

    const from = this.pending;
    const span = distance(from, point);
    if (span > stats.range) {
      this.pending = null;
      return fail('planks', 'too-far');
    }

    this.pending = null;
    inv.consume('planks');
    const body = buildPlank(ctx.sim.world, from, point, this.width, this.thickness);
    return { used: true, tool: 'planks', point, spawned: body ?? undefined };
  }
}

/**
 * Создаёт доску между двумя мировыми точками.
 * Ось X формы направлена вдоль пролёта, поэтому достаточно повернуть
 * форму так, чтобы её +X смотрел из from в to.
 */
export function buildPlank(
  world: VoxelWorld,
  from: Vec3,
  to: Vec3,
  widthVoxels = 4,
  thicknessVoxels = 2,
  voxelSize = 0.1,
): Body | null {
  const delta = sub(to, from);
  const span = length(delta);
  if (span < voxelSize) return null;
  const lengthVoxels = Math.max(1, Math.round(span / voxelSize));

  const shape = new VoxelShape({
    sx: lengthVoxels,
    sy: thicknessVoxels,
    sz: widthVoxels,
    voxelSize,
    grounded: false,
    name: 'plank',
  });
  shape.fill({}, Mat.Plank);

  // Центрируем доску по толщине и ширине относительно линии пролёта.
  const rotation = rotationFromXAxis(normalize(delta));
  const body = new Body({
    kind: 'static',
    shapes: [shape],
    name: 'plank',
    tags: ['built', 'plank'],
    transform: {
      position: add(
        from,
        rotateBy(rotation, v3(0, (-thicknessVoxels / 2) * voxelSize, (-widthVoxels / 2) * voxelSize)),
      ),
      rotation,
    },
  });
  world.addBody(body);
  return body;
}

/** Кватернион, переводящий +X в заданное направление. */
export function rotationFromXAxis(dir: Vec3) {
  const x = v3(1, 0, 0);
  const d = normalize(dir);
  const dotXD = d.x;
  if (dotXD > 0.999999) return quatIdentity();
  if (dotXD < -0.999999) return { x: 0, y: 1, z: 0, w: 0 };
  const axis = v3(x.y * d.z - x.z * d.y, x.z * d.x - x.x * d.z, x.x * d.y - x.y * d.x);
  const s = Math.sqrt((1 + dotXD) * 2);
  return {
    x: axis.x / s,
    y: axis.y / s,
    z: axis.z / s,
    w: s * 0.5,
  };
}

function rotateBy(q: { x: number; y: number; z: number; w: number }, v: Vec3): Vec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return v3(
    v.x + q.w * tx + (q.y * tz - q.z * ty),
    v.y + q.w * ty + (q.z * tx - q.x * tz),
    v.z + q.w * tz + (q.x * ty - q.y * tx),
  );
}
