import { expect, it } from 'vitest';
import { Mat, Simulation, v3 } from '@tvox/core';
import { AutomaticGate, PORT_DOC, parseLevelDoc, portLevel } from '@tvox/game';
import { slideGate } from './helpers/manual-gate.js';
import { overlapsSolid } from '../src/character.js';

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
    // build() уже пометил формы как проверенные. Один settle() после
    // прогрева не пересчитывает нагрузку и может скрыть перегрузку рамы.
    const primed = sim.primeStructure();
    expect(primed.failures).toBe(0);
    expect(primed.loose).toBe(0);
    const stable = sim.settle();
    expect(stable.stressFailures).toBe(0); expect(stable.detachedVoxels).toBe(0);
  } finally { sim.dispose(); }
});

it('торцевые ворота открывают проход в склад и падают при разрушении крепления', () => {
  const sim = new Simulation();
  try {
    portLevel.build(sim);
    const gate = new AutomaticGate(sim, portLevel.gates!.find(g => g.id === 'warehouse-gable-entry')!);
    const visitor = { min: v3(3, 0.05, 21), max: v3(4, 2, 23) };
    expect(sim.world.raycast(v3(4, 1, 22), v3(1, 0, 0), { maxDistance: 2 })?.body).toBe(gate.body);
    gate.update(visitor, 1); expect(gate.opening).toBe(0);
    slideGate(gate, gate.def.rise);
    expect(gate.opening).toBe(1);
    expect(overlapsSolid(sim.world, { min: v3(4, 0.05, 20.1), max: v3(7.5, 3.9, 23.9) })).toBe(false);
    const warehouse = [...sim.world.bodies.values()].flatMap(b => b.shapes).find(s => s.name === 'warehouse')!;
    warehouse.set(2, 44, 80, Mat.Air);
    gate.update(visitor, 1 / 60);
    expect(gate.body.kinematic).toBe(false);
  } finally { sim.dispose(); }
});
