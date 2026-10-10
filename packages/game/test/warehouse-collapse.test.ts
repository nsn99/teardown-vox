import { describe, expect, it } from 'vitest';
import { Body, Mat, RapierPhysics, Simulation, carve, transformPoint, v3 } from '@tvox/core';
import { AutomaticGate, portLevel } from '@tvox/game';

/** Высота настоящих вокселей крыши: AABB разреженной формы слишком велик. */
function highRoof(bodies: Body[]): number {
  let count = 0;
  for (const body of bodies) for (const shape of body.shapes) {
    for (let i = 0; i < shape.data.length; i++) {
      if (shape.data[i] !== Mat.Metal && shape.data[i] !== Mat.HeavyMetal) continue;
      const c = shape.coords(i);
      const p = transformPoint(body.transform, transformPoint(shape.transform,
        v3((c.x + 0.5) * shape.voxelSize, (c.y + 0.5) * shape.voxelSize, (c.z + 0.5) * shape.voxelSize)));
      if (p.y > 5) count++;
    }
  }
  return count;
}

describe('падение склада после удаления всех опор', () => {
  it('удар разбивает оболочку и опускает крышу в завал', async () => {
    const sim = new Simulation({ structure: { timeBudgetMs: 0 }, structureEveryNSteps: 1, structureBudgetMs: 0 });
    try {
      portLevel.build(sim);
      const gates = portLevel.gates!.map(def => new AutomaticGate(sim, def));
      sim.setPhysics(await RapierPhysics.create(sim.world));
      sim.settle();
      sim.physics.step(1 / 60);
      // Разрез через все наружные стены, внутренние колонны и раму ворот.
      carve(sim.world, {
        kind: 'box', center: v3(16, 1, 22), halfExtents: v3(10.6, 0.4, 8.6),
      }, { power: 2, damage: 0, instant: true, falloff: 'none', cause: 'test-support-cut' });
      const detached = sim.settle().fragments.filter(f => f.body.shapes.some(s => s.name.startsWith('warehouse:frag')));
      expect(detached.length).toBeGreaterThan(0);
      const shell = detached.reduce((a, b) => a.voxels > b.voxels ? a : b).body;
      const before = shell.solidVoxels;
      const roofBefore = highRoof([shell]);
      const far = { min: v3(50, 0.1, 50), max: v3(51, 2, 51) };
      // Скатная крыша осыпается последовательно: после 7 секунд часть
      // обломков ещё движется. Наблюдаем 12 секунд физического времени,
      // включая вторичные падения, сохраняя прежние требования к завалу.
      for (let i = 0; i < 720; i++) {
        for (const gate of gates) gate.update(far, 1 / 60);
        sim.step(1 / 60);
      }
      const pieces = [...sim.world.bodies.values()].filter(b => b.shapes.some(s => s.name.startsWith('warehouse:frag')));
      expect(Math.max(...pieces.map(b => b.solidVoxels))).toBeLessThan(before * 0.5);
      expect(pieces.filter(b => b.solidVoxels > 1000).length).toBeGreaterThanOrEqual(4);
      // Простое деление оболочки на вертикальные плитки ещё не обрушение.
      expect(highRoof(pieces)).toBeLessThan(roofBefore * 0.25);
      expect(gates[0].body.kinematic).toBe(false);
    } finally { sim.dispose(); }
  }, 120_000);
});
