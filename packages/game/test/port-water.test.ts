import { beforeAll, describe, expect, it } from 'vitest';
import { Mat, Simulation, v3 } from '@tvox/core';
import { NEUTRAL_INPUT, Vehicle, cameraUnderwater, portLevel } from '@tvox/game';

describe('акватория возле крана и расширенной площадки', () => {
  let sim: Simulation;
  beforeAll(() => { sim = new Simulation(); portLevel.build(sim); }, 30_000);

  it.each([v3(30, -0.5, -35), v3(60, -0.5, -20), v3(90, -0.5, -20), v3(-20, -0.5, -20)])(
    'за прежней границей в точке %j есть вода и морское дно', position => {
      expect(cameraUnderwater(sim.world, position)).toBe(true);
      const bed = sim.world.raycast(v3(position.x, -0.4, position.z), v3(0, -1, 0), {
        maxDistance: 3, filter: material => material !== Mat.Water,
      });
      expect(bed?.material).toBe(Mat.Foundation);
      expect(bed!.point.y).toBeCloseTo(-1.8, 5);
    });

  it('катер ходит по новой воде, при этом камера над палубой остаётся в воздухе', () => {
    const boat = new Vehicle('boat', { position: v3(60, portLevel.waterLevel, -25), waterLevel: portLevel.waterLevel });
    boat.spawn(sim);
    try {
      for (let i = 0; i < 120; i++) boat.update(sim, { ...NEUTRAL_INPUT, throttle: 1 }, 1 / 60);
      expect(boat.position.z).toBeLessThan(-30);
      expect(boat.position.y).toBeCloseTo(portLevel.waterLevel, 5);
      expect(boat.inWater).toBe(true);
      expect(cameraUnderwater(sim.world, v3(boat.position.x, boat.position.y + 1.4, boat.position.z))).toBe(false);
    } finally { sim.world.removeBody(boat.body); }
  });

  it('большая вода занимает меньше вокселей, чем старая гавань', () => {
    const quay = sim.world.raycast(v3(60, 0.1, -10), v3(0, -1, 0), { maxDistance: 3, filter: mat => mat !== Mat.Water });
    expect(quay?.material).toBe(Mat.Concrete); expect(quay!.point.y).toBeCloseTo(0, 5);
    expect(cameraUnderwater(sim.world, v3(60, -0.5, -13))).toBe(true);
    const water = [...sim.world.bodies.values()].find(body => body.tags.has('water'))!.shapes[0];
    expect(water.solidVoxels).toBeLessThan(480 * 14 * 320);
    expect(water.sx * water.voxelSize).toBeGreaterThan(200);
    expect(water.sz * water.voxelSize).toBeGreaterThan(150);
  });
});
