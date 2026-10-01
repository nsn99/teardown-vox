import { describe, expect, it } from 'vitest';
import { Body, Mat, RapierPhysics, Simulation, VoxelShape, v3 } from '@tvox/core';
import { NEUTRAL_INPUT, Vehicle } from '@tvox/game';

function wall(sim: Simulation, material = Mat.Brick) {
  const shape = new VoxelShape({ sx: 80, sy: 30, sz: 4, voxelSize: 0.1, grounded: true });
  shape.fill({}, material);
  shape.transform.position = v3(-4, 0, -4);
  const body = sim.world.addBody(new Body({ kind: 'static', shapes: [shape] }));
  return { shape, body };
}

function pickup(sim: Simulation) {
  const car = new Vehicle('pickup', { position: v3(0, 0.1, 0) });
  car.spawn(sim);
  car.speed = 15;
  return car;
}

const input = { ...NEUTRAL_INPUT, throttle: 1 };

function firstHit(car: Vehicle, sim: Simulation, target: Body) {
  const before = target.solidVoxels;
  for (let i = 0; i < 40; i++) {
    const position = { ...car.position };
    car.update(sim, input, 1 / 60);
    if (target.solidVoxels < before) return position;
  }
  throw new Error('Стена не повреждена за время подхода');
}

describe('скол и обломки после тарана', () => {
  it('оставляет скол разной ширины по высоте и не останавливается на собственных кусках', () => {
    const sim = new Simulation();
    const target = wall(sim);
    const car = pickup(sim);
    const position = firstHit(car, sim, target.body);
    expect(car.position.z).toBeLessThan(position.z);
    const widths = new Set<number>();
    for (let y = 0; y < target.shape.sy; y++) {
      let count = 0;
      for (let x = 0; x < target.shape.sx; x++) {
        if (target.shape.get(x, y, 0) === Mat.Air) count++;
      }
      if (count) widths.add(count);
    }
    expect(widths.size).toBeGreaterThan(2);
    const chips = sim.world.dynamicBodies.filter(b => b.tags.has('carved-debris'));
    expect(chips.length).toBeGreaterThan(1);
    expect(chips.length).toBeLessThanOrEqual(32);
    expect(chips.every(b => b.solidVoxels <= 64 && b.velocity.z < 0)).toBe(true);
    const counts = chips.map(b => b.solidVoxels);
    for (let i = 0; i < 12; i++) car.update(sim, input, 1 / 60);
    expect(chips.map(b => b.solidVoxels)).toEqual(counts);
  });

  it('удаление дерева рядом со сталью не разрешает проехать сквозь сталь', () => {
    const sim = new Simulation();
    const target = wall(sim, Mat.Metal);
    target.shape.fill({ x0: 36, x1: 40 }, Mat.Wood);
    const car = pickup(sim);
    const position = firstHit(car, sim, target.body);
    expect(car.position).toEqual(position);
    expect(target.shape.get(41, 8, 2)).toBe(Mat.Metal);
  });

  it('на малой скорости кирпич не ломается и обломки не создаются', () => {
    const sim = new Simulation();
    const target = wall(sim);
    const before = target.body.solidVoxels;
    const car = pickup(sim);
    car.speed = 1;
    for (let i = 0; i < 180; i++) car.update(sim, { ...input, throttle: 0.1 }, 1 / 60);
    expect(target.body.solidVoxels).toBe(before);
    expect(sim.world.dynamicBodies.filter(b => b.tags.has('carved-debris'))).toEqual([]);
  });

  it('проверка щупа восстанавливает состояние обломков после временного исключения', () => {
    const sim = new Simulation();
    const target = wall(sim);
    const car = pickup(sim);
    firstHit(car, sim, target.body);
    const chips = sim.world.dynamicBodies.filter(b => b.tags.has('carved-debris'));
    car.update(sim, input, 1 / 60);
    expect(chips.every(b => !b.destroyed && sim.world.bodies.has(b.id))).toBe(true);
  });

  it('Rapier двигает выбитые куски и удерживает материал над полом', async () => {
    const sim = new Simulation();
    const floor = new VoxelShape({ sx: 120, sy: 2, sz: 140, voxelSize: 0.1, grounded: true });
    floor.fill({}, Mat.Foundation);
    floor.transform.position = v3(-6, -0.2, -10);
    sim.world.addBody(new Body({ kind: 'static', shapes: [floor] }));
    const target = wall(sim);
    const physics = await RapierPhysics.create(sim.world, { coarseAbove: Infinity });
    sim.setPhysics(physics);
    try {
      const car = pickup(sim);
      firstHit(car, sim, target.body);
      const chips = sim.world.dynamicBodies.filter(b => b.tags.has('carved-debris'));
      const start = chips.map(b => ({ ...b.transform.position }));
      sim.world.removeBody(car.body);
      for (let i = 0; i < 120; i++) physics.step(1 / 60);
      expect(chips.every(b => b.physicsHandle !== null)).toBe(true);
      expect(chips.some((b, i) => Math.abs(b.transform.position.z - start[i].z) > 0.05)).toBe(true);
      for (const b of chips) for (const shape of b.shapes) {
        const p = { x: 0, y: 0, z: 0 };
        for (let i = 0; i < shape.data.length; i++) {
          if (shape.data[i] === Mat.Air) continue;
          shape.coords(i, p);
          expect(shape.voxelCenterWorld(p.x, p.y, p.z, b.transform).y).toBeGreaterThan(-0.01);
        }
      }
    } finally { physics.dispose(); }
  }, 30_000);
});
