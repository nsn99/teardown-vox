import { Mat } from './materials.js';
import { VoxelShape } from './voxel-shape.js';

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
  const used = new Uint8Array(sx * sy * sz);
  const boxes: VoxelBox[] = [];

  const solid = (x: number, y: number, z: number): boolean => {
    const i = shape.idx(x, y, z);
    return !used[i] && include(shape.data[i]);
  };

  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        if (!solid(x, y, z)) continue;
        if (boxes.length >= maxBoxes) return boxes;

        // Растём по X.
        let x1 = x + 1;
        while (x1 < sx && solid(x1, y, z)) x1++;

        // Растём по Z, пока вся полоса [x, x1) свободна.
        let z1 = z + 1;
        outerZ: while (z1 < sz) {
          for (let xi = x; xi < x1; xi++) {
            if (!solid(xi, y, z1)) break outerZ;
          }
          z1++;
        }

        // Растём по Y, пока весь прямоугольник свободен.
        let y1 = y + 1;
        outerY: while (y1 < sy) {
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
              used[shape.idx(xi, yi, zi)] = 1;
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

  const cx = Math.ceil(shape.sx / factor);
  const cy = Math.ceil(shape.sy / factor);
  const cz = Math.ceil(shape.sz / factor);
  const occ = new Uint8Array(cx * cy * cz);
  const cidx = (x: number, y: number, z: number) => (y * cz + z) * cx + x;

  for (let y = 0; y < shape.sy; y++) {
    for (let z = 0; z < shape.sz; z++) {
      const base = (y * shape.sz + z) * shape.sx;
      for (let x = 0; x < shape.sx; x++) {
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

  for (let y = 0; y < cy; y++) {
    for (let z = 0; z < cz; z++) {
      for (let x = 0; x < cx; x++) {
        if (!free(x, y, z)) continue;
        if (boxes.length >= maxBoxes) break;
        let x1 = x + 1;
        while (x1 < cx && free(x1, y, z)) x1++;
        let z1 = z + 1;
        outerZ: while (z1 < cz) {
          for (let xi = x; xi < x1; xi++) if (!free(xi, y, z1)) break outerZ;
          z1++;
        }
        let y1 = y + 1;
        outerY: while (y1 < cy) {
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
