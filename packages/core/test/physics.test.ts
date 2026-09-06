import { describe, expect, it } from 'vitest';
import {
  Body,
  Mat,
  Simulation,
  SimplePhysics,
  VoxelShape,
  VoxelWorld,
  bodyCenter,
  v3,
} from '@tvox/core';
import { VS, makeShape, staticBody } from './helpers.js';

function fallingBlock(mat = Mat.Concrete, y = 10, size = 4): { world: VoxelWorld; body: Body; physics: SimplePhysics } {
  const world = new VoxelWorld();
  const s = new VoxelShape({ sx: size, sy: size, sz: size, voxelSize: VS });
  s.fill({}, mat);
  const body = new Body({
    kind: 'dynamic',
    shapes: [s],
    transform: { position: v3(0, y, 0), rotation: { x: 0, y: 0, z: 0, w: 1 } },
  });
  world.addBody(body);
  const physics = new SimplePhysics(world);
  physics.sync(body);
  return { world, body, physics };
}

describe('падение и покой', () => {
  it('динамическое тело падает под гравитацией', () => {
    const { body, physics } = fallingBlock();
    const y0 = body.transform.position.y;
    for (let i = 0; i < 30; i++) physics.step(1 / 60);
    expect(body.transform.position.y).toBeLessThan(y0);
    expect(body.velocity.y).toBeLessThan(0);
  });

  it('скорость свободного падения близка к g·t', () => {
    const { body, physics } = fallingBlock();
    for (let i = 0; i < 60; i++) physics.step(1 / 60);
    expect(body.velocity.y).toBeCloseTo(-9.81, 0);
  });

  it('тело останавливается на земле и засыпает', () => {
    const { body, physics } = fallingBlock(Mat.Wood, 2);
    for (let i = 0; i < 60 * 8; i++) physics.step(1 / 60);
    expect(body.transform.position.y).toBeGreaterThanOrEqual(-1e-6);
    expect(body.sleeping).toBe(true);
    expect(body.velocity.y).toBe(0);
  });

  it('уснувшее тело не двигается, пока его не разбудят', () => {
    const { body, physics } = fallingBlock(Mat.Wood, 0.5);
    for (let i = 0; i < 60 * 8; i++) physics.step(1 / 60);
    const resting = body.transform.position.y;
    for (let i = 0; i < 60; i++) physics.step(1 / 60);
    expect(body.transform.position.y).toBe(resting);

    physics.applyImpulse(body, v3(0, 50, 0));
    expect(body.sleeping).toBe(false);
    physics.step(1 / 60);
    expect(body.transform.position.y).toBeGreaterThan(resting);
  });

  it('статическое тело не двигается', () => {
    const world = new VoxelWorld();
    const s = makeShape(4, 4, 4);
    s.fill({}, Mat.Concrete);
    const body = staticBody([s]);
    body.transform.position = v3(0, 5, 0);
    world.addBody(body);
    const physics = new SimplePhysics(world);
    physics.sync(body);
    for (let i = 0; i < 60; i++) physics.step(1 / 60);
    expect(body.transform.position.y).toBe(5);
  });

  it('скорость ограничена сверху', () => {
    const { body, physics } = fallingBlock(Mat.Metal, 5000);
    for (let i = 0; i < 60 * 60; i++) physics.step(1 / 60);
    expect(Math.abs(body.velocity.y)).toBeLessThanOrEqual(120 + 1e-6);
  });
});

describe('импульсы', () => {
  it('импульс меняет скорость обратно пропорционально массе', () => {
    const light = fallingBlock(Mat.Wood, 10, 2);
    const heavy = fallingBlock(Mat.Metal, 10, 2);
    light.physics.applyImpulse(light.body, v3(100, 0, 0));
    heavy.physics.applyImpulse(heavy.body, v3(100, 0, 0));
    expect(light.body.velocity.x).toBeGreaterThan(heavy.body.velocity.x);
  });

  it('импульс к статическому телу игнорируется', () => {
    const world = new VoxelWorld();
    const s = makeShape(2, 2, 2);
    s.fill({}, Mat.Concrete);
    const body = staticBody([s]);
    world.addBody(body);
    const physics = new SimplePhysics(world);
    physics.applyImpulse(body, v3(1000, 0, 0));
    expect(body.velocity).toEqual(v3());
  });

  it('радиальный импульс расталкивает тела от центра', () => {
    const world = new VoxelWorld();
    const physics = new SimplePhysics(world);
    const mk = (x: number) => {
      const s = new VoxelShape({ sx: 2, sy: 2, sz: 2, voxelSize: VS });
      s.fill({}, Mat.Wood);
      const b = new Body({
        kind: 'dynamic',
        shapes: [s],
        transform: { position: v3(x, 1, 0), rotation: { x: 0, y: 0, z: 0, w: 1 } },
      });
      world.addBody(b);
      physics.sync(b);
      return b;
    };
    const left = mk(-1);
    const right = mk(1);
    physics.applyRadialImpulse(v3(0, 1, 0), 5, 200);
    expect(left.velocity.x).toBeLessThan(0);
    expect(right.velocity.x).toBeGreaterThan(0);
  });

  it('радиальный импульс не достаёт за радиус', () => {
    const { body, physics } = fallingBlock(Mat.Wood, 1, 2);
    physics.applyRadialImpulse(v3(100, 100, 100), 1, 500);
    expect(body.velocity.x).toBe(0);
  });
});

describe('урон от удара', () => {
  it('тяжёлая плита при падении крошится и шлёт событие', () => {
    const world = new VoxelWorld();
    const s = new VoxelShape({ sx: 8, sy: 4, sz: 8, voxelSize: VS });
    s.fill({}, Mat.Concrete);
    const body = new Body({
      kind: 'dynamic',
      shapes: [s],
      transform: { position: v3(0, 25, 0), rotation: { x: 0, y: 0, z: 0, w: 1 } },
    });
    world.addBody(body);
    const physics = new SimplePhysics(world);
    physics.sync(body);

    let impacts = 0;
    world.events.on('impact', (e) => {
      impacts++;
      expect(e.impulse).toBeGreaterThan(0);
    });

    const before = s.solidVoxels;
    for (let i = 0; i < 60 * 5; i++) physics.step(1 / 60);
    expect(impacts).toBeGreaterThan(0);
    expect(s.solidVoxels).toBeLessThan(before);
  });

  it('лёгкий ящик с малой высоты ничего не ломает', () => {
    const world = new VoxelWorld();
    const s = new VoxelShape({ sx: 3, sy: 3, sz: 3, voxelSize: VS });
    s.fill({}, Mat.Plank);
    const body = new Body({
      kind: 'dynamic',
      shapes: [s],
      transform: { position: v3(0, 0.2, 0), rotation: { x: 0, y: 0, z: 0, w: 1 } },
    });
    world.addBody(body);
    const physics = new SimplePhysics(world);
    physics.sync(body);
    let impacts = 0;
    world.events.on('impact', () => impacts++);
    for (let i = 0; i < 120; i++) physics.step(1 / 60);
    expect(impacts).toBe(0);
    expect(s.solidVoxels).toBe(27);
  });
});

describe('утилиты', () => {
  it('центр тела — середина его AABB', () => {
    const { body } = fallingBlock(Mat.Wood, 10, 4);
    const c = bodyCenter(body);
    expect(c.y).toBeCloseTo(10 + 0.2, 6);
  });

  it('remove снимает тело с учёта', () => {
    const { body, physics } = fallingBlock();
    physics.remove(body);
    const y = body.transform.position.y;
    physics.step(1 / 60);
    // Тело всё ещё в мире и помечено грязным, поэтому шаг его подхватит,
    // но после удаления из мира — уже нет.
    body.collidersDirty = false;
    physics.remove(body);
    const y2 = body.transform.position.y;
    physics.step(1 / 60);
    expect(body.transform.position.y).toBe(y2);
    expect(y).toBeGreaterThan(y2 - 1);
  });

  it('dispose очищает список', () => {
    const { physics, body } = fallingBlock();
    physics.dispose();
    body.collidersDirty = false;
    const y = body.transform.position.y;
    physics.step(1 / 60);
    expect(body.transform.position.y).toBe(y);
  });
});

describe('Simulation: фиксированный шаг', () => {
  it('делает ровно столько шагов, сколько влезло в dt', () => {
    const sim = new Simulation({ fixedStep: 1 / 60 });
    expect(sim.step(1 / 60).steps).toBe(1);
    expect(sim.step(3 / 60).steps).toBe(3);
    expect(sim.step(0).steps).toBe(0);
  });

  it('не догоняет больше лимита шагов за кадр', () => {
    const sim = new Simulation({ fixedStep: 1 / 60, maxStepsPerFrame: 4 });
    expect(sim.step(10).steps).toBe(4);
    // Накопитель обрезан — следующий кадр не превращается в слайд-шоу.
    expect(sim.step(0).steps).toBeLessThanOrEqual(4);
  });

  it('время мира растёт вместе с шагами', () => {
    const sim = new Simulation({ fixedStep: 0.01 });
    sim.step(0.05);
    expect(sim.world.time).toBeCloseTo(0.05, 6);
  });

  it('обрушение внутри шага порождает динамическое тело', () => {
    // structureBudgetMs: 0 отключает самопланирование: в игре дорогой
    // проход отодвигает следующий, а здесь нужен ровный шаг за шагом.
    const sim = new Simulation({
      fixedStep: 1 / 60,
      structureEveryNSteps: 1,
      structureBudgetMs: 0,
    });
    const s = new VoxelShape({ sx: 9, sy: 12, sz: 9, voxelSize: VS, grounded: false });
    s.fill({ y0: 0, y1: 1 }, Mat.Foundation);
    s.fill({ x0: 4, x1: 5, y0: 1, y1: 8, z0: 4, z1: 5 }, Mat.Concrete);
    s.fill({ x0: 3, x1: 6, y0: 8, y1: 9, z0: 3, z1: 6 }, Mat.Concrete);
    sim.world.addBody(staticBody([s]));
    sim.step(1 / 60);

    s.set(4, 4, 4, Mat.Air);
    const stats = sim.step(1 / 60);
    expect(stats.structure!.fragments.length).toBe(1);
    expect(sim.world.dynamicBodies).toHaveLength(1);
  });

  it('settle считает структуру немедленно', () => {
    const sim = new Simulation();
    const s = new VoxelShape({ sx: 6, sy: 10, sz: 6, voxelSize: VS, grounded: false });
    s.fill({ y0: 0, y1: 1 }, Mat.Foundation);
    s.fill({ x0: 1, x1: 5, y0: 5, y1: 8, z0: 1, z1: 5 }, Mat.Concrete);
    sim.world.addBody(staticBody([s]));
    expect(sim.settle().fragments).toHaveLength(1);
  });

  it('reset очищает мир и огонь', () => {
    const sim = new Simulation();
    const s = makeShape(4, 4, 4);
    s.fill({}, Mat.Wood);
    const body = staticBody([s]);
    sim.world.addBody(body);
    sim.fire.ignite(body, s, s.idx(1, 3, 1));
    sim.reset();
    expect(sim.world.bodies.size).toBe(0);
    expect(sim.fire.burningCount).toBe(0);
    expect(sim.world.time).toBe(0);
    sim.dispose();
  });
});
