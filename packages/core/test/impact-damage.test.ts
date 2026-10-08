import { describe, expect, it } from 'vitest';
import { Body, Mat, RapierPhysics, VoxelShape, VoxelWorld, impactDamage, v3 } from '@tvox/core';

function block(size: number, material: Mat) {
  const shape = new VoxelShape({ sx: size, sy: size, sz: size, voxelSize: 0.1 }); shape.fill({}, material);
  return new Body({ kind: 'dynamic', shapes: [shape], transform: { position: v3(0, 8, 0), rotation: { x: 0, y: 0, z: 0, w: 1 } } });
}

describe('размер повреждения от падения зависит от предмета', () => {
  it('масса, размер и скорость увеличивают область и силу удара', () => {
    const light = impactDamage(block(6, Mat.Wood), 8), heavy = impactDamage(block(6, Mat.Metal), 8);
    const large = impactDamage(block(12, Mat.Metal), 8), slow = impactDamage(block(6, Mat.Metal), 3);
    expect(heavy.radius).toBeGreaterThan(light.radius); expect(heavy.power).toBeGreaterThan(light.power);
    expect(large.radius).toBeGreaterThan(heavy.radius); expect(large.power).toBeGreaterThan(heavy.power);
    expect(slow.radius).toBeLessThan(heavy.radius); expect(slow.power).toBeLessThan(heavy.power);
    expect(impactDamage(block(6, Mat.Metal), 0).radius).toBeLessThan(0.1);
  });

  it('одинаковая высота даёт меньшую воронку от дерева, чем от крупного стального предмета в Rapier', async () => {
    const damage: number[] = [];
    for (const [size, mat] of [[4, Mat.Wood], [10, Mat.Metal]] as const) {
      const world = new VoxelWorld();
      const floor = new VoxelShape({ sx: 80, sy: 10, sz: 80, voxelSize: 0.1 }); floor.fill({}, Mat.Dirt);
      floor.transform.position = v3(-4, -1, -4); floor.structural = false;
      world.addBody(new Body({ shapes: [floor] })); world.addBody(block(size, mat));
      const before = floor.solidVoxels, physics = await RapierPhysics.create(world);
      try {
        for (let i = 0; i < 180; i++) physics.step(1 / 60);
        damage.push(before - floor.solidVoxels);
      } finally { physics.dispose(); }
    }
    expect(damage[1]).toBeGreaterThan(damage[0] * 3 + 10);
  });
});
