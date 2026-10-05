import { expect, it } from 'vitest';
import { Simulation, SKY_MAX, SkyLight, explode, normalize, sub, v3 } from '@tvox/core';
import { CharacterController, portLevel } from '@tvox/game';
import { WAREHOUSE_LIGHT_PROBE } from '../../../tools/smoke/warehouse-light-probe.mjs';

it('браузерный замер смотрит на тёмный пол склада, который освещается через крышу', () => {
  const sim = new Simulation();
  try {
    portLevel.build(sim);
    const { position, yaw, pitch } = WAREHOUSE_LIGHT_PROBE;
    const character = new CharacterController({ position });
    const cp = Math.cos(pitch);
    const floor = sim.world.raycast(character.eye,
      v3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp), { maxDistance: 20 })!;
    expect(floor).not.toBeNull();
    expect(floor.shape.name).toBe('warehouse');
    expect(floor.normal.y).toBe(1);
    const sky = new SkyLight(floor.shape);
    expect(sky.at(floor.vx, floor.vy + 1, floor.vz)).toBe(0);

    const roof = sim.world.raycast(v3(floor.point.x, character.eye.y, floor.point.z),
      v3(0, 1, 0), { maxDistance: 20 })!;
    expect(roof).not.toBeNull();
    expect(roof.shape).toBe(floor.shape);
    expect(roof.point.y).toBeGreaterThan(6);
    // На пути прицела до выбранной крыши нет колонны или другого объекта.
    const aimed = sim.world.raycast(character.eye, normalize(sub(roof.point, character.eye)),
      { maxDistance: 20 })!;
    expect(aimed.shape).toBe(roof.shape);
    expect(aimed.point.y).toBeCloseTo(roof.point.y, 5);

    const result = explode(sim.world, { center: aimed.point, radius: 3, power: 1.4, cause: 'light-probe' });
    expect(result.removed).toBeGreaterThan(0);
    const changed = result.touched.find(t => t.shape === floor.shape)!;
    sky.rebuild(changed.region);
    expect(sky.at(floor.vx, floor.vy + 1, floor.vz)).toBe(SKY_MAX);
    expect(sim.world.raycast(v3(floor.point.x, character.eye.y, floor.point.z),
      v3(0, 1, 0), { maxDistance: 20 })).toBeNull();
  } finally { sim.dispose(); }
});
