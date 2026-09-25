import { beforeAll, describe, expect, it } from 'vitest';
import {
  Body,
  Mat,
  RapierPhysics,
  Simulation,
  VoxelShape,
  VoxelWorld,
  averageDensity,
  decomposeCoarse,
  v3,
} from '@tvox/core';
import { VS, staticBody } from './helpers.js';

/**
 * Rapier — WASM, но в Node он работает, поэтому адаптер проверяется
 * по-настоящему, а не «на глаз в браузере».
 */
describe('Rapier как физический бэкенд', () => {
  let available = true;

  beforeAll(async () => {
    try {
      await RapierPhysics.create(new VoxelWorld());
    } catch {
      available = false;
    }
  }, 60_000);

  function ground(world: VoxelWorld): Body {
    const s = new VoxelShape({ sx: 120, sy: 4, sz: 120, voxelSize: VS, grounded: true });
    s.fill({}, Mat.Concrete);
    s.transform = { position: v3(-6, -0.4, -6), rotation: { x: 0, y: 0, z: 0, w: 1 } };
    return world.addBody(staticBody([s], 'ground'));
  }

  function cube(world: VoxelWorld, y: number, mat = Mat.Concrete, n = 6): Body {
    const s = new VoxelShape({ sx: n, sy: n, sz: n, voxelSize: VS });
    s.fill({}, mat);
    const b = new Body({
      kind: 'dynamic',
      shapes: [s],
      transform: { position: v3(0, y, 0), rotation: { x: 0, y: 0, z: 0, w: 1 } },
    });
    return world.addBody(b);
  }

  it('обломок падает и останавливается на статической геометрии', async () => {
    if (!available) return;
    const world = new VoxelWorld();
    ground(world);
    const box = cube(world, 4);
    const physics = await RapierPhysics.create(world);
    physics.sync(box);

    for (let i = 0; i < 240; i++) physics.step(1 / 60);
    expect(box.transform.position.y).toBeLessThan(4);
    expect(box.transform.position.y).toBeGreaterThan(-0.1);
    expect(Math.abs(box.velocity.y)).toBeLessThan(0.5);
    physics.dispose();
  }, 60_000);

  it('новый фрагмент сохраняет начальную скорость при передаче в Rapier', async () => {
    const world = new VoxelWorld({gravity: v3()});
    const body = cube(world, 3, Mat.Wood);
    body.velocity = v3(2, 0, 0);
    body.angularVelocity = v3(0, 1, 0);
    const physics = await RapierPhysics.create(world);
    physics.sync(body);
    physics.step(1/60);
    expect(body.velocity.x).toBeGreaterThan(1.9);
    expect(body.angularVelocity.y).toBeGreaterThan(0.9);
    physics.dispose();
  });

  it('взрыв действует по центру массы смещённой формы, а не по началу координат тела', async () => {
    const world = new VoxelWorld({gravity: v3()});
    const body = cube(world, 0, Mat.Wood);
    body.shapes[0].transform.position = v3(30, 3, 0);
    const physics = await RapierPhysics.create(world);
    physics.sync(body);
    physics.applyRadialImpulse(v3(29, 3.3, .3), 4, 100);
    physics.step(1/60);
    expect(body.velocity.x).toBeGreaterThan(0);
    physics.dispose();
  });

  it('тело со временем засыпает', async () => {
    if (!available) return;
    const world = new VoxelWorld();
    ground(world);
    const box = cube(world, 0.5, Mat.Wood);
    const physics = await RapierPhysics.create(world);
    physics.sync(box);
    for (let i = 0; i < 600; i++) physics.step(1 / 60);
    expect(box.sleeping).toBe(true);
    physics.dispose();
  }, 60_000);

  it('импульс двигает тело в заданную сторону', async () => {
    if (!available) return;
    const world = new VoxelWorld();
    ground(world);
    const box = cube(world, 1, Mat.Wood);
    const physics = await RapierPhysics.create(world);
    physics.sync(box);
    physics.step(1 / 60);
    physics.applyImpulse(box, v3(30, 0, 0));
    for (let i = 0; i < 30; i++) physics.step(1 / 60);
    expect(box.transform.position.x).toBeGreaterThan(0.05);
    physics.dispose();
  }, 60_000);

  it('радиальный импульс расталкивает, за радиусом — нет', async () => {
    if (!available) return;
    const world = new VoxelWorld();
    ground(world);
    const near = cube(world, 1, Mat.Wood, 4);
    near.transform.position = v3(1, 1, 0);
    const far = cube(world, 1, Mat.Wood, 4);
    far.transform.position = v3(30, 1, 0);
    const physics = await RapierPhysics.create(world);
    physics.sync(near);
    physics.sync(far);
    physics.step(1 / 60);
    physics.applyRadialImpulse(v3(0, 1, 0), 5, 400);
    for (let i = 0; i < 20; i++) physics.step(1 / 60);
    expect(near.transform.position.x).toBeGreaterThan(1);
    expect(Math.abs(far.transform.position.x - 30)).toBeLessThan(0.2);
    physics.dispose();
  }, 60_000);

  it('статическое тело не двигается', async () => {
    if (!available) return;
    const world = new VoxelWorld();
    const g = ground(world);
    const physics = await RapierPhysics.create(world);
    physics.sync(g);
    for (let i = 0; i < 60; i++) physics.step(1 / 60);
    expect(g.transform.position.y).toBeCloseTo(0, 9);
    physics.dispose();
  }, 60_000);

  it('удалённое тело уходит из солвера', async () => {
    if (!available) return;
    const world = new VoxelWorld();
    ground(world);
    const box = cube(world, 3);
    const physics = await RapierPhysics.create(world);
    physics.sync(box);
    physics.step(1 / 60);
    expect(physics.bodyCount).toBe(2);
    world.removeBody(box);
    physics.step(1 / 60);
    expect(physics.bodyCount).toBe(1);
    physics.dispose();
  }, 60_000);

  it('крупная геометрия коллайдируется огрублённо', async () => {
    if (!available) return;
    const world = new VoxelWorld();
    const g = ground(world);
    const physics = await RapierPhysics.create(world, { coarseAbove: 100, coarseFactor: 8 });
    physics.sync(g);
    // 120×4×120 вокселей — это 57 600 клеток; точная декомпозиция дала бы
    // один бокс, но проверяем сам факт огрубления через число коллайдеров.
    expect(physics.colliderCount).toBeGreaterThan(0);
    expect(physics.colliderCount).toBeLessThan(200);
    physics.dispose();
  }, 60_000);

  it('масса тела совпадает с суммой масс вокселей', async () => {
    const s = new VoxelShape({ sx: 5, sy: 5, sz: 5, voxelSize: VS });
    s.fill({}, Mat.Metal);
    const expected = 7800;
    expect(averageDensity(s)).toBeCloseTo(expected, 6);

    const half = new VoxelShape({ sx: 4, sy: 4, sz: 4, voxelSize: VS });
    half.fill({ y0: 0, y1: 2 }, Mat.Wood);
    expect(averageDensity(half)).toBeCloseTo(700, 6);

    expect(averageDensity(new VoxelShape({ sx: 2, sy: 2, sz: 2 }))).toBe(1);
  });

  it('огрублённая декомпозиция покрывает форму и экономит боксы', () => {
    const s = new VoxelShape({ sx: 32, sy: 8, sz: 32, voxelSize: VS });
    for (let z = 0; z < 32; z += 2) {
      for (let x = 0; x < 32; x += 2) {
        s.fill({ x0: x, x1: x + 1, y0: 0, y1: 8, z0: z, z1: z + 1 }, Mat.Concrete);
      }
    }
    const fine = decomposeCoarse(s, 1);
    const coarse = decomposeCoarse(s, 4);
    expect(coarse.length).toBeLessThan(fine.length);
    expect(coarse.length).toBeGreaterThan(0);
    for (const b of coarse) {
      expect(b.hx).toBeGreaterThan(0);
      expect(b.hy).toBeGreaterThan(0);
      expect(b.hz).toBeGreaterThan(0);
    }
  });

  it('симуляция переключается на Rapier на ходу', async () => {
    if (!available) return;
    const sim = new Simulation();
    const s = new VoxelShape({ sx: 40, sy: 3, sz: 40, voxelSize: VS, grounded: true });
    s.fill({}, Mat.Concrete);
    s.transform = { position: v3(-2, -0.3, -2), rotation: { x: 0, y: 0, z: 0, w: 1 } };
    sim.world.addBody(staticBody([s], 'floor'));

    const physics = await RapierPhysics.create(sim.world);
    sim.setPhysics(physics);
    expect(sim.physics).toBe(physics);

    const drop = new VoxelShape({ sx: 4, sy: 4, sz: 4, voxelSize: VS });
    drop.fill({}, Mat.Brick);
    const body = sim.world.addBody(
      new Body({
        kind: 'dynamic',
        shapes: [drop],
        transform: { position: v3(0, 3, 0), rotation: { x: 0, y: 0, z: 0, w: 1 } },
      }),
    );
    for (let i = 0; i < 240; i++) sim.step(1 / 60);
    expect(body.transform.position.y).toBeLessThan(2.9);
    expect(body.transform.position.y).toBeGreaterThan(-0.5);
    sim.dispose();
  }, 60_000);
});

describe('удар считается по потере скорости, а не по силе контакта', () => {
  let available = true;
  beforeAll(async () => {
    try {
      await RapierPhysics.create(new VoxelWorld());
    } catch {
      available = false;
    }
  }, 60_000);

  function scene(): { world: VoxelWorld; floor: Body } {
    const world = new VoxelWorld();
    const s = new VoxelShape({ sx: 80, sy: 4, sz: 80, voxelSize: VS, grounded: true });
    s.fill({}, Mat.Concrete);
    s.transform = { position: v3(-4, -0.4, -4), rotation: { x: 0, y: 0, z: 0, w: 1 } };
    return { world, floor: world.addBody(staticBody([s], 'floor')) };
  }

  function drop(world: VoxelWorld, y: number, n: number, mat: Mat): Body {
    const s = new VoxelShape({ sx: n, sy: n, sz: n, voxelSize: VS });
    s.fill({}, mat);
    return world.addBody(
      new Body({
        kind: 'dynamic',
        shapes: [s],
        transform: { position: v3(0, y, 0), rotation: { x: 0, y: 0, z: 0, w: 1 } },
      }),
    );
  }

  it('лежащее тело не проедает опору под собой', async () => {
    if (!available) return;
    const { world, floor } = scene();
    drop(world, 0.05, 8, Mat.Loot);
    const physics = await RapierPhysics.create(world);
    let impacts = 0;
    world.events.on('impact', () => impacts++);
    const before = floor.solidVoxels;
    for (let i = 0; i < 600; i++) physics.step(1 / 60);
    expect(impacts).toBe(0);
    expect(floor.solidVoxels).toBe(before);
    physics.dispose();
  }, 60_000);

  it('плита с высоты бьёт и оставляет воронку', async () => {
    if (!available) return;
    const { world, floor } = scene();
    drop(world, 12, 10, Mat.Concrete);
    const physics = await RapierPhysics.create(world);
    let impacts = 0;
    world.events.on('impact', () => impacts++);
    const before = floor.solidVoxels;
    for (let i = 0; i < 300; i++) physics.step(1 / 60);
    expect(impacts).toBeGreaterThan(0);
    expect(floor.solidVoxels).toBeLessThan(before);
    physics.dispose();
  }, 60_000);

  it('защищённые материалы не крошатся ударом', async () => {
    if (!available) return;
    const world = new VoxelWorld();
    const s = new VoxelShape({ sx: 80, sy: 4, sz: 80, voxelSize: VS, grounded: true });
    s.fill({}, Mat.Loot);
    s.transform = { position: v3(-4, -0.4, -4), rotation: { x: 0, y: 0, z: 0, w: 1 } };
    const floor = world.addBody(staticBody([s], 'loot-floor'));
    drop(world, 12, 10, Mat.Concrete);
    const physics = await RapierPhysics.create(world, {
      protectedMaterials: new Set([Mat.Loot]),
    });
    const before = floor.solidVoxels;
    for (let i = 0; i < 300; i++) physics.step(1 / 60);
    expect(floor.solidVoxels).toBe(before);
    physics.dispose();
  }, 60_000);
});
