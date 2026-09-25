import { SKY_MAX, VoxelRegion } from '@tvox/core';
import { MeshData, MeshSource, SkyLightSource, meshShape } from './mesher.js';

/**
 * Кусок формы для меширования в стороне от главного потока.
 *
 * В воркер нельзя отправить `VoxelShape`: у склада миллионы вокселей, а
 * перестраивается один чанк из тысячи. Поэтому режем ровно то, что нужно
 * мешеру, — регион чанка плюс поле в один воксель со всех сторон.
 *
 * Поле именно в один воксель, и это не запас «на всякий случай». Мешер
 * заглядывает за границу региона в трёх местах: закрыта ли грань соседом,
 * твёрдый ли угол для затенения, сколько света в воздухе перед гранью.
 * Дальше чем на воксель он не смотрит нигде. Возьми поле в ноль — на швах
 * чанков полезут лишние грани и склад засветится изнутри; возьми в два —
 * заплатишь вдвое за копирование и не получишь ничего.
 */
export interface ChunkSlice {
  /** Размеры куска вместе с полем. */
  sx: number;
  sy: number;
  sz: number;
  voxelSize: number;
  /** Материалы куска в раскладке формы: (y*sz + z)*sx + x. */
  data: Uint8Array;
  damage: Uint16Array;
  /** Небесный свет того же куска. Вне формы — открытое небо. */
  sky: Uint8Array;
  /** Разреженная краска: индексы внутри куска и номера цветов. */
  paintIndex: Uint32Array;
  paintValue: Uint32Array;
  /** Что именно мешить, в координатах куска. */
  region: VoxelRegion;
  /** Непустых вокселей в регионе — чтобы пустой не мешить вовсе. */
  solid: number;
}

/** Буферы куска: их отдают воркеру во владение, а не копируют ещё раз. */
export function sliceBuffers(slice: ChunkSlice): ArrayBufferLike[] {
  return [slice.data.buffer, slice.damage.buffer, slice.sky.buffer, slice.paintIndex.buffer, slice.paintValue.buffer];
}

/**
 * Вырезать чанк формы вместе с полем.
 * Регион задаётся в координатах формы; в куске он смещается на поле.
 */
export function sliceChunk(
  shape: MeshSource,
  region: VoxelRegion,
  sky: SkyLightSource | undefined,
): ChunkSlice {
  const ox = region.x0 - 1;
  const oy = region.y0 - 1;
  const oz = region.z0 - 1;
  const sx = region.x1 - region.x0 + 2;
  const sy = region.y1 - region.y0 + 2;
  const sz = region.z1 - region.z0 + 2;

  const data = new Uint8Array(sx * sy * sz);
  const damage = new Uint16Array(data.length);
  const skyData = new Uint8Array(sx * sy * sz);
  let solid = 0;

  for (let y = 0; y < sy; y++) {
    const wy = oy + y;
    const inY = wy >= 0 && wy < shape.sy;
    for (let z = 0; z < sz; z++) {
      const wz = oz + z;
      const inYZ = inY && wz >= 0 && wz < shape.sz;
      const row = (y * sz + z) * sx;
      // Строка без единого твёрдого вокселя — обычное дело внутри полой
      // коробки склада, и копировать её по одному вокселю незачем.
      const rowSolid = inYZ ? shape.solidInRow(wy, wz) : 0;
      for (let x = 0; x < sx; x++) {
        const wx = ox + x;
        const inside = inYZ && wx >= 0 && wx < shape.sx;
        // Вне формы — воздух и открытое небо: ровно так же, как отвечают
        // сама форма и её карта света за своими границами.
        if (!inside) {
          skyData[row + x] = SKY_MAX;
          continue;
        }
        const m = rowSolid === 0 ? 0 : shape.data[shape.idx(wx, wy, wz)];
        data[row + x] = m;
        damage[row + x] = shape.damage?.[shape.idx(wx, wy, wz)] ?? 0;
        skyData[row + x] = sky ? sky.at(wx, wy, wz) : SKY_MAX;
        if (
          m !== 0 &&
          x > 0 && x < sx - 1 &&
          y > 0 && y < sy - 1 &&
          z > 0 && z < sz - 1
        ) {
          solid++;
        }
      }
    }
  }

  // Краска разрежена: крашеных вокселей на карте единицы, а не миллионы.
  // Идём по самому слою, а не по всем клеткам куска.
  const paintIndex: number[] = [];
  const paintValue: number[] = [];
  if (shape.paint.size > 0) {
    shape.paint.forEach((value, index) => {
      const wx = index % shape.sx;
      const t = (index - wx) / shape.sx;
      const wz = t % shape.sz;
      const wy = (t - wz) / shape.sz;
      const x = wx - ox;
      const y = wy - oy;
      const z = wz - oz;
      if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return;
      paintIndex.push((y * sz + z) * sx + x);
      paintValue.push(value);
    });
  }

  return {
    sx,
    sy,
    sz,
    voxelSize: shape.voxelSize,
    data,
    damage,
    sky: skyData,
    paintIndex: Uint32Array.from(paintIndex),
    paintValue: Uint32Array.from(paintValue),
    region: {
      x0: region.x0 - ox,
      y0: region.y0 - oy,
      z0: region.z0 - oz,
      x1: region.x1 - ox,
      y1: region.y1 - oy,
      z1: region.z1 - oz,
    },
    solid,
  };
}

/**
 * Вырезанный кусок в том виде, в каком его понимает мешер.
 *
 * Ускорители по строкам и слоям считаются здесь заново: на кусок 34³ это
 * микросекунды, а без них мешер шесть раз пройдёт по пустоте, которой в
 * полой коробке большинство.
 */
export class ChunkView implements MeshSource {
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly voxelSize: number;
  readonly data: Uint8Array;
  readonly damage: Uint16Array;
  readonly paint = new Map<number, number>();
  private readonly skyData: Uint8Array;
  private readonly rowSolid: Uint32Array;
  private readonly layerSolid: Uint32Array;
  private readonly bounds: VoxelRegion;
  private readonly solid: number;

  constructor(slice: ChunkSlice) {
    this.sx = slice.sx;
    this.sy = slice.sy;
    this.sz = slice.sz;
    this.voxelSize = slice.voxelSize;
    this.data = slice.data;
    this.damage = slice.damage;
    this.skyData = slice.sky;
    this.bounds = slice.region;
    this.solid = slice.solid;
    for (let i = 0; i < slice.paintIndex.length; i++) {
      this.paint.set(slice.paintIndex[i], slice.paintValue[i]);
    }

    this.rowSolid = new Uint32Array(this.sy * this.sz);
    this.layerSolid = new Uint32Array(this.sy);
    for (let y = 0; y < this.sy; y++) {
      for (let z = 0; z < this.sz; z++) {
        const row = (y * this.sz + z) * this.sx;
        let n = 0;
        for (let x = 0; x < this.sx; x++) if (this.data[row + x] !== 0) n++;
        this.rowSolid[y * this.sz + z] = n;
        this.layerSolid[y] += n;
      }
    }
  }

  idx(x: number, y: number, z: number): number {
    return (y * this.sz + z) * this.sx + x;
  }

  /** В куске ровно один чанк — тот, ради которого его и вырезали. */
  chunkIndexAt(): number {
    return 0;
  }

  chunkBounds(): VoxelRegion {
    return this.bounds;
  }

  solidInChunk(): number {
    return this.solid;
  }

  solidInLayer(y: number): number {
    return y >= 0 && y < this.sy ? this.layerSolid[y] : 0;
  }

  solidInRow(y: number, z: number): number {
    if (y < 0 || y >= this.sy || z < 0 || z >= this.sz) return 0;
    return this.rowSolid[y * this.sz + z];
  }

  /** Свет куска. За его пределами — открытое небо, как и у формы. */
  get sky(): SkyLightSource {
    return {
      at: (x: number, y: number, z: number): number => {
        if (x < 0 || y < 0 || z < 0 || x >= this.sx || y >= this.sy || z >= this.sz) return SKY_MAX;
        return this.skyData[this.idx(x, y, z)];
      },
    };
  }
}

/** Оба прохода по вырезанному куску — то, что делает воркер. */
export function meshSlice(
  slice: ChunkSlice,
  aoStrength: number,
): { opaque: MeshData; transparent: MeshData } {
  const view = new ChunkView(slice);
  const common = {
    region: view.chunkBounds(),
    originAtRegion: true,
    aoStrength,
    sky: view.sky,
  };
  return {
    opaque: meshShape(view, { ...common, pass: 'opaque' as const }),
    transparent: meshShape(view, { ...common, pass: 'transparent' as const }),
  };
}

/** Буферы готового меша — их тоже отдают, а не копируют. */
export function meshBuffers(m: MeshData): ArrayBufferLike[] {
  return [m.positions.buffer, m.normals.buffer, m.colors.buffer, m.props.buffer, m.light.buffer, m.indices.buffer];
}
