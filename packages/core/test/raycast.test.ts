import { describe, expect, it } from 'vitest';
import {
  Body,
  Mat,
  VoxelWorld,
  quatFromAxisAngle,
  raycastShape,
  v3,
  voxelToWorld,
  worldToVoxel,
} from '@tvox/core';
import { VS, makeShape, worldWith } from './helpers.js';

describe('DDA по одной форме', () => {
  it('находит первый непустой воксель на пути', () => {
    const s = makeShape(10, 10, 10);
    s.set(5, 0, 0, Mat.Concrete);
    const hit = raycastShape(s, v3(-1, 0.05, 0.05), v3(1, 0, 0), 100);
    expect(hit).not.toBeNull();
    expect([hit!.vx, hit!.vy, hit!.vz]).toEqual([5, 0, 0]);
    expect(hit!.t).toBeCloseTo(1 + 5 * VS, 6);
  });

  it('нормаль указывает против луча', () => {
    const s = makeShape(10, 10, 10);
    s.set(5, 0, 0, Mat.Concrete);
    const hit = raycastShape(s, v3(-1, 0.05, 0.05), v3(1, 0, 0), 100);
    expect(hit!.normal).toEqual(v3(-1, 0, 0));

    const back = raycastShape(s, v3(2, 0.05, 0.05), v3(-1, 0, 0), 100);
    expect(back!.normal).toEqual(v3(1, 0, 0));
  });

  it('нормаль по вертикали и по Z', () => {
    const s = makeShape(10, 10, 10);
    s.set(0, 5, 0, Mat.Concrete);
    const up = raycastShape(s, v3(0.05, -1, 0.05), v3(0, 1, 0), 100);
    expect(up!.normal).toEqual(v3(0, -1, 0));

    const s2 = makeShape(10, 10, 10);
    s2.set(0, 0, 5, Mat.Concrete);
    const fwd = raycastShape(s2, v3(0.05, 0.05, -1), v3(0, 0, 1), 100);
    expect(fwd!.normal).toEqual(v3(0, 0, -1));
  });

  it('пустая форма даёт null', () => {
    const s = makeShape(10, 10, 10);
    expect(raycastShape(s, v3(-1, 0.05, 0.05), v3(1, 0, 0), 100)).toBeNull();
  });

  it('луч мимо формы даёт null', () => {
    const s = makeShape(4, 4, 4);
    s.fill({}, Mat.Concrete);
    expect(raycastShape(s, v3(-1, 99, 0), v3(1, 0, 0), 100)).toBeNull();
  });

  it('ограничение дальности отсекает попадание', () => {
    const s = makeShape(20, 4, 4);
    s.set(15, 0, 0, Mat.Concrete);
    expect(raycastShape(s, v3(-1, 0.05, 0.05), v3(1, 0, 0), 1.2)).toBeNull();
    expect(raycastShape(s, v3(-1, 0.05, 0.05), v3(1, 0, 0), 5)).not.toBeNull();
  });

  it('фильтр материалов пропускает не подходящие воксели', () => {
    const s = makeShape(10, 4, 4);
    s.set(2, 0, 0, Mat.Glass);
    s.set(6, 0, 0, Mat.Concrete);
    const hit = raycastShape(s, v3(-1, 0.05, 0.05), v3(1, 0, 0), 100, (m) => m === Mat.Concrete);
    expect(hit!.vx).toBe(6);
  });

  it('луч из точки внутри материала попадает сразу', () => {
    const s = makeShape(6, 6, 6);
    s.fill({}, Mat.Concrete);
    const hit = raycastShape(s, v3(0.25, 0.25, 0.25), v3(1, 0, 0), 100);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(0, 5);
  });

  it('диагональный луч проходит корректно', () => {
    const s = makeShape(12, 12, 12);
    s.set(5, 5, 0, Mat.Wood);
    const d = v3(1, 1, 0);
    const len = Math.hypot(1, 1);
    const hit = raycastShape(s, v3(0.05, 0.05, 0.05), v3(d.x / len, d.y / len, 0), 100);
    expect([hit!.vx, hit!.vy]).toEqual([5, 5]);
  });
});

describe('трассировка по миру', () => {
  it('возвращает ближайшее тело из нескольких', () => {
    const world = new VoxelWorld();
    const near = makeShape(2, 2, 2);
    near.fill({}, Mat.Wood);
    const far = makeShape(2, 2, 2);
    far.fill({}, Mat.Metal);
    far.transform = { position: v3(5, 0, 0), rotation: { x: 0, y: 0, z: 0, w: 1 } };
    world.addBody(new Body({ kind: 'static', shapes: [near], name: 'near' }));
    world.addBody(new Body({ kind: 'static', shapes: [far], name: 'far' }));

    const hit = world.raycast(v3(-1, 0.05, 0.05), v3(1, 0, 0));
    expect(hit!.body.name).toBe('near');
    expect(hit!.material).toBe(Mat.Wood);
  });

  it('игнор-список пропускает тело', () => {
    const world = new VoxelWorld();
    const near = makeShape(2, 2, 2);
    near.fill({}, Mat.Wood);
    const far = makeShape(2, 2, 2);
    far.fill({}, Mat.Metal);
    far.transform = { position: v3(5, 0, 0), rotation: { x: 0, y: 0, z: 0, w: 1 } };
    const a = world.addBody(new Body({ kind: 'static', shapes: [near], name: 'near' }));
    world.addBody(new Body({ kind: 'static', shapes: [far], name: 'far' }));

    const hit = world.raycast(v3(-1, 0.05, 0.05), v3(1, 0, 0), { ignore: new Set([a.id]) });
    expect(hit!.body.name).toBe('far');
  });

  it('учитывает поворот тела', () => {
    const s = makeShape(10, 2, 2);
    s.set(9, 0, 0, Mat.Metal);
    const body = new Body({
      kind: 'static',
      shapes: [s],
      transform: { position: v3(0, 0, 0), rotation: quatFromAxisAngle(v3(0, 1, 0), Math.PI / 2) },
    });
    const world = new VoxelWorld();
    world.addBody(body);
    // После поворота на 90° локальная ось +X смотрит в мировую -Z:
    // дальний воксель формы оказывается около z = -0.95.
    const away = world.raycast(v3(0.05, 0.05, -3), v3(0, 0, -1), {});
    expect(away).toBeNull();
    const hit = world.raycast(v3(0.05, 0.05, -3), v3(0, 0, 1), {});
    expect(hit).not.toBeNull();
    expect(hit!.vx).toBe(9);
    expect(hit!.point.z).toBeCloseTo(-1, 2);
  });

  it('нулевое направление не роняет трассировку', () => {
    const { world } = worldWith(makeShape(2, 2, 2));
    expect(world.raycast(v3(0, 0, 0), v3(0, 0, 0))).toBeNull();
  });

  it('удалённые тела не участвуют', () => {
    const s = makeShape(2, 2, 2);
    s.fill({}, Mat.Wood);
    const { world, body } = worldWith(s);
    expect(world.raycast(v3(-1, 0.05, 0.05), v3(1, 0, 0))).not.toBeNull();
    world.removeBody(body);
    expect(world.raycast(v3(-1, 0.05, 0.05), v3(1, 0, 0))).toBeNull();
  });

  it('точка попадания лежит на поверхности вокселя', () => {
    const s = makeShape(10, 4, 4);
    s.set(5, 0, 0, Mat.Concrete);
    const { world } = worldWith(s);
    const hit = world.raycast(v3(-1, 0.05, 0.05), v3(1, 0, 0))!;
    expect(hit.point.x).toBeCloseTo(5 * VS, 5);
  });
});

describe('конвертация координат', () => {
  it('worldToVoxel и voxelToWorld согласованы', () => {
    const s = makeShape(8, 8, 8);
    const { body } = worldWith(s);
    const p = voxelToWorld(body, s, 3, 4, 5);
    expect(worldToVoxel(body, s, p)).toEqual({ x: 3, y: 4, z: 5 });
  });
});
