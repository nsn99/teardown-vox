import { expect, it } from 'vitest';
import { Mat, Simulation, add, normalize, scale, sub, v3 } from '@tvox/core';
import { Inventory, portLevel, useTool } from '@tvox/game';

it('настил соединён с берегом, а дерево внутри зданий горит после прекращения струи', () => {
  const sim = new Simulation(); portLevel.build(sim);
  try {
    for (const x of [5, 8, 11, 13.5, 16]) for (let z = 9; z <= 10.8; z += .1) {
      const hit = sim.world.raycast(v3(x, 1, z), v3(0, -1, 0), { maxDistance: 1.1, filter: m => m !== Mat.Water });
      expect(hit, `разрыв причала: ${x},${z}`).not.toBeNull();
      expect(hit!.point.y).toBeGreaterThanOrEqual(-.001);
    }
    for (const name of ['Деревянный ящик в складе', 'Стол в офисе']) {
      const body = [...sim.world.bodies.values()].find(b => b.name === name)!;
      const shape = body.shapes[0], index = shape.data.indexOf(Mat.Wood), c = shape.coords(index);
      const point = shape.voxelCenterWorld(c.x, c.y, c.z, body.transform);
      const origin = add(point, v3(0, 0, -.8)), direction = normalize(sub(point, origin));
      const inventory = new Inventory({ active: 'flamethrower' });
      for (let i = 0; i < 25; i++) {
        useTool({ sim, inventory, origin, direction }); inventory.tick(.05); sim.fire.step(sim.world, .05);
      }
      expect(sim.fire.burningOn(body)).toBeGreaterThan(0);
      sim.fire.step(sim.world, 1); expect(sim.fire.burningOn(body)).toBeGreaterThan(0);
      // Foam must remain a countermeasure to the stronger flame.
      sim.fire.extinguishAlong(sim.world, origin, add(point, scale(direction, .3)), 1, 4);
      expect(sim.fire.burningOn(body)).toBe(0);
    }
  } finally { sim.dispose(); }
}, 60_000);
