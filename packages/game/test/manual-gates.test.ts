import { expect, it } from 'vitest';
import { Body, Mat, Simulation, VoxelShape, v3 } from '@tvox/core';
import { AutomaticGate } from '@tvox/game';

it('створку нужно схватить и потянуть; после отпускания она остаётся на месте', () => {
  const sim = new Simulation();
  const shape = new VoxelShape({ sx: 10, sy: 20, sz: 1, voxelSize: .1 }); shape.fill({}, Mat.Metal);
  sim.world.addBody(new Body({ name: 'door', kind: 'dynamic', kinematic: true, shapes: [shape] }));
  const gate = new AutomaticGate(sim, { id: 'door', body: 'door', rise: 1.2, speed: 2,
    manual: true, axis: 'x', approachRadius: 4, closeDelay: 1 });
  const visitor = { min: v3(0, 0, -1), max: v3(.4, 1.8, -.5) };
  try {
    gate.update(visitor, 2); expect(gate.opening).toBe(0);
    expect(gate.grab(v3(.5, 1, -1), v3(0, 0, 1), v3(.5, 1, 0))).toBe(true);
    gate.pull(v3(1.7, 1, -1), v3(0, 0, 1)); gate.update(visitor, 1);
    expect(gate.opening).toBeCloseTo(1);
    gate.release(); gate.update(visitor, 10); expect(gate.opening).toBeCloseTo(1);
    const obstacle = new VoxelShape({ sx: 1, sy: 20, sz: 3, voxelSize: .1 }); obstacle.fill({}, Mat.Wood);
    obstacle.transform.position = v3(1, 0, -.1); sim.world.addBody(new Body({ shapes: [obstacle] }));
    gate.grab(v3(1.7, 1, -1), v3(0, 0, 1), v3(1.7, 1, 0));
    gate.pull(v3(.5, 1, -1), v3(0, 0, 1)); gate.update(visitor, 1);
    expect(gate.body.aabb().min.x).toBeGreaterThanOrEqual(1.099);
    expect(obstacle.solidVoxels).toBe(60);
  } finally { sim.dispose(); }
});
