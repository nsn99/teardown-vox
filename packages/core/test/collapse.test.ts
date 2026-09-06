import { describe, expect, it } from 'vitest';
import { Body, Mat, Simulation, VoxelShape, v3 } from '@tvox/core';
import { VS, makeShape } from './helpers.js';

/**
 * Обвал второго порядка: падающий обломок должен пробивать то, на что
 * упал, а пробитое — терять опору и падать дальше. Проверяется на
 * headless-физике: в браузере ту же цепочку ведёт Rapier, но правило
 * «масса и высота решают» обязано быть одинаковым.
 */

/** Здание с перекрытиями на заданных высотах между двумя колоннами. */
function building(floors: number[], floorMat: Mat = Mat.Wood): VoxelShape {
  const s = makeShape(60, 100, 60);
  // Колонны по краям — на всю высоту.
  s.fill({ x0: 0, y0: 0, z0: 0, x1: 4, y1: 100, z1: 60 }, Mat.Concrete);
  s.fill({ x0: 56, y0: 0, z0: 0, x1: 60, y1: 100, z1: 60 }, Mat.Concrete);
  for (const y of floors) {
    s.fill({ x0: 4, y0: y, z0: 0, x1: 56, y1: y + 2, z1: 60 }, floorMat);
  }
  return s;
}

/** Плита из тяжёлой стали, подвешенная в воздухе над зданием. */
function slab(atY: number, half = 10, thickness = 6, mat: Mat = Mat.HeavyMetal): Body {
  const s = new VoxelShape({ sx: half * 2, sy: thickness, sz: half * 2, voxelSize: VS });
  s.fill({ x0: 0, y0: 0, z0: 0, x1: half * 2, y1: thickness, z1: half * 2 }, mat);
  return new Body({
    kind: 'dynamic',
    shapes: [s],
    name: 'плита',
    tags: ['debris'],
    transform: {
      position: v3(30 * VS - half * VS, atY * VS, 30 * VS - half * VS),
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    },
  });
}

function run(sim: Simulation, seconds: number): number {
  const frames = Math.round(seconds * 60);
  for (let i = 0; i < frames; i++) sim.step(1 / 60);
  return frames;
}

describe('обвал второго порядка', () => {
  it('тяжёлая плита с высоты пробивает деревянное перекрытие', () => {
    const sim = new Simulation();
    const shape = building([40]);
    sim.world.addBody(new Body({ kind: 'static', shapes: [shape], name: 'дом', tags: ['level'] }));
    const before = shape.solidVoxels;

    sim.world.addBody(slab(80));
    run(sim, 2);

    expect(shape.solidVoxels).toBeLessThan(before);
    // Дыра именно в перекрытии, а не в колоннах: считаем дерево.
    let wood = 0;
    for (let i = 0; i < shape.data.length; i++) if (shape.data[i] === Mat.Wood) wood++;
    expect(wood).toBeLessThan(52 * 2 * 60);
  });

  it('лёгкий ящик с малой высоты не ломает ничего', () => {
    const sim = new Simulation();
    const shape = building([40]);
    sim.world.addBody(new Body({ kind: 'static', shapes: [shape], name: 'дом', tags: ['level'] }));
    const before = shape.solidVoxels;

    // Ящик 6×5×6 из дерева, отпущен с трёх сантиметров над перекрытием.
    const box = slab(43, 3, 5, Mat.Wood);
    const boxVoxels = box.solidVoxels;
    sim.world.addBody(box);
    run(sim, 2);

    expect(shape.solidVoxels).toBe(before);
    expect(box.solidVoxels).toBe(boxVoxels);
  });

  it('цепочка из трёх этажей обрушается за конечное число шагов', () => {
    const sim = new Simulation();
    const shape = building([20, 40, 60]);
    sim.world.addBody(new Body({ kind: 'static', shapes: [shape], name: 'дом', tags: ['level'] }));
    const before = shape.solidVoxels;

    sim.world.addBody(slab(90));

    // Крутим, пока мир не перестанет меняться. Порог тишины больше секунды:
    // между пробитыми перекрытиями обломок летит молча, и слишком короткое
    // окно приняло бы свободное падение за конец обвала.
    let last = -1;
    let quiet = 0;
    let frames = 0;
    while (frames < 1800 && quiet < 90) {
      sim.step(1 / 60);
      frames++;
      const now = sim.world.totalSolidVoxels();
      quiet = now === last ? quiet + 1 : 0;
      last = now;
    }

    expect(frames).toBeLessThan(1800);
    // Пробило не одно перекрытие, а цепочку: дерева должно стать заметно меньше.
    let wood = 0;
    for (let i = 0; i < shape.data.length; i++) if (shape.data[i] === Mat.Wood) wood++;
    const woodBefore = 3 * 52 * 2 * 60;
    expect(wood).toBeLessThan(woodBefore * 0.8);
    expect(shape.solidVoxels).toBeLessThan(before);
  });

  it('лежащее тело не проедает опору под собой', () => {
    const sim = new Simulation();
    const shape = building([40], Mat.Concrete);
    sim.world.addBody(new Body({ kind: 'static', shapes: [shape], name: 'дом', tags: ['level'] }));

    // Кладём плиту ровно на перекрытие и держим долго.
    const body = slab(42);
    sim.world.addBody(body);
    run(sim, 3);
    const settled = shape.solidVoxels;
    run(sim, 3);

    expect(shape.solidVoxels).toBe(settled);
  });
});
