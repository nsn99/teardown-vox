import { describe, expect, it } from 'vitest';
import { Body, Mat, VoxelShape, VoxelWorld, quatFromEulerYXZ, stepStructure, transformPoint, v3 } from '@tvox/core';

function voxels(world: VoxelWorld): string[] {
  const result: string[] = [];
  for (const body of world.bodies.values()) for (const shape of body.shapes) {
    for (let i = 0; i < shape.volume; i++) {
      if (shape.data[i] === Mat.Air) continue;
      const c = shape.coords(i);
      const p = transformPoint(body.transform, transformPoint(shape.transform,
        v3((c.x + 0.5) * shape.voxelSize, (c.y + 0.5) * shape.voxelSize, (c.z + 0.5) * shape.voxelSize)));
      result.push(`${p.x.toFixed(5)},${p.y.toFixed(5)},${p.z.toFixed(5)}:${shape.data[i]}:${shape.damage[i]}:${shape.paint.get(i)}`);
    }
  }
  return result.sort();
}

function plate(): { world: VoxelWorld; body: Body } {
  const world = new VoxelWorld();
  const shape = new VoxelShape({ sx: 96, sy: 4, sz: 8, voxelSize: 0.1 });
  shape.fill({}, Mat.Brick);
  shape.fill({ x0: 32, x1: 64 }, Mat.HeavyMetal);
  shape.transform.position = v3(0.2, 0.5, -0.4);
  for (let i = 0; i < shape.volume; i += 13) { shape.damage[i] = 7; shape.paint.set(i, 0x1677788); }
  const body = world.addBody(new Body({ kind: 'dynamic', tags: ['debris'], shapes: [shape],
    transform: { position: v3(10, 2, 5), rotation: quatFromEulerYXZ(0.3, 0, 0) } }));
  return { world, body };
}

describe('разрушение крупных обломков при ударе', () => {
  it('тонкая плита раскалывается по пролёту с сохранением материала, краски, урона и положения', () => {
    const { world, body } = plate();
    const before = voxels(world);
    body.fractureOnImpact = true;
    body.fracturePoint = v3(9, 0, 5);
    body.fractureSpeed = 6;
    // Плита меньше 32³ вокселей; решает длина пролёта, а не объём материала.
    const result = stepStructure(world, { minFragmentVoxels: 1, maxFragmentsPerStep: 1, timeBudgetMs: 0 });
    expect(result.fragments).toHaveLength(1);
    expect(body.fractureOnImpact).toBe(true);
    expect(voxels(world)).toEqual(before);
    for (let i = 0; i < 4; i++) stepStructure(world, { minFragmentVoxels: 1, maxFragmentsPerStep: 1, timeBudgetMs: 0 });
    expect(world.bodies.size).toBe(3);
    expect(body.fractureOnImpact).toBe(false);
    expect(voxels(world)).toEqual(before);
    const children = [...world.bodies.values()].filter(b => b !== body);
    expect(children.every(b => Math.hypot(b.angularVelocity.x, b.angularVelocity.z) > 0)).toBe(true);
  });

  it('целый связный обломок не раскалывается без удара', () => {
    const { world } = plate();
    const before = voxels(world);
    const result = stepStructure(world, { timeBudgetMs: 0 });
    expect(result.fragments).toHaveLength(0);
    expect(world.bodies.size).toBe(1);
    expect(voxels(world)).toEqual(before);
  });
});
