import { describe, expect, it } from 'vitest';
import { Mat, rotateVec, transformPoint, v3 } from '@tvox/core';
import { NEUTRAL_INPUT, Vehicle } from '@tvox/game';
import { roadSim } from './helpers/vehicle-world.js';

describe('круглые поворачивающиеся колёса', () => {
  it.each(['car', 'pickup'] as const)('%s имеет четыре круглые шины и отдельные диски с меткой вращения', kind => {
    const vehicle = new Vehicle(kind, { position: v3() });
    expect(vehicle.wheels).toHaveLength(4);
    for (const wheel of vehicle.wheels) {
      const shape = wheel.shape;
      expect(shape.get(0, 0, 0)).toBe(Mat.Air);
      expect(shape.get(shape.sx - 1, shape.sy - 1, 0)).toBe(Mat.Air);
      expect(shape.get(Math.floor(shape.sx / 2), 0, 0)).toBe(Mat.Metal);
      expect(new Set(shape.paint.values()).size).toBeGreaterThanOrEqual(4);
      expect([...shape.paint.values()]).toContain(0x1e5bd54);
    }
  });

  it('на месте поворачивает только передние колёса, сохраняя центр оси и неподвижный кузов', () => {
    const sim = roadSim();
    const car = new Vehicle('car', { position: v3(0, 0.1, 0) });
    car.spawn(sim);
    for (let i = 0; i < 30; i++) car.update(sim, { ...NEUTRAL_INPUT, steer: 1 }, 1 / 60);
    expect(car.yaw).toBe(0);
    expect(car.wheelRotation).toBe(0);
    for (const wheel of car.wheels) {
      const axle = rotateVec(wheel.pose.rotation, v3(0, 0, 1));
      expect(Math.abs(axle.x)).toBeCloseTo(wheel.steering ? Math.sin(0.5) : 0, 5);
      const heading = rotateVec(car.orientation, rotateVec(wheel.pose.rotation, v3(1, 0, 0)));
      expect(heading.x).toBeCloseTo(wheel.steering ? Math.sin(0.5) : 0, 5);
      const s = wheel.shape;
      expect(transformPoint(wheel.pose, v3(s.sx * s.voxelSize / 2, s.sy * s.voxelSize / 2, s.sz * s.voxelSize / 2)))
        .toEqual(wheel.center);
    }
  });

  it('катится вместе с пройденным расстоянием вперёд и назад и перестаёт крутиться после остановки', () => {
    const sim = roadSim();
    const car = new Vehicle('pickup', { position: v3(0, 0.1, 0) });
    car.spawn(sim); car.speed = 2;
    const physicalPose = structuredClone(car.wheels[0].shape.transform);
    car.update(sim, { ...NEUTRAL_INPUT, throttle: 0.1 }, 0.1);
    const roll = car.wheelRotation;
    expect(roll).toBeCloseTo(-car.position.z / car.wheels[0].radius, 5);
    expect(car.wheels[0].pose.rotation).not.toEqual(physicalPose.rotation);
    expect(car.wheels[0].shape.transform).toEqual(physicalPose);
    car.speed = -2;
    car.update(sim, { ...NEUTRAL_INPUT, throttle: -0.3 }, 0.1);
    expect(car.wheelRotation).toBeLessThan(roll);
    car.speed = 0;
    const stopped = car.wheelRotation;
    car.update(sim, NEUTRAL_INPUT, 0.1);
    expect(car.wheelRotation).toBe(stopped);
  });
});
