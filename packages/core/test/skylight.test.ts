import { describe, expect, it } from 'vitest';
import { Mat, SKY_MAX, SkyLight, SkyLightField, VoxelShape } from '@tvox/core';

/**
 * Небесный свет.
 *
 * Всё, что здесь проверяется, сводится к одной фразе из приёмки: при
 * разрушении стены свет попадает внутрь. Плюс обратное — пока стена цела,
 * внутри темно, и никакие оптимизации не имеют права это сломать.
 */

/** Закрытая коробка со стенами в один воксель. */
function room(sx = 12, sy = 8, sz = 12): VoxelShape {
  const s = new VoxelShape({ sx, sy, sz, voxelSize: 0.1, name: 'комната' });
  s.fill({}, Mat.Concrete);
  s.fill({ x0: 1, y0: 1, z0: 1, x1: sx - 1, y1: sy - 1, z1: sz - 1 }, Mat.Air);
  return s;
}

describe('небесный свет', () => {
  it('открытое небо светит в полную силу', () => {
    const s = new VoxelShape({ sx: 4, sy: 6, sz: 4, voxelSize: 0.1, name: 'пусто' });
    const sky = new SkyLight(s);
    expect(sky.at(2, 5, 2)).toBe(SKY_MAX);
    expect(sky.at(2, 0, 2)).toBe(SKY_MAX);
    expect(sky.factor(2, 0, 2)).toBe(1);
  });

  it('под крышей темно', () => {
    const s = room();
    const sky = new SkyLight(s);
    // Центр пола закрытой коробки не видит неба ниоткуда.
    expect(sky.at(6, 1, 6)).toBe(0);
    expect(sky.factor(6, 1, 6)).toBe(0);
  });

  it('дыра в крыше освещает пол под собой', () => {
    const s = room();
    const sky = new SkyLight(s);
    expect(sky.at(6, 1, 6)).toBe(0);

    // Пробиваем крышу над центром.
    s.fill({ x0: 5, y0: s.sy - 1, z0: 5, x1: 7, y1: s.sy, z1: 7 }, Mat.Air);
    sky.rebuild({ x0: 5, y0: s.sy - 1, z0: 5, x1: 7, y1: s.sy, z1: 7 });

    // Прямо под дырой — полный свет, он падает колонкой до пола.
    expect(sky.at(6, 1, 6)).toBe(SKY_MAX);
    // По углам зала — темнее: свет туда только растеканием.
    expect(sky.at(1, 1, 1)).toBeLessThan(SKY_MAX);
  });

  it('свет затекает вбок и затухает с расстоянием', () => {
    // Длинный коридор с открытым торцом.
    const s = new VoxelShape({ sx: 40, sy: 6, sz: 6, voxelSize: 0.1, name: 'коридор' });
    s.fill({}, Mat.Concrete);
    s.fill({ x0: 1, y0: 1, z0: 1, x1: 39, y1: 5, z1: 5 }, Mat.Air);
    // Открываем торец: единственный вход света.
    s.fill({ x0: 0, y0: 1, z0: 1, x1: 1, y1: 5, z1: 5 }, Mat.Air);
    const sky = new SkyLight(s);

    const near = sky.at(2, 2, 3);
    const mid = sky.at(8, 2, 3);
    const far = sky.at(20, 2, 3);
    expect(near).toBeGreaterThan(0);
    expect(mid).toBeLessThan(near);
    expect(far).toBe(0);
  });

  it('стекло свет пропускает, бетон — нет', () => {
    const glazed = room();
    glazed.fill({ x0: 4, y0: 3, z0: 0, x1: 8, y1: 5, z1: 1 }, Mat.Glass);
    const lit = new SkyLight(glazed);

    const dark = new SkyLight(room());
    // Одна и та же точка: за витражом светлее, чем за глухой стеной.
    expect(lit.at(6, 4, 2)).toBeGreaterThan(dark.at(6, 4, 2));
  });

  it('пересчёт куска даёт то же, что полный расчёт', () => {
    const s = room(24, 10, 24);
    const sky = new SkyLight(s);

    // Три дыры в разных местах: крыша, стена, угол.
    const holes = [
      { x0: 10, y0: 9, z0: 10, x1: 13, y1: 10, z1: 13 },
      { x0: 0, y0: 3, z0: 6, x1: 1, y1: 6, z1: 9 },
      { x0: 22, y0: 1, z0: 22, x1: 24, y1: 4, z1: 24 },
    ];
    for (const h of holes) {
      s.fill(h, Mat.Air);
      sky.rebuild(h);
    }

    const full = new SkyLight(s);
    let diff = 0;
    let worst = 0;
    for (let i = 0; i < s.volume; i++) {
      const d = Math.abs(full.levels[i] - sky.levels[i]);
      if (d > 0) diff++;
      worst = Math.max(worst, d);
    }
    // Инкрементальный расчёт обязан совпасть с полным ровно: разошлись —
    // значит на карте будут швы из вчерашнего света.
    expect(`расхождений ${diff}, худшее ${worst}`).toBe('расхождений 0, худшее 0');
  });

  it('заделанная дыра снова гасит помещение', () => {
    const s = room();
    const sky = new SkyLight(s);
    const hole = { x0: 5, y0: s.sy - 1, z0: 5, x1: 7, y1: s.sy, z1: 7 };

    s.fill(hole, Mat.Air);
    sky.rebuild(hole);
    expect(sky.at(6, 1, 6)).toBe(SKY_MAX);

    // Заложили обратно — свет обязан уйти, а не остаться запечённым.
    s.fill(hole, Mat.Concrete);
    sky.rebuild(hole);
    expect(sky.at(6, 1, 6)).toBe(0);
  });

  it('вне формы считается открытым небом', () => {
    const sky = new SkyLight(room());
    expect(sky.at(-1, 0, 0)).toBe(SKY_MAX);
    expect(sky.at(0, 100, 0)).toBe(SKY_MAX);
  });

  it('поле мира считает форму один раз и отдаёт то же самое', () => {
    const s = room();
    const field = new SkyLightField();
    const a = field.of(s);
    const b = field.of(s);
    expect(a).toBe(b);

    // Пересчёт неизвестной формы ничего не ломает и ничего не считает.
    const other = room();
    field.rebuild(other, { x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 });
    expect(field.of(other).at(6, 1, 6)).toBe(0);

    field.forget(s);
    expect(field.of(s)).not.toBe(a);
  });

  it('расчёт склада укладывается в разумное время', () => {
    // Размер настоящего склада «Порта»: 200×80×160 вокселей.
    const s = new VoxelShape({ sx: 200, sy: 80, sz: 160, voxelSize: 0.1, name: 'склад' });
    s.fill({}, Mat.Brick);
    s.fill({ x0: 3, y0: 3, z0: 3, x1: 197, y1: 79, z1: 157 }, Mat.Air);

    const t0 = performance.now();
    const sky = new SkyLight(s);
    const bake = performance.now() - t0;

    const region = { x0: 90, y0: 76, z0: 70, x1: 110, y1: 80, z1: 90 };
    s.fill(region, Mat.Air);
    const t1 = performance.now();
    sky.rebuild(region);
    const patch = performance.now() - t1;

    console.log(`небесный свет: полный ${bake.toFixed(1)} мс, кусок ${patch.toFixed(1)} мс`);
    // Полный расчёт платится один раз на загрузке, кусок — в кадре.
    // Абсолютные числа тут условные, ловушка на регрессию в разы.
    expect(bake).toBeLessThan(2000);
    expect(patch).toBeLessThan(120);
    expect(sky.at(100, 4, 80)).toBe(SKY_MAX);
  });
});
