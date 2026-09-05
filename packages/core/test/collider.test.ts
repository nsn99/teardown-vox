import { describe, expect, it } from 'vitest';
import { Mat, boxesToColliders, buildColliders, decomposeToBoxes } from '@tvox/core';
import { VS, makeShape } from './helpers.js';

const volumeOf = (b: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }) =>
  (b.x1 - b.x0) * (b.y1 - b.y0) * (b.z1 - b.z0);

describe('жадная декомпозиция в боксы', () => {
  it('сплошной блок — ровно один бокс', () => {
    const s = makeShape(8, 8, 8);
    s.fill({}, Mat.Concrete);
    const boxes = decomposeToBoxes(s);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toEqual({ x0: 0, y0: 0, z0: 0, x1: 8, y1: 8, z1: 8 });
  });

  it('пустая форма — ноль боксов', () => {
    expect(decomposeToBoxes(makeShape(4, 4, 4))).toHaveLength(0);
  });

  it('боксы покрывают ровно занятый объём и не перекрываются', () => {
    const s = makeShape(12, 6, 9);
    s.fill({ x0: 0, x1: 12, y0: 0, y1: 1, z0: 0, z1: 9 }, Mat.Concrete);
    s.fill({ x0: 2, x1: 5, y0: 1, y1: 6, z0: 3, z1: 4 }, Mat.Brick);
    s.set(9, 4, 7, Mat.Wood);

    const boxes = decomposeToBoxes(s);
    const covered = boxes.reduce((acc, b) => acc + volumeOf(b), 0);
    expect(covered).toBe(s.solidVoxels);

    const mark = new Uint8Array(s.volume);
    for (const b of boxes) {
      for (let y = b.y0; y < b.y1; y++) {
        for (let z = b.z0; z < b.z1; z++) {
          for (let x = b.x0; x < b.x1; x++) {
            const i = s.idx(x, y, z);
            expect(mark[i]).toBe(0);
            expect(s.data[i]).not.toBe(Mat.Air);
            mark[i] = 1;
          }
        }
      }
    }
  });

  it('стена в один воксель толщиной складывается в один бокс', () => {
    const s = makeShape(20, 10, 3);
    s.fill({ x0: 0, x1: 20, y0: 0, y1: 10, z0: 1, z1: 2 }, Mat.Brick);
    expect(decomposeToBoxes(s)).toHaveLength(1);
  });

  it('шахматный узор даёт по боксу на воксель — худший случай', () => {
    const s = makeShape(6, 1, 6);
    let n = 0;
    for (let z = 0; z < 6; z++) {
      for (let x = 0; x < 6; x++) {
        if ((x + z) % 2 === 0) {
          s.set(x, 0, z, Mat.Metal);
          n++;
        }
      }
    }
    expect(decomposeToBoxes(s)).toHaveLength(n);
  });

  it('лимит боксов соблюдается', () => {
    const s = makeShape(10, 1, 10);
    for (let z = 0; z < 10; z++) {
      for (let x = 0; x < 10; x++) if ((x + z) % 2 === 0) s.set(x, 0, z, Mat.Metal);
    }
    expect(decomposeToBoxes(s, { maxBoxes: 7 })).toHaveLength(7);
  });

  it('фильтр материалов исключает неколлизионные воксели', () => {
    const s = makeShape(6, 6, 6);
    s.fill({}, Mat.Water);
    s.set(3, 3, 3, Mat.Concrete);
    const boxes = decomposeToBoxes(s, { includes: (m) => m === Mat.Concrete });
    expect(boxes).toHaveLength(1);
    expect(volumeOf(boxes[0])).toBe(1);
  });
});

describe('перевод боксов в коллайдеры', () => {
  it('центры и полуразмеры считаются в метрах', () => {
    const s = makeShape(4, 4, 4);
    s.fill({}, Mat.Concrete);
    const [c] = buildColliders(s);
    expect(c.hx).toBeCloseTo(2 * VS, 9);
    expect(c.cx).toBeCloseTo(2 * VS, 9);
  });

  it('одиночный воксель даёт полуразмер в полвокселя', () => {
    const s = makeShape(4, 4, 4);
    s.set(1, 2, 3, Mat.Metal);
    const [c] = boxesToColliders(s, decomposeToBoxes(s));
    expect(c.hx).toBeCloseTo(VS / 2, 9);
    expect(c.cy).toBeCloseTo(2.5 * VS, 9);
    expect(c.cz).toBeCloseTo(3.5 * VS, 9);
  });
});
