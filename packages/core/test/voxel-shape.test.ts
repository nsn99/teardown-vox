import { describe, expect, it } from 'vitest';
import {
  Mat,
  VoxelShape,
  decodeRle,
  emptyRegion,
  encodeRle,
  material,
  quatFromAxisAngle,
  regionIsEmpty,
  regionUnion,
  transformPoint,
  v3,
  voxelMass,
} from '@tvox/core';
import { makeShape } from './helpers.js';

describe('VoxelShape: базовые операции', () => {
  it('отвергает некорректные размеры', () => {
    expect(() => new VoxelShape({ sx: 0, sy: 1, sz: 1 })).toThrow(RangeError);
    expect(() => new VoxelShape({ sx: 1.5, sy: 1, sz: 1 })).toThrow(RangeError);
    expect(() => new VoxelShape({ sx: 1, sy: -2, sz: 1 })).toThrow(RangeError);
  });

  it('idx и coords взаимно обратны на всём объёме', () => {
    const s = makeShape(5, 3, 7);
    for (let y = 0; y < 3; y++) {
      for (let z = 0; z < 7; z++) {
        for (let x = 0; x < 5; x++) {
          const i = s.idx(x, y, z);
          const c = s.coords(i);
          expect([c.x, c.y, c.z]).toEqual([x, y, z]);
        }
      }
    }
  });

  it('за границами читается воздух, запись игнорируется', () => {
    const s = makeShape(4, 4, 4);
    expect(s.get(-1, 0, 0)).toBe(Mat.Air);
    expect(s.get(4, 0, 0)).toBe(Mat.Air);
    expect(s.set(9, 9, 9, Mat.Wood)).toBe(false);
    expect(s.solidVoxels).toBe(0);
  });

  it('счётчик непустых вокселей держится инкрементально', () => {
    const s = makeShape(4, 4, 4);
    s.set(1, 1, 1, Mat.Wood);
    s.set(2, 1, 1, Mat.Wood);
    expect(s.solidVoxels).toBe(2);
    s.set(2, 1, 1, Mat.Metal);
    expect(s.solidVoxels).toBe(2);
    s.set(2, 1, 1, Mat.Air);
    expect(s.solidVoxels).toBe(1);
    expect(s.set(2, 1, 1, Mat.Air)).toBe(false);
  });

  it('fill заполняет и обрезается по границам', () => {
    const s = makeShape(4, 4, 4);
    const n = s.fill({ x0: -5, x1: 100, y0: 0, y1: 1, z0: 0, z1: 4 }, Mat.Concrete);
    expect(n).toBe(16);
    expect(s.solidVoxels).toBe(16);
  });

  it('смена материала обнуляет накопленный урон', () => {
    const s = makeShape(2, 2, 2);
    s.set(0, 0, 0, Mat.Wood);
    s.damage[s.idx(0, 0, 0)] = 30;
    s.set(0, 0, 0, Mat.Metal);
    expect(s.damage[s.idx(0, 0, 0)]).toBe(0);
  });

  it('удаление вокселя стирает краску', () => {
    const s = makeShape(2, 2, 2);
    s.set(0, 0, 0, Mat.Wood);
    s.paint.set(s.idx(0, 0, 0), 3);
    s.setAt(s.idx(0, 0, 0), Mat.Air);
    expect(s.paint.size).toBe(0);
  });

  it('recountSolid чинит счётчик после прямой записи в data', () => {
    const s = makeShape(3, 3, 3);
    s.data[0] = Mat.Wood;
    s.data[1] = Mat.Wood;
    expect(s.solidVoxels).toBe(0);
    expect(s.recountSolid()).toBe(2);
    expect(s.solidVoxels).toBe(2);
  });
});

describe('VoxelShape: геометрия', () => {
  it('центр вокселя смещён на полразмера', () => {
    const s = makeShape(4, 4, 4);
    const c = s.voxelCenterLocal(0, 0, 0);
    expect(c).toEqual(v3(0.05, 0.05, 0.05));
  });

  it('worldToVoxel обратно voxelCenterWorld', () => {
    const s = makeShape(8, 8, 8);
    s.transform = { position: v3(3, 1, -2), rotation: quatFromAxisAngle(v3(0, 1, 0), 0.7) };
    const p = s.voxelCenterWorld(5, 2, 6);
    const back = s.worldToVoxel(p);
    expect([back.x, back.y, back.z]).toEqual([5, 2, 6]);
  });

  it('AABB учитывает трансформ формы', () => {
    const s = makeShape(10, 10, 10);
    s.transform = { position: v3(5, 0, 0), rotation: { x: 0, y: 0, z: 0, w: 1 } };
    const box = s.localAabb();
    expect(box.min.x).toBeCloseTo(5);
    expect(box.max.x).toBeCloseTo(6);
  });

  it('масса равна плотности на объём', () => {
    const s = makeShape(2, 2, 2);
    s.set(0, 0, 0, Mat.Concrete);
    expect(s.mass()).toBeCloseTo(voxelMass(Mat.Concrete, 0.1), 9);
    expect(s.mass()).toBeCloseTo(2400 * 0.001, 9);
  });

  it('центр масс симметричной фигуры лежит в её середине', () => {
    const s = makeShape(4, 1, 1);
    s.fill({ x0: 0, x1: 4, y0: 0, y1: 1, z0: 0, z1: 1 }, Mat.Wood);
    const com = s.centerOfMass();
    expect(com.x).toBeCloseTo(0.2, 9);
  });

  it('центр масс пустой формы — ноль', () => {
    expect(makeShape(2, 2, 2).centerOfMass()).toEqual(v3());
  });

  it('плотные границы возвращают только занятую область', () => {
    const s = makeShape(10, 10, 10);
    s.set(3, 4, 5, Mat.Wood);
    s.set(6, 4, 5, Mat.Wood);
    expect(s.solidBounds()).toEqual({ x0: 3, y0: 4, z0: 5, x1: 7, y1: 5, z1: 6 });
    expect(makeShape(2, 2, 2).solidBounds()).toBeNull();
  });

  it('клон независим от оригинала', () => {
    const s = makeShape(3, 3, 3);
    s.set(1, 1, 1, Mat.Wood);
    s.paint.set(s.idx(1, 1, 1), 2);
    const c = s.clone();
    c.set(1, 1, 1, Mat.Air);
    expect(s.get(1, 1, 1)).toBe(Mat.Wood);
    expect(c.solidVoxels).toBe(0);
  });
});

describe('грязные области', () => {
  it('пустая область помечена как пустая', () => {
    expect(regionIsEmpty(emptyRegion())).toBe(true);
  });

  it('запись расширяет обе грязные области', () => {
    const s = makeShape(8, 8, 8);
    s.set(2, 3, 4, Mat.Wood);
    expect(s.dirtyMesh).toEqual({ x0: 2, y0: 3, z0: 4, x1: 3, y1: 4, z1: 5 });
    expect(regionIsEmpty(s.dirtyStructure)).toBe(false);
    s.clearMeshDirty();
    expect(regionIsEmpty(s.dirtyMesh)).toBe(true);
    s.clearStructureDirty();
    expect(regionIsEmpty(s.dirtyStructure)).toBe(true);
  });

  it('объединение областей', () => {
    const a = { x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 };
    const b = { x0: 5, y0: 5, z0: 5, x1: 6, y1: 6, z1: 6 };
    expect(regionUnion(a, b)).toEqual({ x0: 0, y0: 0, z0: 0, x1: 6, y1: 6, z1: 6 });
    expect(regionUnion(a, emptyRegion())).toBe(a);
    expect(regionUnion(emptyRegion(), b)).toEqual(b);
  });
});

describe('сериализация', () => {
  it('RLE переживает круговой рейс', () => {
    const src = new Uint8Array([0, 0, 0, 5, 5, 1, 0]);
    const out = new Uint8Array(src.length);
    decodeRle(encodeRle(src), out);
    expect([...out]).toEqual([...src]);
  });

  it('пустой массив кодируется в пустой RLE', () => {
    expect(encodeRle(new Uint8Array(0))).toEqual([]);
  });

  it('RLE длиннее буфера отвергается', () => {
    expect(() => decodeRle([1, 100], new Uint8Array(4))).toThrow(RangeError);
  });

  it('RLE короче буфера отвергается', () => {
    expect(() => decodeRle([1, 2], new Uint8Array(8))).toThrow(RangeError);
  });

  it('форма переживает круговой рейс через JSON', () => {
    const s = makeShape(6, 4, 5);
    s.fill({ x0: 1, x1: 4, y0: 0, y1: 2, z0: 2, z1: 3 }, Mat.Brick);
    s.transform = { position: v3(1, 2, 3), rotation: quatFromAxisAngle(v3(0, 1, 0), 0.5) };
    const back = VoxelShape.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
    expect(back.solidVoxels).toBe(s.solidVoxels);
    expect([...back.data]).toEqual([...s.data]);
    expect(back.transform.position).toEqual(s.transform.position);
    expect(transformPoint(back.transform, v3(0, 0, 0)).x).toBeCloseTo(1);
  });
});

describe('таблица материалов', () => {
  it('в таблице нет дыр и каждый материал знает своё имя', () => {
    expect(material(Mat.Wood).name).toBe('wood');
    expect(material(Mat.Air).density).toBe(0);
  });

  it('неизвестный материал — ошибка', () => {
    expect(() => material(200)).toThrow(RangeError);
  });

  it('фундамент неразрушим и якорит', () => {
    const f = material(Mat.Foundation);
    expect(f.indestructible).toBe(true);
    expect(f.anchor).toBe(true);
  });

  it('металл прочнее дерева, дерево горит, металл нет', () => {
    expect(material(Mat.Metal).toughness).toBeGreaterThan(material(Mat.Wood).toughness);
    expect(material(Mat.Wood).flammability).toBeGreaterThan(0);
    expect(material(Mat.Metal).flammability).toBe(0);
  });
});
