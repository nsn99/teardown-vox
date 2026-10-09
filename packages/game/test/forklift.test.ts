import { expect, it } from 'vitest';
import { Body, Mat, RapierPhysics, VoxelShape, bodySolidBounds, transformPoint, v3 } from '@tvox/core';
import { Vehicle, NEUTRAL_INPUT } from '@tvox/game';
import { roadSim } from './helpers/vehicle-world.js';

function fixture(mat = Mat.Wood, size = 8) {
  const sim = roadSim(), vehicle = new Vehicle('forklift', { position: v3(0, .02, 0) }); vehicle.spawn(sim);
  const shape = new VoxelShape({ sx: size, sy: size, sz: size, voxelSize: .1, grounded: false }); shape.fill({}, mat);
  const load = sim.world.addBody(new Body({ kind: 'dynamic', shapes: [shape], tags: ['cargo'], name: 'Груз',
    transform: { position: transformPoint(vehicle.body.transform, v3(.7, .21, -.4)), rotation: vehicle.orientation } }));
  return { sim, vehicle, lift: vehicle.forklift!, load };
}

it('вилы подхватывают ящик, поднимают, перевозят и отпускают его в физику', async () => {
  const f = fixture(); f.sim.setPhysics(await RapierPhysics.create(f.sim.world));
  try {
    expect(f.lift.toggle(f.sim)).toBe('attached');
    const y = f.load.transform.position.y;
    for (let i = 0; i < 60; i++) f.vehicle.update(f.sim, { ...NEUTRAL_INPUT, bladeLift: 1 }, 1 / 60);
    expect(f.load.transform.position.y).toBeGreaterThan(y + .5);
    const z = f.load.transform.position.z;
    for (let i = 0; i < 60; i++) f.vehicle.update(f.sim, { ...NEUTRAL_INPUT, throttle: .5 }, 1 / 60);
    expect(f.load.transform.position.z).toBeLessThan(z - .5);
    expect(f.lift.toggle(f.sim)).toBe('released'); expect(f.load.kinematic).toBe(false);
    const before = bodySolidBounds(f.load).min.y;
    for (let i = 0; i < 90; i++) f.sim.physics.step(1 / 60);
    expect(bodySolidBounds(f.load).min.y).toBeLessThanOrEqual(before + .03);
  } finally { f.sim.dispose(); }
});

it('поднимает сейф массой до 5 тонн и отказывает перегрузу', () => {
  const f = fixture(Mat.Metal, 8);
  try { expect(f.lift.toggle(f.sim)).toBe('attached'); } finally { f.sim.dispose(); }
  const heavy = fixture(Mat.HeavyMetal, 12);
  try { expect(heavy.lift.toggle(heavy.sim)).toBe('heavy'); } finally { heavy.sim.dispose(); }
});

it('груз не проходит через потолок и падает при разрушении мачты', () => {
  const f = fixture();
  try {
    expect(f.lift.toggle(f.sim)).toBe('attached');
    const roof = new VoxelShape({ sx: 50, sy: 2, sz: 50, voxelSize: .1 }); roof.fill({}, Mat.Concrete);
    roof.transform.position = v3(-2.5, 1.4, -3); f.sim.world.addBody(new Body({ shapes: [roof] }));
    for (let i = 0; i < 120; i++) f.lift.update(f.sim, 1, 1 / 60, false);
    expect(bodySolidBounds(f.load).max.y).toBeLessThanOrEqual(1.4);
    f.vehicle.body.shapes[0].set(27, 10, 3, Mat.Air);
    f.lift.update(f.sim, 0, 1 / 60, false);
    expect(f.lift.load).toBeNull(); expect(f.load.kinematic).toBe(false);
  } finally { f.sim.dispose(); }
});
