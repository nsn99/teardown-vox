import { expect, it } from 'vitest';
import { Body, Mat, RapierPhysics, Simulation, VoxelShape, stepStructure, v3 } from '@tvox/core';

it.each(['vehicle', 'gate', 'crane'])('оторванное стекло %s падает, край в раме остаётся', async tag => {
  const sim = new Simulation();
  const glass = new VoxelShape({ sx: 12, sy: 12, sz: 1, voxelSize: .1, grounded: false });
  glass.fill({}, Mat.Glass); glass.fill({ x0: 0, x1: 1 }, Mat.Metal);
  const body = sim.world.addBody(new Body({ kind: 'dynamic', kinematic: true, tags: [tag], shapes: [glass],
    transform: { position: v3(0, 3, 0), rotation: { x: 0, y: 0, z: 0, w: 1 } } }));
  stepStructure(sim.world, { timeBudgetMs: 0 });
  expect(sim.world.bodies.size).toBe(1);
  glass.fill({ x0: 3, x1: 4 }, Mat.Air);
  const result = stepStructure(sim.world, { timeBudgetMs: 0 });
  expect(result.fragments).toHaveLength(1);
  const shard = result.fragments[0].body;
  expect(shard.tags.has(tag)).toBe(false); expect(shard.kinematic).toBe(false);
  expect(glass.get(2, 5, 0)).toBe(Mat.Glass);
  expect(glass.get(5, 5, 0)).toBe(Mat.Air);
  sim.setPhysics(await RapierPhysics.create(sim.world));
  try {
    for (let i = 0; i < 30; i++) sim.physics.step(1 / 60);
    expect(shard.transform.position.y).toBeLessThan(2);
    expect(body.transform.position.y).toBe(3);
  } finally { sim.dispose(); }
});
