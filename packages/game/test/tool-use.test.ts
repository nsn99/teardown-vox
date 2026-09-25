import { describe, expect, it } from 'vitest';
import { Body, Mat, RapierPhysics, Simulation, VoxelShape, v3 } from '@tvox/core';
import {
  ChargeSystem,
  Inventory,
  PlankBuilder,
  ToolContext,
  ToolId,
  buildPlank,
  rotationFromXAxis,
  useTool,
} from '@tvox/game';

const VS = 0.1;

/** Стена 4×3×0.4 м на расстоянии 1 м перед игроком (взгляд в +X). */
function wallWorld(mat = Mat.Brick) {
  const sim = new Simulation();
  const s = new VoxelShape({ sx: 4, sy: 30, sz: 40, voxelSize: VS, grounded: true });
  s.fill({}, mat);
  s.transform = { position: v3(1, 0, -2), rotation: { x: 0, y: 0, z: 0, w: 1 } };
  const body = new Body({ kind: 'static', shapes: [s], name: 'wall', tags: ['level'] });
  sim.world.addBody(body);
  return { sim, shape: s, body };
}

function ctxFor(sim: Simulation, tool: ToolId, tier = 0, unlimited = false): ToolContext {
  const inventory = new Inventory({ unlimited });
  inventory.select(tool);
  inventory.setTier(tool, tier);
  return {
    sim,
    inventory,
    origin: v3(0, 1.5, 0),
    direction: v3(1, 0, 0),
  };
}

describe('кувалда', () => {
  it.each(['sledge', 'shotgun', 'blowtorch'] as const)('%s максимальной ступени не пробивает бетон', (tool) => {
    const { sim, shape } = wallWorld(Mat.Concrete);
    const ctx = ctxFor(sim, tool, 3, true);
    for (let i = 0; i < 40; i++) { useTool(ctx); ctx.inventory.tick(10); }
    expect(shape.solidVoxels).toBe(4800);
  });
  it.each([['shotgun', Mat.Metal], ['blowtorch', Mat.HeavyMetal]] as const)('%s не пробивает защищённый материал %i', (tool, mat) => {
    const { sim, shape } = wallWorld(mat);
    const ctx = ctxFor(sim, tool, 3, true);
    for (let i = 0; i < 40; i++) { useTool(ctx); ctx.inventory.tick(10); }
    expect(shape.solidVoxels).toBe(4800);
  });
  it('снимает кирпич за несколько ударов', () => {
    const { sim, shape } = wallWorld(Mat.Brick);
    const ctx = ctxFor(sim, 'sledge');
    let removed = 0;
    for (let i = 0; i < 12; i++) {
      const r = useTool(ctx);
      removed += r.removed ?? 0;
      ctx.inventory.tick(1);
    }
    expect(removed).toBeGreaterThan(0);
    expect(shape.solidVoxels).toBeLessThan(4 * 30 * 40);
  });

  it('по стальной двери бесполезна', () => {
    const { sim, shape } = wallWorld(Mat.Metal);
    const ctx = ctxFor(sim, 'sledge', 3);
    for (let i = 0; i < 40; i++) {
      useTool(ctx);
      ctx.inventory.tick(1);
    }
    expect(shape.solidVoxels).toBe(4 * 30 * 40);
    expect(shape.damage.some(d => d > 0)).toBe(true);
  });

  it('в пустоту не бьёт', () => {
    const sim = new Simulation();
    const ctx = ctxFor(sim, 'sledge');
    expect(useTool(ctx)).toMatchObject({ used: false, reason: 'no-target' });
  });

  it('откат не даёт бить чаще, чем положено', () => {
    const { sim } = wallWorld();
    const ctx = ctxFor(sim, 'sledge');
    expect(useTool(ctx).used).toBe(true);
    expect(useTool(ctx)).toMatchObject({ used: false, reason: 'cooldown' });
    ctx.inventory.tick(1);
    expect(useTool(ctx).used).toBe(true);
  });

  it('дальше своей дистанции не достаёт', () => {
    const sim = new Simulation();
    const s = new VoxelShape({ sx: 10, sy: 30, sz: 40, voxelSize: VS, grounded: true });
    s.fill({}, Mat.Brick);
    s.transform = { position: v3(6, 0, -2), rotation: { x: 0, y: 0, z: 0, w: 1 } };
    sim.world.addBody(new Body({ kind: 'static', shapes: [s] }));
    const ctx = ctxFor(sim, 'sledge');
    expect(useTool(ctx).used).toBe(false);
  });
});

describe('паяльная лампа', () => {
  it('режет металл', () => {
    const { sim, shape } = wallWorld(Mat.Metal);
    const ctx = ctxFor(sim, 'blowtorch');
    let removed = 0;
    for (let i = 0; i < 30; i++) {
      removed += useTool(ctx).removed ?? 0;
      ctx.inventory.tick(1);
    }
    expect(removed).toBeGreaterThan(0);
    expect(shape.solidVoxels).toBeLessThan(4 * 30 * 40);
  });

  it('поджигает дерево рядом', () => {
    const { sim } = wallWorld(Mat.Wood);
    const ctx = ctxFor(sim, 'blowtorch');
    const res = useTool(ctx);
    expect(res.used).toBe(true);
    expect(sim.fire.burningCount).toBeGreaterThan(0);
    expect(res.ignited).toBeGreaterThan(0);
  });
});

describe('дробовик', () => {
  it('бьёт конусом на дистанции', () => {
    const sim = new Simulation();
    const s = new VoxelShape({ sx: 4, sy: 60, sz: 60, voxelSize: VS, grounded: true });
    s.fill({}, Mat.Glass);
    s.transform = { position: v3(5, 0, -3), rotation: { x: 0, y: 0, z: 0, w: 1 } };
    sim.world.addBody(new Body({ kind: 'static', shapes: [s] }));
    const ctx = ctxFor(sim, 'shotgun');
    const res = useTool(ctx);
    expect(res.used).toBe(true);
    expect(res.removed).toBeGreaterThan(10);
  });

  it('без патронов не стреляет', () => {
    const { sim } = wallWorld();
    const ctx = ctxFor(sim, 'shotgun');
    const cap = ctx.inventory.capacity('shotgun');
    for (let i = 0; i < cap; i++) {
      useTool(ctx);
      ctx.inventory.tick(1);
    }
    expect(useTool(ctx)).toMatchObject({ used: false, reason: 'no-ammo' });
  });
});

describe('огнетушитель и баллончик', () => {
  it('тушит горящее', () => {
    const { sim, shape, body } = wallWorld(Mat.Wood);
    sim.fire.ignite(body, shape, shape.idx(0, 15, 20));
    expect(sim.fire.burningCount).toBe(1);
    const ctx = ctxFor(sim, 'extinguisher');
    const res = useTool(ctx);
    expect(res.used).toBe(true);
    expect(sim.fire.burningCount).toBe(0);
  });

  it('работает и в пустоту — просто пшикает вперёд', () => {
    const sim = new Simulation();
    const ctx = ctxFor(sim, 'extinguisher');
    const res = useTool(ctx);
    expect(res.used).toBe(true);
    expect(res.doused).toBe(0);
  });

  it('баллончик красит, не меняя материал', () => {
    const { sim, shape } = wallWorld(Mat.Concrete);
    const before = shape.solidVoxels;
    const ctx = ctxFor(sim, 'spraycan');
    ctx.paintColor = 2;
    const res = useTool(ctx);
    expect(res.painted).toBeGreaterThan(0);
    expect(shape.solidVoxels).toBe(before);
    expect(shape.paint.size).toBe(res.painted);
  });

  it('баллончик в пустоту не тратится', () => {
    const sim = new Simulation();
    const ctx = ctxFor(sim, 'spraycan');
    const before = ctx.inventory.ammo('spraycan');
    expect(useTool(ctx).used).toBe(false);
    expect(ctx.inventory.ammo('spraycan')).toBe(before);
  });
});

describe('взрывчатка', () => {
  it('взрыв толкает только что отделённую верхушку колонны', async () => {
    const sim = new Simulation();
    const shape = new VoxelShape({sx: 1, sy: 40, sz: 1, voxelSize: 0.1, grounded: true});
    shape.fill({}, Mat.Wood);
    shape.transform.position = v3(1, 0, 0);
    sim.world.addBody(new Body({kind: 'static', shapes: [shape]}));
    sim.setPhysics(await RapierPhysics.create(sim.world));
    const ctx = ctxFor(sim, 'explosive');
    ctx.origin = v3(0, 0.5, 0.05);
    const charges = new ChargeSystem({fuse: Infinity});
    expect(charges.place(ctx)).not.toBeNull();
    charges.detonateAll(sim);
    sim.step(1/60);
    const fragment = [...sim.world.bodies.values()].find(b => b.tags.has('debris'));
    expect(fragment).toBeDefined();
    expect(fragment!.velocity.y).toBeGreaterThan(0);
    sim.dispose();
  });
  it('ставится на поверхность и взрывается по таймеру', () => {
    const { sim, shape } = wallWorld(Mat.Brick);
    const ctx = ctxFor(sim, 'explosive');
    const charges = new ChargeSystem({ fuse: 2 });
    const c = charges.place(ctx);
    expect(c).not.toBeNull();
    expect(charges.count).toBe(1);

    const before = shape.solidVoxels;
    charges.step(sim, 1);
    expect(charges.count).toBe(1);
    charges.step(sim, 1.5);
    expect(charges.count).toBe(0);
    expect(shape.solidVoxels).toBeLessThan(before);
  });

  it('детонатор подрывает всё разом', () => {
    const { sim } = wallWorld(Mat.Brick);
    const ctx = ctxFor(sim, 'explosive', 3, true);
    const charges = new ChargeSystem({ fuse: Infinity });
    charges.place(ctx);
    ctx.inventory.tick(1);
    ctx.direction = v3(1, 0.1, 0);
    charges.place(ctx);
    expect(charges.count).toBe(2);
    charges.step(sim, 100);
    expect(charges.count).toBe(2);
    expect(charges.detonateAll(sim)).toBe(2);
    expect(charges.count).toBe(0);
  });

  it('не ставится в пустоту и не тратит заряд', () => {
    const sim = new Simulation();
    const ctx = ctxFor(sim, 'explosive');
    const before = ctx.inventory.ammo('explosive');
    expect(new ChargeSystem().place(ctx)).toBeNull();
    expect(ctx.inventory.ammo('explosive')).toBe(before);
  });

  it('не ставится, если выбран другой инструмент', () => {
    const { sim } = wallWorld();
    const ctx = ctxFor(sim, 'sledge');
    expect(new ChargeSystem().place(ctx)).toBeNull();
  });

  it('взрыв поджигает горючее вокруг', () => {
    const { sim } = wallWorld(Mat.Wood);
    const ctx = ctxFor(sim, 'explosive');
    const charges = new ChargeSystem({ fuse: 0.5 });
    charges.place(ctx);
    charges.step(sim, 1);
    expect(sim.fire.burningCount).toBeGreaterThan(0);
  });

  it('clear убирает неразорвавшиеся заряды', () => {
    const { sim } = wallWorld();
    const ctx = ctxFor(sim, 'explosive');
    const charges = new ChargeSystem({ fuse: Infinity });
    charges.place(ctx);
    expect(charges.list()).toHaveLength(1);
    charges.clear();
    expect(charges.count).toBe(0);
  });
});

describe('доски', () => {
  it('первый клик ставит точку, второй строит', () => {
    const { sim } = wallWorld();
    const ctx = ctxFor(sim, 'planks');
    const builder = new PlankBuilder();

    const first = builder.click(ctx);
    expect(first).toMatchObject({ used: false, reason: 'needs-second-point' });
    expect(builder.anchor).not.toBeNull();

    ctx.direction = v3(1, 0.15, 0);
    const second = builder.click(ctx);
    expect(second.used).toBe(true);
    expect(second.spawned).toBeDefined();
    expect(builder.anchor).toBeNull();
  });

  it('отмена сбрасывает точку', () => {
    const { sim } = wallWorld();
    const ctx = ctxFor(sim, 'planks');
    const builder = new PlankBuilder();
    builder.click(ctx);
    builder.cancel();
    expect(builder.anchor).toBeNull();
  });

  it('без цели ничего не запоминает', () => {
    const sim = new Simulation();
    const ctx = ctxFor(sim, 'planks');
    const builder = new PlankBuilder();
    expect(builder.click(ctx)).toMatchObject({ used: false, reason: 'no-target' });
    expect(builder.anchor).toBeNull();
  });

  it('доска попадает в мир и имеет ненулевой объём', () => {
    const sim = new Simulation();
    const body = buildPlank(sim.world, v3(0, 1, 0), v3(3, 1, 0));
    expect(body).not.toBeNull();
    expect(body!.solidVoxels).toBeGreaterThan(0);
    expect(sim.world.bodies.has(body!.id)).toBe(true);
  });

  it('вырожденная доска не создаётся', () => {
    const sim = new Simulation();
    expect(buildPlank(sim.world, v3(0, 0, 0), v3(0, 0, 0.01))).toBeNull();
  });

  it('поворот вдоль оси X обрабатывает вырожденные случаи', () => {
    expect(rotationFromXAxis(v3(1, 0, 0))).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(rotationFromXAxis(v3(-1, 0, 0))).toEqual({ x: 0, y: 1, z: 0, w: 0 });
    const q = rotationFromXAxis(v3(0, 0, 1));
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 9);
  });
});
