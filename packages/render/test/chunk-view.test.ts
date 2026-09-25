import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, Mat, SkyLight, VoxelShape } from '@tvox/core';
import { ChunkView, meshShape, meshSlice, sliceChunk } from '@tvox/render';

/**
 * Кусок формы против самой формы.
 *
 * Весь смысл выноса ремеша в воркер держится на одном допущении: чанк,
 * смешенный по вырезанному куску, обязан быть в точности тем же, что и
 * чанк, смешенный по всей форме. Если это не так, швы между чанками
 * разъедутся, а внутри склада появится свет ниоткуда — и увидит это не
 * тест, а игрок.
 *
 * Поэтому сравнение здесь побайтовое, а не «примерно похоже».
 */

/** Кусок порта в миниатюре: стены, окно, дыра, крашеная полоса. */
function warehouse(): VoxelShape {
  const s = new VoxelShape({ sx: 70, sy: 40, sz: 70, voxelSize: 0.1, name: 'склад' });
  s.fill({ x0: 0, y0: 0, z0: 0, x1: 70, y1: 2, z1: 70 }, Mat.Concrete);
  s.fill({ x0: 4, y0: 2, z0: 4, x1: 66, y1: 30, z1: 66 }, Mat.Brick);
  s.fill({ x0: 6, y0: 2, z0: 6, x1: 64, y1: 28, z1: 64 }, Mat.Air);
  // Окно на всю стену — прозрачный проход должен попасть во второй проход.
  s.fill({ x0: 20, y0: 10, z0: 4, x1: 40, y1: 20, z1: 6 }, Mat.Glass);
  // Дыра в крыше: под ней небесный свет ложится совсем иначе.
  s.fill({ x0: 30, y0: 26, z0: 30, x1: 38, y1: 32, z1: 38 }, Mat.Air);
  // Деревянные балки и крашеная полоса вдоль них.
  for (let x = 8; x < 62; x += 8) {
    s.fill({ x0: x, y0: 26, z0: 6, x1: x + 2, y1: 28, z1: 64 }, Mat.Plank);
    for (let z = 6; z < 64; z++) s.paint.set(s.idx(x, 27, z), (x / 8) % 4);
  }
  return s;
}

/** Все чанки формы, в которых вообще что-то есть. */
function chunksOf(s: VoxelShape): number[] {
  const out: number[] = [];
  for (let c = 0; c < s.chunkCount; c++) if (s.solidInChunk(c) > 0) out.push(c);
  return out;
}

describe('вырезанный кусок формы', () => {
  it('вмятины металла и деформация пластика сохраняются в воркере', () => {
    const s = new VoxelShape({sx: 4, sy: 4, sz: 1, voxelSize: 0.1});
    s.fill({}, Mat.Metal);
    s.set(2, 2, 0, Mat.Plastic);
    s.damage[s.idx(1, 1, 0)] = 100;
    s.damage[s.idx(2, 2, 0)] = 15;
    const direct = meshShape(s);
    const worker = meshSlice(sliceChunk(s, s.chunkBounds(0), undefined), 0.35).opaque;
    expect([...worker.positions]).toEqual([...direct.positions]);
    expect([...worker.colors]).toEqual([...direct.colors]);
    expect([...direct.positions].some(n => n > 0 && n < 0.02)).toBe(true);
    expect(s.solidVoxels).toBe(16);
  });
  const shape = warehouse();
  const sky = new SkyLight(shape);
  sky.bake();
  const chunks = chunksOf(shape);

  it('на карте есть что сравнивать', () => {
    expect(chunks.length).toBeGreaterThan(8);
    expect(shape.paint.size).toBeGreaterThan(0);
  });

  it('меш по куску совпадает с мешем по форме до байта', () => {
    for (const c of chunks) {
      const region = shape.chunkBounds(c);
      const common = { region, originAtRegion: true, aoStrength: 0.35, sky };
      const direct = {
        opaque: meshShape(shape, { ...common, pass: 'opaque' as const }),
        transparent: meshShape(shape, { ...common, pass: 'transparent' as const }),
      };
      const viaSlice = meshSlice(sliceChunk(shape, region, sky), 0.35);

      for (const pass of ['opaque', 'transparent'] as const) {
        const a = direct[pass];
        const b = viaSlice[pass];
        expect(`${pass}@${c}: ${b.quads}`).toBe(`${pass}@${c}: ${a.quads}`);
        expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
        expect(Array.from(b.normals)).toEqual(Array.from(a.normals));
        expect(Array.from(b.colors)).toEqual(Array.from(a.colors));
        expect(Array.from(b.props)).toEqual(Array.from(a.props));
        expect(Array.from(b.light)).toEqual(Array.from(a.light));
        expect(Array.from(b.indices)).toEqual(Array.from(a.indices));
      }
    }
  });

  it('края формы режутся так же, как углы внутри', () => {
    // Угловой чанк: половина его поля лежит за пределами формы, и если бы
    // там оказался не воздух, на внешней стене пропали бы грани.
    const corner = shape.chunkIndexAt(0, 0, 0);
    const region = shape.chunkBounds(corner);
    const direct = meshShape(shape, { region, originAtRegion: true, aoStrength: 0.35, sky, pass: 'opaque' });
    const sliced = meshSlice(sliceChunk(shape, region, sky), 0.35).opaque;
    expect(sliced.quads).toBe(direct.quads);
    expect(Array.from(sliced.positions)).toEqual(Array.from(direct.positions));
  });

  it('кусок несёт только свою краску, а не весь слой формы', () => {
    const region = shape.chunkBounds(shape.chunkIndexAt(8, 27, 10));
    const slice = sliceChunk(shape, region, sky);
    expect(slice.paintIndex.length).toBeGreaterThan(0);
    expect(slice.paintIndex.length).toBeLessThan(shape.paint.size);
    const view = new ChunkView(slice);
    expect(view.paint.size).toBe(slice.paintIndex.length);
  });

  it('пустой чанк режется в ничто и не мешится', () => {
    const air = new VoxelShape({ sx: 64, sy: 64, sz: 64, voxelSize: 0.1 });
    const region = air.chunkBounds(air.chunkIndexAt(0, 0, 0));
    const slice = sliceChunk(air, region, undefined);
    expect(slice.solid).toBe(0);
    expect(meshSlice(slice, 0.35).opaque.quads).toBe(0);
  });

  it('поле куска — ровно один воксель со всех сторон', () => {
    const region = shape.chunkBounds(shape.chunkIndexAt(35, 10, 35));
    const slice = sliceChunk(shape, region, sky);
    expect(slice.sx).toBe(region.x1 - region.x0 + 2);
    expect(slice.sy).toBe(region.y1 - region.y0 + 2);
    expect(slice.sz).toBe(region.z1 - region.z0 + 2);
    // И размер куска не зависит от размера формы — ради этого всё и
    // затевалось. Тот же чанк из формы вдесятеро больше весит столько же:
    // в воркер уезжает чанк, а не склад.
    const big = new VoxelShape({ sx: 300, sy: 120, sz: 300, voxelSize: 0.1 });
    big.fill({ x0: 32, y0: 0, z0: 32, x1: 96, y1: 64, z1: 96 }, Mat.Brick);
    const fromBig = sliceChunk(big, big.chunkBounds(big.chunkIndexAt(35, 10, 35)), undefined);
    expect(fromBig.data.length).toBe(slice.data.length);
    expect(slice.data.length * 50).toBeLessThan(big.data.length);
    expect(slice.region).toEqual({
      x0: 1,
      y0: 1,
      z0: 1,
      x1: region.x1 - region.x0 + 1,
      y1: region.y1 - region.y0 + 1,
      z1: region.z1 - region.z0 + 1,
    });
    expect(CHUNK_SIZE).toBeGreaterThan(0);
  });

  it('свет за краем куска — открытое небо, как и у формы', () => {
    const region = shape.chunkBounds(shape.chunkIndexAt(35, 35, 35));
    const view = new ChunkView(sliceChunk(shape, region, sky));
    expect(view.sky.at(-1, 0, 0)).toBe(15);
    expect(view.sky.at(view.sx, 0, 0)).toBe(15);
  });
});
