import { expect, it } from 'vitest';
import { RapierPhysics, inverseTransformPoint, transformPoint, v3, Mat } from '@tvox/core';
import { Heist, NEUTRAL_INPUT, portLevel } from '@tvox/game';

it('сейф с вил опускается на корму, закрепляется, плывёт и освобождается', async () => {
  const h = new Heist({ level: portLevel, sandbox: true }); h.start();
  h.sim.setPhysics(await RapierPhysics.create(h.sim.world));
  try {
    const boat = h.vehicles.get('boat')!, lift = h.vehicles.get('forklift')!;
    const safe = [...h.sim.world.bodies.values()].find(b => b.tags.has('target:safe'))!;
    lift.position = v3(10.8, .42, .95); lift.update(h.sim, NEUTRAL_INPUT, 1 / 60);
    safe.transform = { position: transformPoint(lift.body.transform, v3(1.7, .21, 0)), rotation: boat.orientation };
    safe.velocity = v3(); h.sim.physics.sync(safe);
    expect(lift.forklift!.toggle(h.sim)).toBe('attached');
    expect(boat.deck!.toggle(h.sim)).toBe('empty'); // Cannot steal a load from the forks.
    expect(lift.forklift!.toggle(h.sim)).toBe('released');
    for (let i = 0; i < 100; i++) {
      lift.update(h.sim, { ...NEUTRAL_INPUT, throttle: -.25 }, 1 / 60);
      boat.update(h.sim, NEUTRAL_INPUT, 1 / 60); h.sim.physics.step(1 / 60);
    }
    expect(lift.position.z).toBeGreaterThan(2);
    expect(inverseTransformPoint(boat.body.transform, safe.transform.position).y).toBeCloseTo(.8, 1);
    expect(boat.deck!.toggle(h.sim)).toBe('secured');
    const local = inverseTransformPoint(boat.body.transform, safe.transform.position);
    const before = { ...boat.position };
    for (let i = 0; i < 100; i++) {
      boat.update(h.sim, { ...NEUTRAL_INPUT, throttle: .3, steer: .5 }, 1 / 60); h.sim.physics.step(1 / 60);
    }
    expect(Math.hypot(boat.position.x - before.x, boat.position.z - before.z)).toBeGreaterThan(2);
    expect(inverseTransformPoint(boat.body.transform, safe.transform.position).x).toBeCloseTo(local.x, 4);
    expect(safe.kinematic).toBe(true);
    boat.deck!.release(h.sim); expect(safe.kinematic).toBe(false);
    expect(Math.hypot(safe.velocity.x, safe.velocity.z)).toBeGreaterThan(1);
    boat.speed = 0; boat.body.velocity = v3(); safe.velocity = v3();
    expect(boat.deck!.toggle(h.sim)).toBe('secured');
    boat.body.shapes[0].fill({ x0: 1, x1: 18, y0: 0, y1: 8, z0: 0, z1: 22 }, Mat.Air);
    boat.deck!.update(h.sim, false); expect(safe.kinematic).toBe(false);
  } finally { h.sim.dispose(); }
}, 30_000);
