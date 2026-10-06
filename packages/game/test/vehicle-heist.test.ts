import { describe, expect, it } from 'vitest';
import { v3 } from '@tvox/core';
import { DEFAULT_INPUT, Heist, Profile, VehicleSpawnDef, cameraUnderwater, portLevel } from '@tvox/game';
import { addRoad, addWater } from './helpers/vehicle-world.js';

function heist(vehicles: VehicleSpawnDef[], sea = false): Heist {
  const level = { ...portLevel, vehicles, gates: [], cranes: [], triggers: [], pursuit: [],
    mission: { ...portLevel.mission, targets: [] },
    build(sim: Parameters<typeof portLevel.build>[0]) {
      return sea ? [addWater(sim, v3(-20, -10, -30), v3(40, 10, 60))] : [addRoad(sim)];
    },
  };
  const h = new Heist({ level, profile: new Profile(), sandbox: true });
  h.start();
  return h;
}

describe('транспорт в общей симуляции', () => {
  it('припаркованная машина получает удар и продолжает движение без водителя', () => {
    const h = heist([{ id: 'driver', kind: 'car', position: v3(0, 0.1, 0) },
      { id: 'parked', kind: 'car', position: v3(0, 0.1, -4) }]);
    const moving = h.vehicles.get('driver')!, parked = h.vehicles.get('parked')!;
    h.character.teleport(moving.position);
    expect(h.toggleVehicle()).toBe('driver');
    moving.speed = 15;
    for (let i = 0; i < 30; i++) h.update(1 / 60, DEFAULT_INPUT, { throttle: 1, steer: 0, brake: false, blade: false });
    expect(parked.position.z).toBeLessThan(-5);
    expect(parked.body.transform.position.z).toBeCloseTo(parked.position.z, 5);
    expect(parked.hullIntegrity).toBeLessThan(1);
    expect(h.driving).toBe(moving);
    h.sim.dispose();
  });

  it('припаркованная и разбитая машина падает после удаления опоры', () => {
    const h = heist([{ id: 'parked', kind: 'car', position: v3(0, 0.1, 0) }]);
    const car = h.vehicles.get('parked')!;
    car.wrecked = true;
    const floor = [...h.sim.world.bodies.values()].find(body => body.name === 'road')!;
    h.sim.world.removeBody(floor);
    for (let i = 0; i < 60; i++) h.update(1 / 60);
    expect(car.position.y).toBeLessThan(-3);
    expect(h.driving).toBeNull();
    h.sim.dispose();
  });

  it('после посадки из воды камера в катере не включает синий подводный туман', () => {
    const h = heist([{ id: 'boat', kind: 'boat', position: v3(0, 0, 0) }], true);
    h.character.teleport(v3(0, -0.2, 2.8));
    h.update(1 / 60);
    expect(h.character.inWater).toBe(true);
    expect(h.toggleVehicle()).toBe('boat');
    for (let i = 0; i < 30; i++) h.update(1 / 60, DEFAULT_INPUT,
      { throttle: 1, steer: 0, brake: false, blade: false });
    expect(h.driving?.spec.kind).toBe('boat');
    expect(cameraUnderwater(h.sim.world, h.eye)).toBe(false);
    expect(h.eye.y).toBeGreaterThan(1);
    h.sim.dispose();
  });
});
