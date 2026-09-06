import { describe, expect, it } from 'vitest';
import {
  Body,
  Mat,
  Simulation,
  SimplePhysics,
  VoxelShape,
  VoxelWorld,
  capDebris,
  freeze,
  v3,
} from '@tvox/core';
import { VS } from './helpers.js';

/** Обломок из size³ вокселей в заданной точке мира. */
function debris(x: number, y: number, z: number, size = 3, mat: Mat = Mat.Brick): Body {
  const s = new VoxelShape({ sx: size, sy: size, sz: size, voxelSize: VS });
  s.fill({ x0: 0, y0: 0, z0: 0, x1: size, y1: size, z1: size }, mat);
  const b = new Body({
    kind: 'dynamic',
    shapes: [s],
    name: `обломок${x}`,
    tags: ['debris'],
    transform: { position: v3(x, y, z), rotation: { x: 0, y: 0, z: 0, w: 1 } },
  });
  b.sleeping = true;
  return b;
}

function worldOfDebris(count: number, distance = 40): VoxelWorld {
  const world = new VoxelWorld();
  for (let i = 0; i < count; i++) {
    world.addBody(debris(distance + i * 0.5, 0.2, 0));
  }
  return world;
}

describe('потолок числа обломков', () => {
  it('лишние обломки вмерзают в статику, а не исчезают', () => {
    const world = worldOfDebris(30);
    const before = world.totalSolidVoxels();
    const bodies = world.bodies.size;

    const res = capDebris(world, { maxActive: 10, focus: v3() });

    expect(res.frozen).toBe(20);
    // Ничего не удалено: воксели на месте, тела на месте.
    expect(world.totalSolidVoxels()).toBe(before);
    expect(world.bodies.size).toBe(bodies);
    for (const b of res.bodies) {
      expect(b.kind).toBe('static');
      expect(b.tags.has('frozen')).toBe(true);
    }
  });

  it('первыми уходят мелкие и дальние', () => {
    const world = new VoxelWorld();
    const near = debris(2, 0.2, 0, 3);
    const far = debris(60, 0.2, 0, 3);
    const bigFar = debris(62, 0.2, 0, 9);
    world.addBody(near);
    world.addBody(far);
    world.addBody(bigFar);

    capDebris(world, { maxActive: 2, focus: v3(), keepWithin: 5, keepAboveVoxels: 600 });

    expect(far.kind).toBe('static');
    expect(near.kind).toBe('dynamic');
    expect(bigFar.kind).toBe('dynamic');
  });

  it('крупный обломок и обломок под ногами не морозятся', () => {
    const world = new VoxelWorld();
    const huge = debris(80, 0.2, 0, 12);
    const underfoot = debris(3, 0.2, 0, 3);
    world.addBody(huge);
    world.addBody(underfoot);

    const res = capDebris(world, { maxActive: 0, focus: v3(), keepAboveVoxels: 600, keepWithin: 8 });

    expect(res.frozen).toBe(0);
    expect(huge.kind).toBe('dynamic');
    expect(underfoot.kind).toBe('dynamic');
  });

  it('летящий обломок не морозится на лету', () => {
    const world = new VoxelWorld();
    const flying = debris(50, 5, 0, 3);
    flying.sleeping = false;
    flying.velocity = v3(0, -8, 0);
    world.addBody(flying);

    expect(capDebris(world, { maxActive: 0, focus: v3() }).frozen).toBe(0);
    flying.velocity = v3();
    flying.sleeping = true;
    expect(capDebris(world, { maxActive: 0, focus: v3() }).frozen).toBe(1);
  });

  it('вмороженный обломок стоит на месте и не считается солвером', () => {
    const world = new VoxelWorld();
    const b = debris(30, 6, 0);
    b.sleeping = false;
    world.addBody(b);
    const physics = new SimplePhysics(world);
    physics.sync(b);

    freeze(b);
    physics.sync(b);
    const y = b.transform.position.y;
    for (let i = 0; i < 120; i++) physics.step(1 / 60);

    expect(b.transform.position.y).toBe(y);
  });

  it('симуляция держит потолок сама', () => {
    const sim = new Simulation({ debris: { maxActive: 5, keepWithin: 1 } });
    for (let i = 0; i < 12; i++) sim.world.addBody(debris(20 + i, 0.2, 0));
    sim.focus = v3(0, 0, 0);

    const stats = sim.step(1 / 60);
    expect(stats.frozen).toBeGreaterThan(0);
    const live = [...sim.world.bodies.values()].filter((b) => b.kind === 'dynamic');
    expect(live.length).toBeLessThanOrEqual(5);
  });
});

describe('сон и пробуждение', () => {
  it('уснувшее тело не двигается', () => {
    const world = new VoxelWorld();
    const b = debris(10, 5, 0);
    world.addBody(b);
    const physics = new SimplePhysics(world);
    physics.sync(b);

    const y = b.transform.position.y;
    for (let i = 0; i < 60; i++) physics.step(1 / 60);
    expect(b.transform.position.y).toBe(y);
  });

  it('импульс будит тело', () => {
    const world = new VoxelWorld();
    const b = debris(10, 5, 0);
    world.addBody(b);
    const physics = new SimplePhysics(world);
    physics.sync(b);

    physics.applyImpulse(b, v3(0, 40, 0));
    expect(b.sleeping).toBe(false);
    const y = b.transform.position.y;
    physics.step(1 / 60);
    expect(b.transform.position.y).not.toBe(y);
  });

  it('удар будит соседей, а дальних не трогает', () => {
    const world = new VoxelWorld();
    const near = debris(1, 0.2, 0);
    const far = debris(30, 0.2, 0);
    world.addBody(near);
    world.addBody(far);
    const physics = new SimplePhysics(world);

    const woken = physics.wakeNear(v3(0, 0, 0), 4);

    expect(woken).toBe(1);
    expect(near.sleeping).toBe(false);
    expect(far.sleeping).toBe(true);
  });

  it('падающая плита будит то, что лежит рядом', () => {
    const sim = new Simulation();
    const ground = new VoxelShape({ sx: 200, sy: 4, sz: 60, voxelSize: VS, grounded: true });
    ground.fill({ x0: 0, y0: 0, z0: 0, x1: 200, y1: 4, z1: 60 }, Mat.Concrete);
    sim.world.addBody(new Body({ kind: 'static', shapes: [ground], name: 'плац', tags: ['level'] }));

    const sleeper = debris(1.2, 0.45, 1.5, 3);
    sim.world.addBody(sleeper);

    // Тяжёлая плита падает рядом с шести метров.
    const s = new VoxelShape({ sx: 20, sy: 6, sz: 20, voxelSize: VS });
    s.fill({ x0: 0, y0: 0, z0: 0, x1: 20, y1: 6, z1: 20 }, Mat.HeavyMetal);
    sim.world.addBody(
      new Body({
        kind: 'dynamic',
        shapes: [s],
        name: 'плита',
        tags: ['debris'],
        transform: { position: v3(0.6, 6, 0.6), rotation: { x: 0, y: 0, z: 0, w: 1 } },
      }),
    );

    for (let i = 0; i < 120; i++) sim.step(1 / 60);
    expect(sleeper.sleeping).toBe(false);
  });
});
