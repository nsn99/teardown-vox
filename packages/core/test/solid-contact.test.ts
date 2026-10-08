import { describe, expect, it } from 'vitest';
import { Body, Mat, VoxelShape, VoxelWorld, bodyMovementBlocked, bodyOverlapsWorld, bodySolidBounds, quatFromEulerYXZ, v3 } from '@tvox/core';

function block(world: VoxelWorld, position = v3(), rotation = quatFromEulerYXZ(0, 0)) {
  const shape = new VoxelShape({ sx: 10, sy: 10, sz: 10, voxelSize: 0.1 }); shape.fill({}, Mat.Concrete);
  const body = world.addBody(new Body({ shapes: [shape], transform: { position, rotation } }));
  return { body, shape };
}

describe('контакт по занятому объёму, включая поворот и пустоты', () => {
  it('пустой кузов пропускает груз внутрь, но его дно и борта остаются препятствиями', () => {
    const world = new VoxelWorld();
    const bed = new VoxelShape({ sx: 50, sy: 20, sz: 40, voxelSize: 0.1 });
    bed.fill({ y1: 2 }, Mat.Metal); bed.fill({ z1: 2 }, Mat.Metal); bed.fill({ z0: 38 }, Mat.Metal);
    const truck = world.addBody(new Body({ shapes: [bed], transform: { position: v3(10, 2, 10), rotation: quatFromEulerYXZ(0.8, 0) } }));
    const { body: cargo } = block(world, v3(12, 3, 10), truck.transform.rotation);
    const pose = { ...truck.transform, position: v3(10.5, 2.3, 10) };
    // Same translation in the truck's local frame, independent of the query's SAT.
    const localPose = (x: number, y: number, z: number) => ({ rotation: truck.transform.rotation,
      position: v3(10 + Math.cos(0.8) * x + Math.sin(0.8) * z, 2 + y,
        10 - Math.sin(0.8) * x + Math.cos(0.8) * z) });
    expect(bodyOverlapsWorld(world, cargo, localPose(1, 0.3, 1))).toBe(false);
    expect(bodyOverlapsWorld(world, cargo, localPose(1, 0.1, 1))).toBe(true);
    expect(bodyOverlapsWorld(world, cargo, localPose(1, 0.3, 3.2))).toBe(true);
    expect(bodyOverlapsWorld(world, cargo, localPose(1, 0.3, 1), new Set([truck.id]))).toBe(false);
    expect(bodyOverlapsWorld(world, cargo, pose, undefined, other => other !== truck)).toBe(false);
    truck.destroyed = true;
    expect(bodyOverlapsWorld(world, cargo, localPose(1, 0.1, 1))).toBe(false);
  });

  it('точное касание разрешено; удаление вокселей сразу открывает проход, даже после сброса dirty чанков', () => {
    const world = new VoxelWorld(); const a = block(world); const b = block(world, v3(1, 0, 0));
    expect(bodyOverlapsWorld(world, a.body, a.body.transform)).toBe(false);
    b.body.transform.position.x = 0.9; expect(bodyOverlapsWorld(world, a.body, a.body.transform)).toBe(true);
    b.shape.fill({ x1: 2 }, Mat.Air); b.shape.dirtyColliderChunks.clear(); b.shape.clearMeshDirty(); b.shape.clearStructureDirty();
    expect(bodyOverlapsWorld(world, a.body, a.body.transform)).toBe(false);
    b.shape.fill({ x1: 2 }, Mat.Concrete); b.shape.dirtyColliderChunks.clear(); b.shape.clearMeshDirty(); b.shape.clearStructureDirty();
    expect(bodyOverlapsWorld(world, a.body, a.body.transform)).toBe(true);
    b.body.tags.add('water'); expect(bodyOverlapsWorld(world, a.body, a.body.transform)).toBe(false);
  });

  it('даёт отъехать из уже существующего пересечения, но запрещает углублять его или создавать новый контакт', () => {
    const world = new VoxelWorld(); const a = block(world); block(world, v3(0.8, 0, 0));
    const pose = (x: number) => ({ ...a.body.transform, position: v3(x, 0, 0) });
    expect(bodyMovementBlocked(world, a.body, pose(0), pose(-0.05))).toBe(false);
    expect(bodyMovementBlocked(world, a.body, pose(0), pose(0.05))).toBe(true);
    expect(bodyMovementBlocked(world, a.body, pose(-1), pose(0))).toBe(true);
    expect(bodyMovementBlocked(world, a.body, pose(0), { ...pose(-0.05), rotation: quatFromEulerYXZ(0.1, 0) })).toBe(true);
    block(world, v3(-1.02, 0, 0));
    expect(bodyMovementBlocked(world, a.body, pose(0), pose(-0.05))).toBe(true);
  });

  it('редкая повёрнутая форма не расширяет границы до воздушных углов и не считает воду опорой', () => {
    const world = new VoxelWorld(); const { body, shape } = block(world, v3(4, 3, 2));
    shape.fill({}, Mat.Air); shape.fill({ x0: 2, x1: 4, y0: 1, y1: 3, z0: 5, z1: 7 }, Mat.Concrete);
    shape.fill({ x0: 8, x1: 10, y0: 8, y1: 10 }, Mat.Water);
    shape.transform.rotation = quatFromEulerYXZ(Math.PI / 2, 0);
    const bounds = bodySolidBounds(body);
    expect(bounds.min.x).toBeCloseTo(4.5); expect(bounds.max.x).toBeCloseTo(4.7);
    expect(bounds.min.y).toBeCloseTo(3.1); expect(bounds.max.y).toBeCloseTo(3.3);
    expect(bounds.min.z).toBeCloseTo(1.6); expect(bounds.max.z).toBeCloseTo(1.8);
  });
});
