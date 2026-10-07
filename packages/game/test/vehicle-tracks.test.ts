import { describe, expect, it } from 'vitest';
import { NEUTRAL_INPUT, Vehicle } from '@tvox/game';
import { roadSim } from './helpers/vehicle-world.js';

describe('движение гусениц', () => {
  it.each(['bulldozer', 'excavator'] as const)('%s двигает обе ленты вместе с пройденным расстоянием, включая задний ход', kind => {
    const sim = roadSim(); const vehicle = new Vehicle(kind, { position: { x: 0, y: 0.1, z: 0 }, waterLevel: -10 }); vehicle.spawn(sim);
    vehicle.speed = 2; vehicle.update(sim, { ...NEUTRAL_INPUT, throttle: 0.4 }, 0.1);
    expect(vehicle.tracks).toHaveLength(2); expect(vehicle.tracks[0].travel).toBeCloseTo(-vehicle.position.z, 5);
    expect(vehicle.tracks[1].travel).toBeCloseTo(vehicle.tracks[0].travel, 5);
    const before = vehicle.tracks[0].travel; vehicle.speed = -2;
    vehicle.update(sim, { ...NEUTRAL_INPUT, throttle: -0.5 }, 0.1); expect(vehicle.tracks[0].travel).toBeLessThan(before);
    vehicle.speed = 0; const stopped = vehicle.tracks[0].travel;
    vehicle.update(sim, NEUTRAL_INPUT, 0.1); expect(vehicle.tracks[0].travel).toBe(stopped);
  });
  it('разворачивается на месте: левая и правая ленты движутся в разные стороны', () => {
    const sim = roadSim(); const v = new Vehicle('bulldozer', { position: { x: 0, y: 0.1, z: 0 }, waterLevel: -10 }); v.spawn(sim);
    for (let i = 0; i < 60; i++) v.update(sim, { ...NEUTRAL_INPUT, steer: 1 }, 1 / 60);
    expect(v.yaw).toBeLessThan(-0.3); expect(v.position.x).toBe(0); expect(v.position.z).toBe(0);
    expect(v.tracks[0].travel).toBeGreaterThan(0); expect(v.tracks[1].travel).toBeLessThan(0);
    expect(v.body.collidersDirty).toBe(false);
  });
});
