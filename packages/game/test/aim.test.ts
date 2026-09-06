import { describe, expect, it } from 'vitest';
import { Body, Mat, Simulation, SmokeField, VoxelShape, makeRng, v3 } from '@tvox/core';
import { Inventory, aimThroughSmoke, useTool } from '@tvox/game';

/**
 * Дым против прицела.
 *
 * Требование приёмки звучит как «плотный дым реально мешает целиться, а
 * не просто рисуется поверх». Отсюда и проверки: в чистом воздухе луч не
 * дрожит вовсе, в густом дыму уводит, и всё это повторяемо по сиду —
 * иначе разбор неудачного захода превращается в спор.
 */

const still = () => new SmokeField({ wind: v3(), rise: 0 });

/** Угол между направлениями, рад. */
function angle(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  return Math.acos(Math.min(1, Math.max(-1, dot)));
}

describe('прицел в дыму', () => {
  const eye = v3(0, 1.5, 0.5);
  const dir = v3(1, 0, 0);

  it('в чистом воздухе рука не дрожит', () => {
    const smoke = still();
    const res = aimThroughSmoke(smoke, eye, dir, 10, makeRng(1));
    expect(res.opacity).toBe(0);
    expect(res.direction).toEqual(dir);
  });

  it('тонкая дымка почти не мешает', () => {
    const smoke = still();
    smoke.emit(v3(4.5, 1.5, 0.5), 0.05);
    const res = aimThroughSmoke(smoke, eye, dir, 10, makeRng(1));
    expect(angle(res.direction, dir)).toBeLessThan(0.002);
  });

  it('густой дым уводит луч', () => {
    const smoke = still();
    for (let x = 2; x < 8; x++) smoke.emit(v3(x + 0.5, 1.5, 0.5), 1);

    let worst = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const res = aimThroughSmoke(smoke, eye, dir, 10, makeRng(seed));
      worst = Math.max(worst, angle(res.direction, dir));
      expect(res.opacity).toBeGreaterThan(0.9);
    }
    // Увод есть, но он не превращает прицел в лотерею: два градуса —
    // это промах по вокселю на десяти метрах, а не стрельба в небо.
    expect(worst).toBeGreaterThan(0.005);
    expect(worst).toBeLessThan(0.04);
  });

  it('увод повторяем по сиду', () => {
    const smoke = still();
    for (let x = 2; x < 8; x++) smoke.emit(v3(x + 0.5, 1.5, 0.5), 1);
    const a = aimThroughSmoke(smoke, eye, dir, 10, makeRng(42));
    const b = aimThroughSmoke(smoke, eye, dir, 10, makeRng(42));
    const c = aimThroughSmoke(smoke, eye, dir, 10, makeRng(43));
    expect(a.direction).toEqual(b.direction);
    expect(c.direction).not.toEqual(a.direction);
  });

  it('увод идёт вбок, а не по дальности', () => {
    const smoke = still();
    for (let x = 2; x < 8; x++) smoke.emit(v3(x + 0.5, 1.5, 0.5), 1);
    for (let seed = 1; seed <= 10; seed++) {
      const res = aimThroughSmoke(smoke, eye, dir, 10, makeRng(seed));
      // Направление остаётся нормированным и всё ещё смотрит вперёд.
      const len = Math.hypot(res.direction.x, res.direction.y, res.direction.z);
      expect(len).toBeCloseTo(1, 6);
      expect(res.direction.x).toBeGreaterThan(0.99);
    }
  });

  it('взгляд вертикально вверх тоже уводится корректно', () => {
    const smoke = still();
    for (let y = 2; y < 6; y++) smoke.emit(v3(0.5, y + 0.5, 0.5), 1);
    const res = aimThroughSmoke(smoke, v3(0.5, 1, 0.5), v3(0, 1, 0), 8, makeRng(5));
    const len = Math.hypot(res.direction.x, res.direction.y, res.direction.z);
    expect(len).toBeCloseTo(1, 6);
    expect(res.direction.y).toBeGreaterThan(0.99);
  });
});

describe('инструмент в дыму', () => {
  function scene() {
    const sim = new Simulation();
    // Дощатая перегородка в трёх метрах. Не кирпич: дробовик первой
    // ступени с такой дистанции кладку не берёт, и мерить было бы нечего.
    const s = new VoxelShape({ sx: 4, sy: 40, sz: 40, voxelSize: 0.1, name: 'перегородка' });
    s.fill({}, Mat.Plank);
    s.transform = { position: v3(3, 0, -1.5), rotation: { x: 0, y: 0, z: 0, w: 1 } };
    sim.world.addBody(new Body({ kind: 'static', shapes: [s], name: 'перегородка' }));
    return sim;
  }

  it('в дыму инструмент бьёт не туда, куда в чистом воздухе', () => {
    const shotgun = (): Inventory => {
      const inv = new Inventory({ unlimited: true });
      inv.select('shotgun');
      return inv;
    };

    const shoot = (smoky: boolean, seed: number) => {
      const sim = scene();
      if (smoky) for (let x = 0; x < 3; x++) sim.smoke.emit(v3(x + 0.5, 1.5, 0.5), 1);
      return useTool({
        sim,
        inventory: shotgun(),
        origin: v3(0, 1.5, 0.5),
        direction: v3(1, 0, 0),
        rng: makeRng(seed),
      });
    };

    const clean = shoot(false, 11);
    expect(clean.used).toBe(true);
    expect(clean.removed).toBeGreaterThan(0);

    // Через дымовую завесу заряд ложится в стороне. Меряем по нескольким
    // сидам: один может лечь и близко, но систематически — уводит.
    let worst = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const smoky = shoot(true, seed);
      expect(smoky.used).toBe(true);
      const a = clean.point!;
      const b = smoky.point!;
      worst = Math.max(worst, Math.hypot(a.y - b.y, a.z - b.z));
    }
    // Три метра дыма — это промах на сантиметры: не лотерея, но и не
    // «целился в доску, попал в доску».
    expect(worst).toBeGreaterThan(0.005);
    expect(worst).toBeLessThan(0.5);
  });
});
