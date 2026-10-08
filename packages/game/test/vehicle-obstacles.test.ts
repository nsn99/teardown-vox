import { describe, expect, it } from 'vitest';
import { Body, Mat, Simulation, VoxelShape, inverseTransformPoint, v3 } from '@tvox/core';
import { NEUTRAL_INPUT, Vehicle } from '@tvox/game';
import { addRoad } from './helpers/vehicle-world.js';

function occupiedOverlap(vehicle: Vehicle, obstacle: Body): number {
  let overlaps = 0;
  for (const shape of obstacle.shapes) for (let i = 0; i < shape.volume; i++) {
    if (shape.data[i] === Mat.Air) continue;
    const c = shape.coords(i);
    const world = shape.voxelCenterWorld(c.x, c.y, c.z, obstacle.transform);
    const local = inverseTransformPoint(vehicle.body.transform, world);
    if (vehicle.body.shapes.some(hull => {
      const p = inverseTransformPoint(hull.transform, local);
      return hull.get(Math.floor(p.x / hull.voxelSize), Math.floor(p.y / hull.voxelSize),
        Math.floor(p.z / hull.voxelSize)) !== Mat.Air;
    })) overlaps++;
  }
  return overlaps;
}

describe('кабина и борта сталкиваются с геометрией склада', () => {
  it('бульдозер не поворачивает кабину сквозь оставшуюся верхнюю часть колонны', () => {
    const sim = new Simulation(); addRoad(sim);
    const column = new VoxelShape({ sx: 4, sy: 20, sz: 4, voxelSize: 0.1 });
    column.fill({}, Mat.Concrete); column.structural = false;
    column.transform.position = v3(0.86, 1.4, 1.65);
    const obstacle = sim.world.addBody(new Body({ shapes: [column] }));
    const vehicle = new Vehicle('bulldozer', { position: v3(0, 0.02, 0), waterLevel: -10 });
    vehicle.spawn(sim);
    expect(occupiedOverlap(vehicle, obstacle)).toBe(0);
    for (let i = 0; i < 180; i++) {
      vehicle.update(sim, { ...NEUTRAL_INPUT, steer: -1 }, 1 / 60);
      expect(occupiedOverlap(vehicle, obstacle)).toBe(0);
    }
    expect(vehicle.yaw).toBeGreaterThan(0.01);
    expect(vehicle.yaw).toBeLessThan(0.7);
  });
});
