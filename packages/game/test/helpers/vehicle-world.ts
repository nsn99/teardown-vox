import { Body, Mat, Simulation, Vec3, VoxelShape, v3 } from '@tvox/core';

/** Настоящее покрытие для движения: пустой мир используется только для падения и моря. */
export function addRoad(sim: Simulation, position = v3(-20, -0.5, -120), size = v3(40, 0.5, 150)): Body {
  const shape = new VoxelShape({ sx: Math.round(size.x * 2), sy: Math.round(size.y * 2),
    sz: Math.round(size.z * 2), voxelSize: 0.5, grounded: true });
  shape.fill({}, Mat.Foundation);
  shape.structural = false;
  shape.transform.position = position;
  return sim.world.addBody(new Body({ kind: 'static', shapes: [shape], name: 'road' }));
}

export function roadSim(): Simulation {
  const sim = new Simulation();
  addRoad(sim);
  return sim;
}

export function addWater(sim: Simulation, position: Vec3, size: Vec3): Body {
  const shape = new VoxelShape({ sx: size.x, sy: size.y, sz: size.z, voxelSize: 1, grounded: true });
  shape.fill({}, Mat.Water);
  shape.structural = false;
  shape.transform.position = position;
  return sim.world.addBody(new Body({ kind: 'static', shapes: [shape], tags: ['water'], passive: true }));
}
