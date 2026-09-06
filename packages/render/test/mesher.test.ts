import { describe, expect, it } from 'vitest';
import { Mat, VoxelShape } from '@tvox/core';
import { meshShape, surfaceArea } from '@tvox/render';

const VS = 0.1;
const shape = (sx: number, sy: number, sz: number) =>
  new VoxelShape({ sx, sy, sz, voxelSize: VS });

describe('жадное меширование', () => {
  it('один воксель даёт шесть квадов', () => {
    const s = shape(3, 3, 3);
    s.set(1, 1, 1, Mat.Concrete);
    const mesh = meshShape(s);
    expect(mesh.quads).toBe(6);
    expect(mesh.indices.length).toBe(6 * 6);
    // Позиции хранятся во Float32, отсюда допуск.
    expect(surfaceArea(mesh)).toBeCloseTo(6 * VS * VS, 6);
  });

  it('пустая форма даёт пустой меш', () => {
    const mesh = meshShape(shape(4, 4, 4));
    expect(mesh.quads).toBe(0);
    expect(mesh.positions.length).toBe(0);
  });

  it('плоская стена склеивается в один квад на сторону', () => {
    const s = shape(40, 40, 1);
    s.fill({}, Mat.Concrete);
    const mesh = meshShape(s);
    // Две большие грани плюс четыре торца.
    expect(mesh.quads).toBe(6);
  });

  it('внутренние грани не рисуются', () => {
    const s = shape(6, 6, 6);
    s.fill({}, Mat.Brick);
    const mesh = meshShape(s);
    expect(mesh.quads).toBe(6);
    expect(surfaceArea(mesh)).toBeCloseTo(6 * (6 * VS) ** 2, 6);
  });

  it('площадь поверхности совпадает с числом открытых граней', () => {
    const s = shape(8, 8, 8);
    s.fill({ x0: 1, x1: 7, y0: 1, y1: 7, z0: 1, z1: 7 }, Mat.Wood);
    s.set(3, 7, 3, Mat.Wood);
    const mesh = meshShape(s);
    let faces = 0;
    for (let y = 0; y < 8; y++) {
      for (let z = 0; z < 8; z++) {
        for (let x = 0; x < 8; x++) {
          if (s.get(x, y, z) === Mat.Air) continue;
          for (const [dx, dy, dz] of [
            [1, 0, 0],
            [-1, 0, 0],
            [0, 1, 0],
            [0, -1, 0],
            [0, 0, 1],
            [0, 0, -1],
          ]) {
            if (s.get(x + dx, y + dy, z + dz) === Mat.Air) faces++;
          }
        }
      }
    }
    expect(surfaceArea(mesh)).toBeCloseTo(faces * VS * VS, 6);
  });

  it('жадный меш экономнее наивного на порядок', () => {
    const s = shape(32, 32, 32);
    s.fill({}, Mat.Concrete);
    const mesh = meshShape(s);
    const naiveQuads = 6 * 32 * 32;
    expect(mesh.quads).toBeLessThan(naiveQuads / 100);
  });

  it('прозрачные и непрозрачные материалы мешатся раздельно', () => {
    const s = shape(6, 6, 6);
    s.fill({}, Mat.Concrete);
    s.fill({ x0: 2, x1: 4, y0: 2, y1: 4, z0: 0, z1: 1 }, Mat.Glass);
    const opaque = meshShape(s, { pass: 'opaque' });
    const glass = meshShape(s, { pass: 'transparent' });
    expect(opaque.quads).toBeGreaterThan(0);
    expect(glass.quads).toBeGreaterThan(0);
    // Стекло не должно попасть в непрозрачный проход и наоборот.
    expect(glass.positions.length).toBeLessThan(opaque.positions.length);
  });

  it('нормали единичные и направлены по осям', () => {
    const s = shape(4, 4, 4);
    s.set(2, 2, 2, Mat.Metal);
    const mesh = meshShape(s);
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const len = Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]);
      expect(len).toBeCloseTo(1, 6);
    }
  });

  it('затенение в углах делает вогнутый угол темнее плоскости', () => {
    const s = shape(8, 8, 8);
    s.fill({ y0: 0, y1: 1 }, Mat.Concrete);
    s.fill({ x0: 0, x1: 1, y0: 0, y1: 6 }, Mat.Concrete);
    const mesh = meshShape(s, { aoStrength: 0.6 });
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < mesh.colors.length; i += 3) {
      min = Math.min(min, mesh.colors[i]);
      max = Math.max(max, mesh.colors[i]);
    }
    expect(min).toBeLessThan(max);
  });

  it('краска перекрашивает воксель, не меняя геометрию', () => {
    const s = shape(6, 6, 6);
    s.fill({}, Mat.Concrete);
    const plain = meshShape(s);
    s.paint.set(s.idx(3, 5, 3), 0);
    const painted = meshShape(s);
    expect(painted.quads).toBeGreaterThan(plain.quads);
    expect(surfaceArea(painted)).toBeCloseTo(surfaceArea(plain), 6);
  });

  it('меш формы не выходит за её габариты', () => {
    const s = shape(5, 7, 3);
    s.fill({}, Mat.Brick);
    const mesh = meshShape(s);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      expect(mesh.positions[i]).toBeGreaterThanOrEqual(0);
      expect(mesh.positions[i]).toBeLessThanOrEqual(5 * VS + 1e-5);
      expect(mesh.positions[i + 1]).toBeLessThanOrEqual(7 * VS + 1e-5);
      expect(mesh.positions[i + 2]).toBeLessThanOrEqual(3 * VS + 1e-5);
    }
  });
});
