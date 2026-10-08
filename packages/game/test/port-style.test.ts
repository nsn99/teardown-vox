import { expect, it } from 'vitest';
import { Mat, Simulation, v3 } from '@tvox/core';
import { PORT_DOC, parseLevelDoc, portLevel } from '@tvox/game';

it('кирпичный порт имеет полые скатные крыши и остаётся устойчивым при загрузке', () => {
  expect(parseLevelDoc(PORT_DOC).environment!.daylight).toBe('golden');
  const sim = new Simulation({ structure: { timeBudgetMs: 0 } });
  try {
    portLevel.build(sim);
    const shapes = [...sim.world.bodies.values()].flatMap(b => b.shapes);
    const warehouse = shapes.find(s => s.name === 'warehouse')!, office = shapes.find(s => s.name === 'office')!;
    for (const [shape, x, z] of [[warehouse, 10, 80], [office, 10, 50]] as const) {
      expect(shape.get(x, shape.sy - 3, z)).toBe(Mat.Metal);
      expect(shape.get(x, shape.sy - 3, 3)).toBe(Mat.Air);
      expect(shape.get(x, 35, 0)).toBe(Mat.Brick);
    }
    const inside = sim.world.raycast(v3(12, 3, 22), v3(0, 1, 0), { maxDistance: 20 });
    expect(inside!.shape).toBe(warehouse);
    expect(inside!.point.y).toBeGreaterThan(7);
    const stable = sim.settle();
    expect(stable.stressFailures).toBe(0); expect(stable.detachedVoxels).toBe(0);
  } finally { sim.dispose(); }
});
