import { expect, it } from 'vitest';
import { Body, Mat, Simulation, VoxelShape, v3 } from '@tvox/core';
import { Inventory, useTool } from '@tvox/game';

it('различает недолёт и тушение зрелого огня; струя сохраняет дерево', () => {
  const sim = new Simulation();
  const shape = new VoxelShape({ sx: 40, sy: 2, sz: 40, voxelSize: .1 });
  shape.fill({}, Mat.Wood);
  shape.transform.position = v3(-2, 0, -2);
  sim.world.addBody(new Body({ kind: 'static', shapes: [shape] }));
  sim.fire.igniteArea(sim.world, v3(0, .15, 0), 1);
  for (let i = 0; i < 240; i++) sim.fire.step(sim.world, 1 / 60);
  const inventory = new Inventory({ unlimited: true });
  inventory.select('extinguisher');
  const initial = sim.fire.burningCount;
  expect(initial).toBeGreaterThan(100);
  const before = shape.data.slice();
  const far = useTool({ sim, inventory, origin: v3(0, 8, 0), direction: v3(0, -1, 0) });
  expect(far.sprayHitSurface).toBe(false);
  expect(far.doused).toBe(0);
  inventory.tick(.1);
  const near = useTool({ sim, inventory, origin: v3(0, 1.8, 0), direction: v3(0, -1, 0) });
  expect(near.sprayHitSurface).toBe(true);
  expect(near.doused).toBeGreaterThan(100);
  expect(sim.fire.burningCount).toBeLessThan(initial);
  expect(shape.data).toEqual(before);
  sim.dispose();
});
