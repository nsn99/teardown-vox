import { describe, expect, it } from 'vitest';
import { Body, Mat, RapierPhysics, VoxelShape, quatFromAxisAngle, quatMultiply, rotateVec, v3 } from '@tvox/core';
import { NEUTRAL_INPUT, Vehicle } from '@tvox/game';
import { roadSim } from './helpers/vehicle-world.js';

function overturned(kind: 'car' | 'bulldozer' | 'truck' = 'car') {
  const sim = roadSim();
  const vehicle = new Vehicle(kind, { position: v3(0, 0.02, 0), waterLevel: -10 }); vehicle.spawn(sim);
  vehicle.body.kinematic = false;
  vehicle.body.transform = { position: v3(0, vehicle.spec.size.y * 0.1 + 0.02, 0),
    rotation: quatMultiply(vehicle.orientation, quatFromAxisAngle(v3(1, 0, 0), Math.PI)) };
  vehicle.afterPhysics();
  return { sim, vehicle };
}

describe('возврат перевёрнутой техники на колёса', () => {
  it.each(['car', 'bulldozer', 'truck'] as const)('ставит %s на опору, сохраняет повреждение и возвращает управление', async kind => {
    const { sim, vehicle } = overturned(kind);
    const physics = await RapierPhysics.create(sim.world); sim.setPhysics(physics);
    try {
      vehicle.body.shapes[0].set(10, 5, 5, Mat.Air);
      const before = vehicle.body.solidVoxels, road = [...sim.world.bodies.values()][0].shapes[0].data.slice();
      expect(vehicle.recover(sim)).toBe('recovered');
      expect(rotateVec(vehicle.orientation, v3(0, 1, 0)).y).toBeCloseTo(1);
      expect(vehicle.position.y).toBeCloseTo(0.02, 5); expect(vehicle.body.kinematic).toBe(true);
      expect(vehicle.body.solidVoxels).toBe(before);
      vehicle.update(sim, { ...NEUTRAL_INPUT, throttle: 1 }, 0.1); physics.step(0.1);
      expect(vehicle.speed).toBeGreaterThan(0);
      expect([...sim.world.bodies.values()][0].shapes[0].data).toEqual(road);
    } finally { physics.dispose(); }
  });

  it('отказывает при движении, повреждении и занятом пространстве', () => {
    const { sim, vehicle } = overturned('bulldozer');
    vehicle.body.velocity = v3(2, 0, 0); expect(vehicle.recover(sim)).toBe('moving');
    vehicle.body.velocity = v3(); vehicle.wrecked = true; expect(vehicle.recover(sim)).toBe('broken');
    vehicle.wrecked = false;
    const wall = new VoxelShape({ sx: 20, sy: 30, sz: 20, voxelSize: 0.1 }); wall.fill({}, Mat.Concrete);
    wall.transform.position = v3(-1, 0, -1); sim.world.addBody(new Body({ shapes: [wall] }));
    expect(vehicle.recover(sim)).toBe('blocked'); expect(vehicle.body.kinematic).toBe(false);
  });

  it('не переносит исправную стоящую машину и не спасает перевёрнутую технику над пустотой', () => {
    const { sim, vehicle } = overturned();
    const road = [...sim.world.bodies.values()][0]; sim.world.removeBody(road);
    expect(vehicle.recover(sim)).toBe('blocked');
    vehicle.body.transform.rotation = quatFromAxisAngle(v3(1, 0, 0), 0);
    const before = { ...vehicle.position };
    expect(vehicle.recover(sim)).toBe('upright'); expect(vehicle.position).toEqual(before);
  });
});
