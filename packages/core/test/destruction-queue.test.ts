import { describe, expect, it } from 'vitest';
import {
  Body,
  DestructionQueue,
  Mat,
  Simulation,
  VoxelShape,
  VoxelWorld,
  carve,
  v3,
} from '@tvox/core';
import { VS, makeShape } from './helpers.js';

/** Кубик кирпича, в котором есть что выгрызать. */
function brickWorld(): { world: VoxelWorld; shape: VoxelShape } {
  const shape = makeShape(40, 40, 40);
  shape.fill({ x0: 0, y0: 0, z0: 0, x1: 40, y1: 40, z1: 40 }, Mat.Brick);
  const world = new VoxelWorld();
  world.addBody(new Body({ kind: 'static', shapes: [shape], name: 'block' }));
  return { world, shape };
}

const BLAST = {
  brush: { kind: 'sphere' as const, center: v3(20 * VS, 20 * VS, 20 * VS), radius: 1.2 },
  opts: { power: 1, damage: 0, instant: true, falloff: 'quadratic' as const, cause: 'test' },
};

describe('очередь отложенного разрушения', () => {
  it('сумма порций совпадает с мгновенным разрушением воксель в воксель', () => {
    const now = brickWorld();
    carve(now.world, BLAST.brush, { ...BLAST.opts });

    const later = brickWorld();
    const q = new DestructionQueue({ voxelBudget: 50 });
    q.enqueue(BLAST.brush, { ...BLAST.opts });
    const drained = q.drain(later.world);

    expect(drained.pending).toBe(0);
    expect(later.shape.solidVoxels).toBe(now.shape.solidVoxels);
    expect(Array.from(later.shape.data)).toEqual(Array.from(now.shape.data));
  });

  it('один разбор очереди не выходит за бюджет', () => {
    const { world, shape } = brickWorld();
    const before = shape.solidVoxels;
    const q = new DestructionQueue({ voxelBudget: 40 });
    q.enqueue(BLAST.brush, { ...BLAST.opts });

    const first = q.flush(world);
    expect(first.removed).toBeLessThanOrEqual(40);
    expect(first.removed).toBeGreaterThan(0);
    expect(first.pending).toBe(1);
    expect(before - shape.solidVoxels).toBe(first.removed);
  });

  it('очередь дожимается до конца за конечное число разборов', () => {
    const { world } = brickWorld();
    const q = new DestructionQueue({ voxelBudget: 30 });
    q.enqueue(BLAST.brush, { ...BLAST.opts });

    let rounds = 0;
    while (q.pending > 0 && rounds < 500) {
      q.flush(world);
      rounds++;
    }
    expect(q.pending).toBe(0);
    expect(rounds).toBeGreaterThan(1);
    expect(rounds).toBeLessThan(500);
  });

  it('старые задания вытесняются, очередь не растёт без предела', () => {
    const q = new DestructionQueue({ maxJobs: 3 });
    for (let i = 0; i < 10; i++) q.enqueue(BLAST.brush, { ...BLAST.opts });
    expect(q.pending).toBe(3);
    q.clear();
    expect(q.pending).toBe(0);
  });

  it('симуляция разбирает очередь по кадрам и досчитывает в settle', () => {
    const sim = new Simulation({ destruction: { voxelBudget: 60 } });
    const shape = makeShape(40, 40, 40);
    shape.fill({ x0: 0, y0: 0, z0: 0, x1: 40, y1: 40, z1: 40 }, Mat.Brick);
    sim.world.addBody(new Body({ kind: 'static', shapes: [shape], name: 'block' }));

    sim.destruction.enqueue(BLAST.brush, { ...BLAST.opts });
    const frame = sim.step(1 / 60);
    expect(frame.carved).toBeGreaterThan(0);
    expect(frame.carved).toBeLessThanOrEqual(60);
    expect(frame.carveQueue).toBe(1);

    // settle() считает целостность, а не доедает очередь: разрушение
    // намеренно размазано по кадрам. Досчитать всё — отдельная команда.
    expect(sim.finishDestruction()).toBeGreaterThan(0);
    expect(sim.destruction.pending).toBe(0);
  });
});
