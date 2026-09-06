import { describe, expect, it } from 'vitest';
import { Body, Mat, VoxelShape, VoxelWorld, v3 } from '@tvox/core';
import { chaseCamera, lookDirection } from '@tvox/game';

/**
 * Камера от третьего лица.
 *
 * Единственное, что здесь может сломать прохождение, — камера в стене:
 * чёрный кадр и потеря ориентации. Поэтому проверяем не «красиво ли», а
 * «снаружи ли геометрии».
 */

/** Стена размером 4×4×0.4 м с ближней гранью на z = z0. */
function wallWorld(z0: number): VoxelWorld {
  const world = new VoxelWorld();
  const s = new VoxelShape({ sx: 40, sy: 40, sz: 4, voxelSize: 0.1, name: 'стена' });
  s.fill({}, Mat.Concrete);
  s.transform = { position: v3(-2, 0, z0), rotation: { x: 0, y: 0, z: 0, w: 1 } };
  world.addBody(new Body({ kind: 'static', shapes: [s], name: 'стена' }));
  return world;
}

const OPTS = { distance: 6, height: 1, margin: 0.35, minDistance: 0.6 };

describe('камера от третьего лица', () => {
  it('на открытом месте отъезжает на заданное расстояние', () => {
    const world = new VoxelWorld();
    const focus = v3(0, 1, 0);
    // yaw = 0 — смотрим в −Z, значит камера уезжает в +Z.
    const eye = chaseCamera(world, focus, 0, 0, OPTS);
    expect(eye.z).toBeCloseTo(focus.z + OPTS.distance, 5);
    expect(eye.y).toBeCloseTo(focus.y + OPTS.height, 5);
  });

  it('упирается в стену за спиной, а не проходит сквозь', () => {
    // Стена в двух метрах позади игрока.
    const world = wallWorld(2);
    const focus = v3(0, 1, 0);
    const eye = chaseCamera(world, focus, 0, 0, OPTS);
    expect(eye.z).toBeLessThan(2);
    expect(eye.z).toBeGreaterThan(0);
    // Зазор соблюдён: камера не касается кладки.
    expect(2 - eye.z).toBeGreaterThanOrEqual(OPTS.margin - 1e-6);
  });

  it('в тесном углу возвращается к самой цели, а не в бетон', () => {
    // Стена вплотную: отъезжать некуда.
    const world = wallWorld(0.3);
    const focus = v3(0, 1, 0);
    const eye = chaseCamera(world, focus, 0, 0, OPTS);
    expect(eye.x).toBeCloseTo(focus.x, 5);
    expect(eye.z).toBeCloseTo(focus.z, 5);
    expect(eye.y).toBeCloseTo(focus.y + OPTS.height, 5);
  });

  it('своя техника камере не мешает', () => {
    const world = wallWorld(2);
    const own = [...world.bodies.values()][0];
    const eye = chaseCamera(world, v3(0, 1, 0), 0, 0, {
      ...OPTS,
      ignore: new Set([own.id]),
    });
    // С игнорированием того же тела камера уезжает на полную.
    expect(eye.z).toBeCloseTo(OPTS.distance, 5);
  });

  it('поворот камеры следует за курсом', () => {
    const world = new VoxelWorld();
    const focus = v3(0, 1, 0);
    // Курс на 90° — смотрим в −X, камера уходит в +X.
    const eye = chaseCamera(world, focus, Math.PI / 2, 0, OPTS);
    expect(eye.x).toBeCloseTo(OPTS.distance, 4);
    expect(Math.abs(eye.z)).toBeLessThan(1e-6);
  });

  it('взгляд вниз поднимает камеру', () => {
    const world = new VoxelWorld();
    const eye = chaseCamera(world, v3(0, 1, 0), 0, -0.5, OPTS);
    expect(eye.y).toBeGreaterThan(1 + OPTS.height);
  });

  it('направление взгляда нормировано и смотрит вперёд при нуле', () => {
    const d = lookDirection(0, 0);
    expect(d.x).toBeCloseTo(0, 6);
    expect(d.y).toBeCloseTo(0, 6);
    expect(d.z).toBeCloseTo(-1, 6);
    const t = lookDirection(1.2, 0.4);
    expect(Math.hypot(t.x, t.y, t.z)).toBeCloseTo(1, 6);
  });
});
