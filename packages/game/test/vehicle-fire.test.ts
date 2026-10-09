import { expect, it } from 'vitest';
import { Mat, add, normalize, rotateVec, scale, sub, v3 } from '@tvox/core';
import { Inventory, NEUTRAL_INPUT, VEHICLES, Vehicle, VehicleKind, useTool } from '@tvox/game';
import { roadSim } from './helpers/vehicle-world.js';

it.each(Object.keys(VEHICLES) as VehicleKind[])('%s загорается от струи и продолжает гореть без неё', kind => {
  const sim = roadSim(), vehicle = new Vehicle(kind, { position: v3(0, .1, 0), waterLevel: -10 });
  vehicle.spawn(sim);
  const inventory = new Inventory({ active: 'flamethrower' });
  const shape = vehicle.body.shapes[0], index = shape.data.indexOf(Mat.Fuel), c = shape.coords(index);
  const point = shape.voxelCenterWorld(c.x, c.y, c.z, vehicle.body.transform);
  const outward = rotateVec(vehicle.orientation, v3(0, 0, -1));
  const origin = add(point, scale(outward, 2)), direction = normalize(sub(point, origin));
  try {
    for (let i = 0; i < 20; i++) {
      useTool({ sim, inventory, origin, direction }); inventory.tick(.05); sim.fire.step(sim.world, .05);
    }
    expect(sim.fire.burningOn(vehicle.body)).toBeGreaterThan(0);
    sim.fire.step(sim.world, 1); expect(sim.fire.burningOn(vehicle.body)).toBeGreaterThan(0);
    for (let i = 0; i < 1200; i++) vehicle.update(sim, NEUTRAL_INPUT, 1 / 60);
    expect(vehicle.wrecked).toBe(true);
  } finally { sim.dispose(); }
});
