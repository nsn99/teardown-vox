import { Mat } from './materials.js';
import { VoxelRegion, VoxelShape } from './voxel-shape.js';

export interface VoxelBox {
  x0: number;
  y0: number;
  z0: number;
  /** Полуоткрытые границы. */
  x1: number;
  y1: number;
  z1: number;
}

export interface ColliderBox {
  /** Центр в локальных метрах формы. */
  cx: number;
  cy: number;
  cz: number;
  /** Полуразмеры в метрах. */
  hx: number;
  hy: number;
  hz: number;
}

export interface DecomposeOptions {
  /** Считать только этот кусок формы. По умолчанию — всю форму. */
  region?: VoxelRegion;
  /** Максимум боксов. Дальше остаток покрывается крупной сеткой. */
  maxBoxes?: number;
  /** Учитывать только материалы, которые должны сталкиваться. */
  includes?: (mat: number) => boolean;
}

/**
 * Жадная декомпозиция вокселей в набор боксов.
 *
 * Rapier не умеет воксели, а тысяча кубиков-коллайдеров на один обломок
 * убивает солвер. Разбиение растёт по X, потом по Z, потом по Y — для
 * рукотворной геометрии (стены, ящики, балки) это даёт единицы боксов
 * там, где наивный подход дал бы сотни.
 */
export function decomposeToBoxes(
  shape: VoxelShape,
  opts: DecomposeOptions = {},
): VoxelBox[] {
  const maxBoxes = opts.maxBoxes ?? 4096;
  const include = opts.includes ?? ((m: number) => m !== Mat.Air);
  const { sx, sy, sz } = shape;
  // Границы куска: пересобирать коллайдеры всей формы из-за одного
  // задетого чанка — это и есть та самая просадка кадра на разрушении.
  const r = opts.region;
  const bx0 = r ? Math.max(0, r.x0) : 0;
  const by0 = r ? Math.max(0, r.y0) : 0;
  const bz0 = r ? Math.max(0, r.z0) : 0;
  const bx1 = r ? Math.min(sx, r.x1) : sx;
  const by1 = r ? Math.min(sy, r.y1) : sy;
  const bz1 = r ? Math.min(sz, r.z1) : sz;
  // Буфер занятости — по размеру куска, а не формы: при пересборке
  // коллайдеров по чанкам аллокация на всю форму съедала весь выигрыш.
  const rw = bx1 - bx0;
  const rh = by1 - by0;
  const rd = bz1 - bz0;
  if (rw <= 0 || rh <= 0 || rd <= 0) return [];
  const used = new Uint8Array(rw * rh * rd);
  const uidx = (x: number, y: number, z: number) =>
    ((y - by0) * rd + (z - bz0)) * rw + (x - bx0);
  const boxes: VoxelBox[] = [];

  const solid = (x: number, y: number, z: number): boolean =>
    !used[uidx(x, y, z)] && include(shape.data[shape.idx(x, y, z)]);

  for (let y = by0; y < by1; y++) {
    for (let z = bz0; z < bz1; z++) {
      for (let x = bx0; x < bx1; x++) {
        if (!solid(x, y, z)) continue;
        if (boxes.length >= maxBoxes) return boxes;

        // Растём по X.
        let x1 = x + 1;
        while (x1 < bx1 && solid(x1, y, z)) x1++;

        // Растём по Z, пока вся полоса [x, x1) свободна.
        let z1 = z + 1;
        outerZ: while (z1 < bz1) {
          for (let xi = x; xi < x1; xi++) {
            if (!solid(xi, y, z1)) break outerZ;
          }
          z1++;
        }

        // Растём по Y, пока весь прямоугольник свободен.
        let y1 = y + 1;
        outerY: while (y1 < by1) {
          for (let zi = z; zi < z1; zi++) {
            for (let xi = x; xi < x1; xi++) {
              if (!solid(xi, y1, zi)) break outerY;
            }
          }
          y1++;
        }

        for (let yi = y; yi < y1; yi++) {
          for (let zi = z; zi < z1; zi++) {
            for (let xi = x; xi < x1; xi++) {
              used[uidx(xi, yi, zi)] = 1;
            }
          }
        }
        boxes.push({ x0: x, y0: y, z0: z, x1, y1, z1 });
      }
    }
  }
  return boxes;
}

/** Боксы в метрах локального пространства формы — готовы для Rapier. */
export function boxesToColliders(shape: VoxelShape, boxes: VoxelBox[]): ColliderBox[] {
  const s = shape.voxelSize;
  return boxes.map((b) => ({
    cx: ((b.x0 + b.x1) / 2) * s,
    cy: ((b.y0 + b.y1) / 2) * s,
    cz: ((b.z0 + b.z1) / 2) * s,
    hx: ((b.x1 - b.x0) / 2) * s,
    hy: ((b.y1 - b.y0) / 2) * s,
    hz: ((b.z1 - b.z0) / 2) * s,
  }));
}

export function buildColliders(
  shape: VoxelShape,
  opts: DecomposeOptions = {},
): ColliderBox[] {
  return boxesToColliders(shape, decomposeToBoxes(shape, opts));
}

/**
 * Огрублённая декомпозиция: занятость считается по блокам factor³.
 *
 * Уровень целиком — это миллионы вокселей, и точные коллайдеры для него
 * не нужны: обломки должны на что-то падать, а не измерять микрорельеф
 * кирпичной кладки. Огрубление в четыре раза уменьшает число боксов на
 * два порядка при незаметной для игрока разнице.
 */
export function decomposeCoarse(
  shape: VoxelShape,
  factor: number,
  opts: DecomposeOptions = {},
): ColliderBox[] {
  if (factor <= 1) return buildColliders(shape, opts);
  const include = opts.includes ?? ((m: number) => m !== Mat.Air);
  const maxBoxes = opts.maxBoxes ?? 4096;

  const r = opts.region;
  const vy0 = r ? Math.max(0, r.y0) : 0;
  const vy1 = r ? Math.min(shape.sy, r.y1) : shape.sy;
  const vz0 = r ? Math.max(0, r.z0) : 0;
  const vz1 = r ? Math.min(shape.sz, r.z1) : shape.sz;
  const vx0 = r ? Math.max(0, r.x0) : 0;
  const vx1 = r ? Math.min(shape.sx, r.x1) : shape.sx;
  if (vx1 <= vx0 || vy1 <= vy0 || vz1 <= vz0) return [];

  // Грубая сетка строится только на куске — иначе на каждый чанк
  // выделялся бы массив по объёму всей формы.
  const gx0 = (vx0 / factor) | 0;
  const gy0 = (vy0 / factor) | 0;
  const gz0 = (vz0 / factor) | 0;
  const gx1 = Math.ceil(vx1 / factor);
  const gy1 = Math.ceil(vy1 / factor);
  const gz1 = Math.ceil(vz1 / factor);
  const cx = gx1 - gx0;
  const cy = gy1 - gy0;
  const cz = gz1 - gz0;
  const occ = new Uint8Array(cx * cy * cz);
  const cidx = (x: number, y: number, z: number) =>
    ((y - gy0) * cz + (z - gz0)) * cx + (x - gx0);

  for (let y = vy0; y < vy1; y++) {
    for (let z = vz0; z < vz1; z++) {
      const base = (y * shape.sz + z) * shape.sx;
      for (let x = vx0; x < vx1; x++) {
        if (!include(shape.data[base + x])) continue;
        occ[cidx((x / factor) | 0, (y / factor) | 0, (z / factor) | 0)] = 1;
      }
    }
  }

  // Жадная склейка по той же схеме, но на грубой сетке.
  const used = new Uint8Array(occ.length);
  const boxes: VoxelBox[] = [];
  const free = (x: number, y: number, z: number) => {
    const i = cidx(x, y, z);
    return occ[i] === 1 && used[i] === 0;
  };

  const cby0 = gy0;
  const cby1 = gy1;
  const cbz0 = gz0;
  const cbz1 = gz1;
  const cbx0 = gx0;
  const cbx1 = gx1;

  for (let y = cby0; y < cby1; y++) {
    for (let z = cbz0; z < cbz1; z++) {
      for (let x = cbx0; x < cbx1; x++) {
        if (!free(x, y, z)) continue;
        if (boxes.length >= maxBoxes) break;
        let x1 = x + 1;
        while (x1 < cbx1 && free(x1, y, z)) x1++;
        let z1 = z + 1;
        outerZ: while (z1 < cbz1) {
          for (let xi = x; xi < x1; xi++) if (!free(xi, y, z1)) break outerZ;
          z1++;
        }
        let y1 = y + 1;
        outerY: while (y1 < cby1) {
          for (let zi = z; zi < z1; zi++) {
            for (let xi = x; xi < x1; xi++) if (!free(xi, y1, zi)) break outerY;
          }
          y1++;
        }
        for (let yi = y; yi < y1; yi++) {
          for (let zi = z; zi < z1; zi++) {
            for (let xi = x; xi < x1; xi++) used[cidx(xi, yi, zi)] = 1;
          }
        }
        boxes.push({ x0: x, y0: y, z0: z, x1, y1, z1 });
      }
    }
  }

  const s = shape.voxelSize * factor;
  return boxes.map((b) => ({
    cx: ((b.x0 + b.x1) / 2) * s,
    cy: ((b.y0 + b.y1) / 2) * s,
    cz: ((b.z0 + b.z1) / 2) * s,
    hx: ((b.x1 - b.x0) / 2) * s,
    hy: ((b.y1 - b.y0) / 2) * s,
    hz: ((b.z1 - b.z0) / 2) * s,
  }));
}
