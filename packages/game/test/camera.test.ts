import { describe, expect, it } from 'vitest';
import { Body, Mat, VoxelShape, VoxelWorld, v3 } from '@tvox/core';
import { CameraShake, chaseCamera, lookDirection } from '@tvox/game';

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

describe('тряска камеры', () => {
  it('в покое камера стоит', () => {
    const shake = new CameraShake();
    const s = shake.update(1 / 60);
    expect(shake.level).toBe(0);
    expect(s.offset).toEqual(v3());
    expect(s.roll).toBe(0);
  });

  it('близкий взрыв трясёт сильнее далёкого', () => {
    const near = new CameraShake();
    const far = new CameraShake();
    near.add(1, 2);
    far.add(1, 25);
    expect(near.level).toBeGreaterThan(far.level);
    expect(far.level).toBeGreaterThan(0);
  });

  it('за краем радиуса не трясёт вовсе', () => {
    const shake = new CameraShake();
    shake.add(1, 60, 30);
    expect(shake.level).toBe(0);
  });

  it('тряска затухает сама и не копится выше предела', () => {
    const shake = new CameraShake({ recovery: 1 });
    for (let i = 0; i < 10; i++) shake.add(1, 0);
    expect(shake.level).toBe(1);

    let biggest = 0;
    for (let i = 0; i < 60; i++) {
      const s = shake.update(1 / 60);
      biggest = Math.max(biggest, Math.hypot(s.offset.x, s.offset.y, s.offset.z));
    }
    // За секунду восстановления травма ушла в ноль.
    expect(shake.level).toBe(0);
    // И пока она была, камера двигалась в разумных пределах.
    expect(biggest).toBeGreaterThan(0.01);
    expect(biggest).toBeLessThan(0.3);
  });

  it('слабая встряска почти не двигает картинку', () => {
    const weak = new CameraShake();
    const strong = new CameraShake();
    weak.add(0.2, 0);
    strong.add(1, 0);
    const w = amplitude(weak);
    const s = amplitude(strong);
    // Квадрат травмы: разница в пять раз по силе даёт разницу на порядок.
    expect(s / Math.max(w, 1e-9)).toBeGreaterThan(8);
  });

  it('тряска повторяема: два одинаковых события дают одно и то же', () => {
    const a = new CameraShake();
    const b = new CameraShake();
    a.add(0.8, 3);
    b.add(0.8, 3);
    for (let i = 0; i < 20; i++) {
      expect(a.update(1 / 60)).toEqual(b.update(1 / 60));
    }
  });

  it('сброс возвращает камеру в покой', () => {
    const shake = new CameraShake();
    shake.add(1, 0);
    shake.reset();
    expect(shake.level).toBe(0);
    expect(shake.update(1 / 60).offset).toEqual(v3());
  });
});

/** Наибольшее смещение за полсекунды. */
function amplitude(shake: CameraShake): number {
  let biggest = 0;
  for (let i = 0; i < 30; i++) {
    const s = shake.update(1 / 60);
    biggest = Math.max(biggest, Math.hypot(s.offset.x, s.offset.y, s.offset.z));
  }
  return biggest;
}
