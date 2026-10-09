import { expect, it } from 'vitest';
import { Body, Mat, VoxelShape, v3 } from '@tvox/core';
import { NEUTRAL_INPUT, Vehicle, VehicleKind } from '@tvox/game';
import { roadSim } from './helpers/vehicle-world.js';

it.each<VehicleKind>(['car', 'pickup', 'truck', 'forklift'])('%s передаёт импульс свободному ящику без мгновенной остановки', kind => {
  const sim = roadSim(), car = new Vehicle(kind, { position: v3(0, .02, 0) }); car.spawn(sim);
  const shape = new VoxelShape({ sx: 8, sy: 8, sz: 8, voxelSize: .1, grounded: false }); shape.fill({}, Mat.Wood);
  const box = sim.world.addBody(new Body({ kind: 'dynamic', shapes: [shape],
    transform: { position: v3(-.4, .1, -car.spec.size.x * .05 - 1), rotation: { x: 0, y: 0, z: 0, w: 1 } } }));
  const before = box.solidVoxels; car.speed = 5;
  try {
    for (let i = 0; i < 30 && box.velocity.z >= -.1; i++) {
      car.update(sim, { ...NEUTRAL_INPUT, throttle: 1 }, 1 / 60); sim.physics.step(1 / 60);
    }
    expect(box.velocity.z).toBeLessThan(-.1);
    expect(car.speed).toBeGreaterThan(2);
    expect(box.solidVoxels).toBe(before);
  } finally { sim.dispose(); }
});
