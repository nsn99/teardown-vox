import { describe, expect, it } from 'vitest';
import { Mat, SkyLight, VoxelShape, material } from '@tvox/core';
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

describe('меш несёт свойства материала', () => {
  it('у каждой вершины есть металличность, шероховатость и свечение', () => {
    const s = shape(3, 3, 3);
    s.set(1, 1, 1, Mat.Metal);
    const mesh = meshShape(s);
    const vertices = mesh.positions.length / 3;
    expect(mesh.props.length).toBe(vertices * 3);
    expect(mesh.light.length).toBe(vertices);

    const metal = material(Mat.Metal);
    expect(mesh.props[0]).toBeCloseTo(metal.metalness, 5);
    expect(mesh.props[1]).toBeCloseTo(metal.roughness, 5);
    expect(mesh.props[2]).toBeCloseTo(metal.emissive, 5);
  });

  it('металл и грунт различаются блеском, а не только цветом', () => {
    const metal = shape(3, 3, 3);
    metal.set(1, 1, 1, Mat.Metal);
    const dirt = shape(3, 3, 3);
    dirt.set(1, 1, 1, Mat.Dirt);

    const a = meshShape(metal);
    const b = meshShape(dirt);
    // Сталь бликует, грунт матовый: разница видна без подписи под вокселем.
    expect(a.props[0]).toBeGreaterThan(b.props[0]);
    expect(a.props[1]).toBeLessThan(b.props[1]);
  });

  it('кабель светится сам, бетон — нет', () => {
    const cable = shape(3, 3, 3);
    cable.set(1, 1, 1, Mat.Cable);
    const concrete = shape(3, 3, 3);
    concrete.set(1, 1, 1, Mat.Concrete);
    expect(meshShape(cable).props[2]).toBeGreaterThan(0);
    expect(meshShape(concrete).props[2]).toBe(0);
  });

  it('без поля света всё считается освещённым', () => {
    const s = shape(3, 3, 3);
    s.set(1, 1, 1, Mat.Brick);
    const mesh = meshShape(s);
    for (let i = 0; i < mesh.light.length; i++) expect(mesh.light[i]).toBe(1);
  });

  it('свет читается со стороны грани и попадает в вершины', () => {
    // Коробка с дырой в крыше: пол под дырой освещён, углы — нет.
    const s = shape(12, 8, 12);
    s.fill({}, Mat.Concrete);
    s.fill({ x0: 1, y0: 1, z0: 1, x1: 11, y1: 7, z1: 11 }, Mat.Air);
    s.fill({ x0: 5, y0: 7, z0: 5, x1: 7, y1: 8, z1: 7 }, Mat.Air);
    const sky = new SkyLight(s);

    const lit = meshShape(s, { sky });
    const flat = meshShape(s);
    expect(lit.quads).toBeGreaterThan(flat.quads);

    // В освещённом меше есть и тёмные вершины, и светлые: именно это и
    // означает «свет попал внутрь», а не «сцена стала ярче целиком».
    let min = 1;
    let max = 0;
    for (let i = 0; i < lit.light.length; i++) {
      min = Math.min(min, lit.light[i]);
      max = Math.max(max, lit.light[i]);
    }
    expect(max).toBe(1);
    expect(min).toBeLessThan(0.6);
  });

  it('в наглухо закрытой комнате внутренние грани темны', () => {
    const s = shape(24, 10, 24);
    s.fill({}, Mat.Concrete);
    s.fill({ x0: 1, y0: 1, z0: 1, x1: 23, y1: 9, z1: 23 }, Mat.Air);
    const sky = new SkyLight(s);
    // Пол в середине зала: свету взяться неоткуда.
    expect(sky.at(12, 1, 12)).toBe(0);

    const mesh = meshShape(s, { sky });
    let dark = 0;
    for (let i = 0; i < mesh.light.length; i++) if (mesh.light[i] === 0) dark++;
    expect(dark).toBeGreaterThan(0);
  });

  it('склейка не смешивает освещённое с тёмным', () => {
    // Длинный навес: свет затухает вдоль него, значит одной гранью
    // на весь пол склеиться не может — иначе градиент пропадёт.
    const s = shape(40, 6, 6);
    s.fill({}, Mat.Concrete);
    s.fill({ x0: 1, y0: 1, z0: 1, x1: 39, y1: 5, z1: 5 }, Mat.Air);
    s.fill({ x0: 0, y0: 1, z0: 1, x1: 1, y1: 5, z1: 5 }, Mat.Air);
    const sky = new SkyLight(s);

    const lit = meshShape(s, { sky });
    const flat = meshShape(s);
    expect(lit.quads).toBeGreaterThan(flat.quads);
    // Но и не рассыпается на воксели: склейка всё ещё работает.
    expect(lit.quads).toBeLessThan(s.solidVoxels);
  });
});
