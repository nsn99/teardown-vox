import { describe, expect, it } from 'vitest';
import { Body, Mat, RapierPhysics, VoxelShape, inverseTransformPoint, length, quatFromEulerYXZ, transformPoint, v3 } from '@tvox/core';
import { Heist, NEUTRAL_CRANE_INPUT, NEUTRAL_INPUT, Vehicle, portLevel } from '@tvox/game';
import { roadSim } from './helpers/vehicle-world.js';

function setup(yaw = 0, material = Mat.Wood, size = 6) {
  const sim = roadSim();
  const truck = new Vehicle('truck', { position: v3(0, 0.1, 0), yaw, waterLevel: -10 }); truck.spawn(sim);
  truck.update(sim, NEUTRAL_INPUT, 1 / 60);
  const shape = new VoxelShape({ sx: size, sy: size, sz: size, voxelSize: 0.1 }); shape.fill({}, material);
  shape.transform.position = v3(-size * 0.05, 0, -size * 0.05);
  const cargo = sim.world.addBody(new Body({ kind: 'dynamic', shapes: [shape], tags: ['cargo'],
    transform: { position: transformPoint(truck.body.transform, v3(-1.7, 1.22, 0)), rotation: quatFromEulerYXZ(0, 0) } }));
  return { sim, truck, cargo };
}

describe('грузовик под кран', () => {
  it('закрепляет длинный груз, когда кран и грузовик развёрнуты под углом к мировым осям', () => {
    const { sim, truck, cargo } = setup(0.8);
    sim.world.removeBody(cargo);
    const shape = new VoxelShape({ sx: 40, sy: 10, sz: 24, voxelSize: 0.1 }); shape.fill({}, Mat.Wood);
    shape.transform.position = v3(-2, 0, -1.2);
    const load = sim.world.addBody(new Body({ kind: 'dynamic', shapes: [shape], tags: ['cargo'],
      transform: { position: transformPoint(truck.body.transform, v3(-1.7, 1.22, 0)), rotation: truck.orientation } }));
    expect(truck.deck!.toggle(sim)).toBe('secured'); expect(load.tags.has('truck-load')).toBe(true);
    const before = inverseTransformPoint(truck.body.transform, load.transform.position);
    for (let i = 0; i < 120; i++) truck.update(sim, { ...NEUTRAL_INPUT, throttle: 0.4 }, 1 / 60);
    const local = inverseTransformPoint(truck.body.transform, load.transform.position);
    expect(local.x).toBeCloseTo(before.x, 6); expect(local.y).toBeCloseTo(before.y, 6); expect(local.z).toBeCloseTo(before.z, 6);
  });
  it('настоящий кран забирает ящик со двора и опускает его в платформу грузовика', () => {
    const h = new Heist({ level: portLevel, sandbox: true }); h.start();
    try {
      const crane = h.cranes.get('port-crane')!, truck = h.vehicles.get('cargo-truck')!;
      // Drive from the garage to the marked loading position before testing the crane.
      truck.position = v3(42.8, .1, 5);
      truck.update(h.sim, NEUTRAL_INPUT, 1 / 60);
      const turnTo = (target: number) => {
        for (let i = 0; i < 200; i++) {
          const error = Math.atan2(Math.sin(target - crane.yaw), Math.cos(target - crane.yaw));
          if (Math.abs(error) < 1e-6) break;
          crane.update({ ...NEUTRAL_CRANE_INPUT, slew: -Math.sign(error) * Math.min(1, Math.abs(error) / 0.035) }, 0.1);
        }
        expect(crane.yaw).toBeCloseTo(target, 5);
      };
      for (let i = 0; i < 25; i++) crane.update({ ...NEUTRAL_CRANE_INPUT, hoist: 1 }, 0.1);
      turnTo(-11 * Math.PI / 18);
      for (let i = 0; i < 80 && crane.grip.y > 2; i++) crane.update({ ...NEUTRAL_CRANE_INPUT, hoist: -1 }, 0.1);
      expect(crane.toggleLoad()).toBe('attached');
      const cargo = crane.load!;
      for (let i = 0; i < 18; i++) crane.update({ ...NEUTRAL_CRANE_INPUT, hoist: 1 }, 0.1);
      turnTo(-Math.PI / 2);
      for (let i = 0; i < 80 && !crane.blocked; i++) crane.update({ ...NEUTRAL_CRANE_INPUT, hoist: -1 }, 0.1);
      expect(crane.blocked).toBe(true); expect(crane.toggleLoad()).toBe('released');
      cargo.velocity = v3();
      expect(truck.deck!.toggle(h.sim)).toBe('secured'); expect(cargo.tags.has('truck-load')).toBe(true);
    } finally { h.sim.dispose(); }
  }, 30_000);
  it('в порту есть грузовик с открытой платформой и шестью колёсами', () => {
    const spawn = portLevel.vehicles.find(v => v.kind === 'truck')!; expect(spawn).toBeDefined();
    const truck = new Vehicle('truck', { position: spawn.position }); const hull = truck.body.shapes[0];
    expect(truck.wheels).toHaveLength(6); expect(truck.wheels.filter(w => w.steering)).toHaveLength(2);
    expect(hull.get(35, 18, 14)).toBe(Mat.Air); expect(hull.get(35, 11, 14)).toBe(Mat.Metal);
    expect(hull.get(80, 20, 14)).toBe(Mat.Air); expect(hull.get(80, 20, 1)).toBe(Mat.Glass);
  });

  it.each([0, 1.2])('закрепляет опущенный груз и сохраняет его положение при движении и повороте, yaw=%s', yaw => {
    const { sim, truck, cargo } = setup(yaw);
    expect(truck.deck!.toggle(sim)).toBe('secured'); expect(truck.deck!.count).toBe(1); expect(cargo.kinematic).toBe(true);
    for (let i = 0; i < 120; i++) truck.update(sim, { ...NEUTRAL_INPUT, throttle: 0.3, steer: 0.35 }, 1 / 60);
    const local = inverseTransformPoint(truck.body.transform, cargo.transform.position);
    expect(local.x).toBeCloseTo(-1.7, 5); expect(local.y).toBeCloseTo(1.22, 5); expect(local.z).toBeCloseTo(0, 5);
    expect(cargo.velocity).toEqual(truck.body.velocity);
    expect(truck.deck!.toggle(sim)).toBe('moving');
    expect(truck.deck!.release(sim)).toBe(1); expect(cargo.kinematic).toBe(false); expect(length(cargo.velocity)).toBeGreaterThan(0);
  });

  it('не хватает груз с земли, за пределами платформы, с крюка или тяжелее восьми тонн', () => {
    const { sim, truck, cargo } = setup();
    cargo.transform.position.y = 0; expect(truck.deck!.toggle(sim)).toBe('empty');
    cargo.transform.position = transformPoint(truck.body.transform, v3(-1.7, 1.22, 5));
    expect(truck.deck!.toggle(sim)).toBe('empty');
    cargo.transform.position = transformPoint(truck.body.transform, v3(-1.7, 1.22, 0));
    cargo.tags.add('crane-load'); expect(truck.deck!.toggle(sim)).toBe('empty');
    const heavy = setup(0, Mat.HeavyMetal, 12); expect(heavy.truck.deck!.toggle(heavy.sim)).toBe('empty');
  });

  it('при разрушении грузовика освобождает груз; исчезнувший груз не остаётся в счётчике', () => {
    const { sim, truck, cargo } = setup(); truck.deck!.toggle(sim);
    truck.body.shapes[0].fill({}, Mat.Air); truck.update(sim, NEUTRAL_INPUT, 1 / 60);
    expect(truck.wrecked).toBe(true); expect(truck.deck!.count).toBe(0); expect(cargo.kinematic).toBe(false);
    const next = setup(); next.truck.deck!.toggle(next.sim); next.sim.world.removeBody(next.cargo);
    next.truck.update(next.sim, NEUTRAL_INPUT, 1 / 60); expect(next.truck.deck!.count).toBe(0);
    const destroyed = setup(); destroyed.truck.deck!.toggle(destroyed.sim); destroyed.truck.body.destroyed = true;
    destroyed.truck.update(destroyed.sim, NEUTRAL_INPUT, 1 / 60); expect(destroyed.cargo.kinematic).toBe(false);
  });

  it('Rapier укладывает сброшенный груз на платформу, после чего его можно закрепить и увезти', async () => {
    const { sim, truck, cargo } = setup(0.8, Mat.Wood, 12);
    cargo.transform.position.y += 1.2;
    const physics = await RapierPhysics.create(sim.world, { coarseAbove: Infinity }); sim.setPhysics(physics);
    try {
      const roadBefore = [...sim.world.bodies.values()][0].shapes[0].data.slice();
      for (let i = 0; i < 150; i++) { truck.update(sim, NEUTRAL_INPUT, 1 / 60); physics.step(1 / 60); }
      expect(cargo.transform.position.y).toBeCloseTo(truck.position.y + 1.2, 1);
      expect(truck.deck!.toggle(sim)).toBe('secured');
      const before = { ...cargo.transform.position };
      for (let i = 0; i < 90; i++) { truck.update(sim, { ...NEUTRAL_INPUT, throttle: 0.3 }, 1 / 60); physics.step(1 / 60); }
      expect(Math.hypot(cargo.transform.position.x - before.x, cargo.transform.position.z - before.z)).toBeGreaterThan(2);
      expect([...sim.world.bodies.values()][0].shapes[0].data).toEqual(roadBefore);
    } finally { physics.dispose(); }
  });
});
