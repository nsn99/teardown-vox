import { describe, expect, it } from 'vitest';
import { Mat, carve, quatFromEulerYXZ, v3 } from '@tvox/core';
import { makeShape, voxelCenter, worldWith } from './helpers.js';

describe('физические обломки вырезанного материала', () => {
  it('сохраняет материал, окраску и мировые координаты повёрнутой формы', () => {
    const s = makeShape(8, 4, 4);
    s.fill({}, Mat.Brick);
    s.paint.set(s.idx(5, 2, 1), 0x123456);
    s.transform.position = v3(2, 1, -3);
    s.transform.rotation = quatFromEulerYXZ(0.4, 0.2);
    const { world, body } = worldWith(s);
    body.transform.position = v3(7, 3, 2);
    body.transform.rotation = quatFromEulerYXZ(-0.7, 0.1);
    const point = s.voxelCenterWorld(5, 2, 1, body.transform);
    const before = world.totalSolidVoxels();
    const hit = carve(world, { kind: 'sphere', center: point, radius: 0.15 }, {
      power: 1, damage: 0, instant: true, falloff: 'none',
      physicalDebris: { velocity: v3(3, 2, -4) },
    });
    expect(hit.removed).toBeGreaterThan(0);
    expect(world.totalSolidVoxels()).toBe(before);
    expect(hit.fragments.reduce((n, b) => n + b.solidVoxels, 0)).toBe(hit.removed);
    const painted = hit.fragments.flatMap(b => b.shapes.map(shape => ({ b, shape })))
      .find(({ shape }) => shape.paint.size > 0)!;
    const index = [...painted.shape.paint.keys()][0];
    const coords = { x: 0, y: 0, z: 0 };
    painted.shape.coords(index, coords);
    const actual = painted.shape.voxelCenterWorld(coords.x, coords.y, coords.z, painted.b.transform);
    expect(actual.x).toBeCloseTo(point.x, 10);
    expect(actual.y).toBeCloseTo(point.y, 10);
    expect(actual.z).toBeCloseTo(point.z, 10);
    expect(painted.shape.paint.get(index)).toBe(0x123456);
    expect(painted.b.velocity).toEqual(v3(3, 2, -4));
  });

  it('ограничивает новые тела за удар, не сохраняет листву и соблюдает бюджет', () => {
    const s = makeShape(32, 32, 8);
    s.fill({}, Mat.Brick);
    const { world } = worldWith(s);
    const hit = carve(world, { kind: 'sphere', center: voxelCenter(16, 16, 4), radius: 10 }, {
      power: 1, damage: 0, instant: true, falloff: 'none', maxVoxels: 5000,
      physicalDebris: { velocity: v3() },
    });
    expect(hit.removed).toBe(5000);
    expect(hit.fragments).toHaveLength(32);
    expect(hit.fragments.every(b => b.solidVoxels <= 64)).toBe(true);
    expect(hit.fragments.reduce((n, b) => n + b.solidVoxels, 0)).toBeLessThan(hit.removed);

    const leaves = makeShape(4, 4, 4);
    leaves.fill({}, Mat.Foliage);
    const leafy = worldWith(leaves).world;
    const leafHit = carve(leafy, { kind: 'sphere', center: v3(), radius: 2 }, {
      power: 1, damage: 999, physicalDebris: { velocity: v3() },
    });
    expect(leafHit.removed).toBe(64);
    expect(leafHit.fragments).toEqual([]);
    expect(leafHit.debris).toEqual([]);
  });
});
