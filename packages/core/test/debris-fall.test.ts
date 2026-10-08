import { describe, expect, it } from 'vitest';
import { Body, Mat, RapierPhysics, Simulation, VoxelShape, VoxelWorld, capDebris, stepStructure, v3 } from '@tvox/core';

function solid(world: VoxelWorld, position: ReturnType<typeof v3>, size: ReturnType<typeof v3>, dynamic = false) {
  const shape = new VoxelShape({ sx: size.x, sy: size.y, sz: size.z, voxelSize: 0.1 });
  shape.fill({}, Mat.Concrete); shape.structural = false; shape.transform.position = position;
  return world.addBody(new Body({ kind: dynamic ? 'dynamic' : 'static', shapes: [shape], tags: dynamic ? ['debris'] : [] }));
}

describe('отделившиеся части действительно падают', () => {
  it('ограничитель не замораживает новый обломок с нулевой скоростью в воздухе', () => {
    const world = new VoxelWorld();
    const piece = solid(world, v3(40, 5, 0), v3(4, 4, 4), true);
    expect(capDebris(world, { maxActive: 0, keepWithin: 0 }).frozen).toBe(0);
    expect(piece.kind).toBe('dynamic'); expect(piece.destroyed).toBe(false);
  });

  it('исчезнувшая опора будит уснувший обломок в Rapier', async () => {
    const world = new VoxelWorld();
    solid(world, v3(-2, -0.4, -2), v3(40, 4, 40));
    const support = solid(world, v3(0, 0, 0), v3(8, 25, 8));
    const piece = solid(world, v3(0.1, 2.5, 0.1), v3(4, 4, 4), true);
    const physics = await RapierPhysics.create(world, { impactThreshold: Infinity });
    try {
      for (let i = 0; i < 300; i++) physics.step(1 / 60);
      expect(piece.sleeping).toBe(true);
      support.shapes[0].fill({}, Mat.Air); support.collidersDirty = true;
      for (let i = 0; i < 90; i++) physics.step(1 / 60);
      expect(piece.shapes[0].voxelCenterWorld(0, 0, 0, piece.transform).y).toBeLessThan(0.15);
    } finally { physics.dispose(); }
  });

  it('крупная тонкая плита ложится видимой геометрией на пол, без воздушного зазора от грубой сетки', async () => {
    const world = new VoxelWorld();
    solid(world, v3(-2, -0.4, -2), v3(160, 4, 160));
    const shape = new VoxelShape({ sx: 120, sy: 4, sz: 120, voxelSize: 0.1 });
    shape.fill({ y0: 1, y1: 3 }, Mat.Concrete); shape.structural = false;
    const piece = world.addBody(new Body({ kind: 'dynamic', shapes: [shape], tags: ['debris'],
      transform: { position: v3(0, 4, 0), rotation: { x: 0, y: 0, z: 0, w: 1 } } }));
    const physics = await RapierPhysics.create(world, { impactThreshold: Infinity });
    try {
      for (let i = 0; i < 240; i++) physics.step(1 / 60);
      const point = shape.voxelCenterWorld(60, 1, 60, piece.transform);
      expect(point.y).toBeGreaterThan(0.025); expect(point.y).toBeLessThan(0.08);
    } finally { physics.dispose(); }
  });

  it('небольшое отделение сразу убирает родительские коллайдеры даже при очереди и бюджете в один чанк', async () => {
    const sim = new Simulation({ structure: { stress: false, timeBudgetMs: 0 } });
    solid(sim.world, v3(-2, -0.4, -2), v3(160, 4, 40));
    const shape = new VoxelShape({ sx: 128, sy: 40, sz: 4, voxelSize: 0.1, grounded: true });
    shape.fill({ x1: 96 }, Mat.Concrete);
    shape.fill({ x0: 110, x1: 114, y1: 24 }, Mat.Concrete);
    const parent = sim.world.addBody(new Body({ shapes: [shape] }));
    const physics = await RapierPhysics.create(sim.world, { rebuildBudget: 1, impactThreshold: Infinity });
    sim.setPhysics(physics);
    try {
      physics.step(1 / 60);
      // Чанки большой стены уже стоят в очереди перед маленькой колонной.
      for (const x of [0, 34, 68]) shape.set(x, 30, 0, Mat.Air);
      shape.fill({ x0: 110, x1: 114, y0: 4, y1: 6 }, Mat.Air); parent.collidersDirty = true;
      const pieces = stepStructure(sim.world, { stress: false, timeBudgetMs: 0 }).fragments;
      expect(pieces).toHaveLength(1);
      const piece = pieces[0].body;
      physics.step(1 / 60);
      expect(piece.velocity.y).toBeLessThan(-0.1);
    } finally { physics.dispose(); }
  });
});
