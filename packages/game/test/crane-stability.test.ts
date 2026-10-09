import { expect, it } from 'vitest';
import { Mat, RapierPhysics, Simulation } from '@tvox/core';
import { NEUTRAL_CRANE_INPUT, PortCrane, portLevel } from '@tvox/game';

it('после потери двух левых стоек кран заваливается влево и отпускает все механизмы', async () => {
  const sim = new Simulation(); portLevel.build(sim);
  const crane = new PortCrane(sim, portLevel.cranes![0]);
  const shape = [...sim.world.bodies.values()].flatMap(b => b.shapes).find(s => s.name === 'crane')!;
  try {
    shape.fill({ x0: 8, x1: 24, y0: 30, y1: 34, z0: 98, z1: 114 }, Mat.Air);
    crane.update(NEUTRAL_CRANE_INPUT, 0); expect(crane.operable).toBe(true);
    shape.fill({ x0: 8, x1: 24, y0: 30, y1: 34, z0: 138, z1: 154 }, Mat.Air);
    crane.update(NEUTRAL_CRANE_INPUT, 0);
    expect(crane.operable).toBe(false); expect(crane.hoistIntact).toBe(false);
    expect([crane.house, crane.boom, crane.hook, crane.ropes].every(b => !b.kinematic)).toBe(true);
    expect(crane.house.velocity.x).toBeLessThan(0);
    expect(Math.abs(crane.house.angularVelocity.z)).toBeGreaterThan(.1);
    // Retain the actual crane and quay, remove unrelated geometry from this physics check.
    for (const body of [...sim.world.bodies.values()]) if (!body.tags.has('crane') && !body.tags.has('debris') &&
      !body.shapes.some(s => s.name === 'crane' || s.name === 'crane-transport-quay')) sim.world.removeBody(body);
    sim.setPhysics(await RapierPhysics.create(sim.world));
    for (let i = 0; i < 40; i++) sim.physics.step(1 / 60);
    expect(Math.abs(crane.house.transform.rotation.z)).toBeGreaterThan(.015);
  } finally { sim.dispose(); }
}, 60_000);
