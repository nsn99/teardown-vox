import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Mat, Simulation, v3 } from '@tvox/core';
import { NEUTRAL_INPUT, Vehicle, VehicleKind, portLevel } from '@tvox/game';
import { overlapsMaterial, overlapsSolid } from '../src/character.js';

const land: VehicleKind[] = ['car', 'pickup', 'bulldozer', 'excavator', 'truck'];
let sim: Simulation;

function parkVehicles(): Vehicle[] {
  return portLevel.vehicles.map(spawn => {
    const vehicle = new Vehicle(spawn.kind, {
      position: spawn.position, yaw: spawn.yaw, waterLevel: portLevel.waterLevel,
    });
    vehicle.spawn(sim);
    return vehicle;
  });
}

/** Проверяем весь габарит машины и опору, а не только маленький щуп. */
function expectFree(vehicle: Vehicle): void {
  const box = vehicle.body.aabb();
  vehicle.body.destroyed = true;
  try {
    expect(overlapsSolid(sim.world, box), `${vehicle.spec.kind}: препятствие в габарите`).toBe(false);
    for (const x of [box.min.x, box.max.x]) for (const z of [box.min.z, box.max.z]) {
      if (vehicle.spec.aquatic) {
        expect(overlapsMaterial(sim.world, {
          min: v3(x - 0.01, portLevel.waterLevel - 0.05, z - 0.01),
          max: v3(x + 0.01, portLevel.waterLevel - 0.01, z + 0.01),
        }, Mat.Water), `катер: нет воды под (${x}, ${z})`).toBe(true);
      } else {
        const floor = sim.world.raycast(v3(x, vehicle.position.y + 0.05, z), v3(0, -1, 0), { maxDistance: 1 });
        expect(floor, `${vehicle.spec.kind}: нет покрытия под (${x}, ${z})`).not.toBeNull();
        expect(floor!.normal.y).toBe(1);
        expect(vehicle.position.y - floor!.point.y).toBeLessThan(0.25);
      }
    }
  } finally {
    vehicle.body.destroyed = false;
  }
}

describe('пространство для транспорта в порту', () => {
  beforeAll(() => {
    sim = new Simulation();
    portLevel.build(sim);
  }, 60_000);

  afterEach(() => {
    for (const body of [...sim.world.bodies.values()]) {
      if (body.tags.has('vehicle')) sim.world.removeBody(body);
    }
  });

  it('вся наземная техника выезжает из гаража без разрушения карты', () => {
    const vehicles = parkVehicles();
    const before = sim.world.totalSolidVoxels();
    for (const vehicle of vehicles.filter(v => !v.spec.aquatic)) {
      expectFree(vehicle);
      const start = { ...vehicle.position };
      for (let i = 0; i < 120; i++) {
        vehicle.update(sim, { ...NEUTRAL_INPUT, throttle: 1 }, 1 / 60);
        if (i % 15 === 0) expectFree(vehicle);
      }
      expectFree(vehicle);
      expect(Math.hypot(vehicle.position.x - start.x, vehicle.position.z - start.z)).toBeGreaterThan(5);
    }
    expect(sim.world.totalSolidVoxels()).toBe(before);
  });

  it.each(land)('%s делает полный круг на площадке без задевания препятствий', kind => {
    parkVehicles();
    const vehicle = new Vehicle(kind, { position: v3(48, 0.1, 12), waterLevel: portLevel.waterLevel });
    vehicle.spawn(sim);
    vehicle.speed = vehicle.spec.maxSpeed * 0.5;
    const before = sim.world.totalSolidVoxels();
    const steps = Math.ceil(Math.PI * 2 / vehicle.spec.turnRate * 60);
    for (let i = 0; i < steps; i++) {
      vehicle.update(sim, { ...NEUTRAL_INPUT, throttle: 0.5, steer: 1 }, 1 / 60);
      if (i % 15 === 0) expectFree(vehicle);
    }
    expectFree(vehicle);
    expect(Math.abs(vehicle.yaw)).toBeGreaterThanOrEqual(Math.PI * 2);
    expect(Math.hypot(vehicle.position.x - 48, vehicle.position.z - 12)).toBeLessThan(0.3);
    expect(sim.world.totalSolidVoxels()).toBe(before);
  });

  it('новый двор соединён со старым через прежние линии ограды', () => {
    for (const center of [v3(48, 1, 30), v3(40, 1, 36)]) {
      expect(overlapsSolid(sim.world, {
        min: v3(center.x - 2, 0.05, center.z - 2),
        max: v3(center.x + 2, 3, center.z + 2),
      })).toBe(false);
    }
  });

  it('катер разворачивается перед причалом, оставаясь всем корпусом над водой', () => {
    parkVehicles();
    const boat = new Vehicle('boat', { position: v3(12, portLevel.waterLevel, -25), waterLevel: portLevel.waterLevel });
    boat.spawn(sim);
    boat.speed = boat.spec.maxSpeed * 0.5;
    const steps = Math.ceil(Math.PI * 2 / boat.spec.turnRate * 60);
    for (let i = 0; i < steps; i++) {
      boat.update(sim, { ...NEUTRAL_INPUT, throttle: 0.5, steer: 1 }, 1 / 60);
      if (i % 15 === 0) expectFree(boat);
    }
    expectFree(boat);
    expect(Math.abs(boat.yaw)).toBeGreaterThanOrEqual(Math.PI * 2);
    expect(Math.hypot(boat.position.x - 12, boat.position.z + 25)).toBeLessThan(0.3);
  });
});
