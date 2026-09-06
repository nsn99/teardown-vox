import { Mat, MATERIALS, VoxelShape } from '@tvox/core';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  /** Сколько квадов получилось — метрика качества меширования. */
  quads: number;
}

export interface MeshOptions {
  /** Цвета для слоя краски. Индекс → [r,g,b] 0..255. */
  paintPalette?: ReadonlyArray<readonly [number, number, number]>;
  /** Сила затенения в углах, 0..1. */
  aoStrength?: number;
  /** Мешить только прозрачные материалы (стекло, вода) или только непрозрачные. */
  pass?: 'opaque' | 'transparent';
  /**
   * Мешить только часть формы (полуоткрытые границы). Соседи за пределами
   * региона всё равно учитываются: иначе на швах чанков вылезали бы
   * лишние грани, а сцена светилась бы изнутри.
   */
  region?: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number };
  /** Смещение вершин, чтобы меш чанка жил в системе координат формы. */
  originAtRegion?: boolean;
}

const DEFAULT_PAINT: ReadonlyArray<readonly [number, number, number]> = [
  [250, 96, 20],
  [40, 200, 120],
  [70, 150, 250],
  [250, 220, 60],
];

/** Смещения соседей по осям для шести направлений. */
const AXIS_U = [1, 2, 0];
const AXIS_V = [2, 0, 1];

const isTransparent = (mat: number): boolean => MATERIALS[mat].alpha < 1;

/**
 * Жадное меширование воксельной формы.
 *
 * Наивный «куб на воксель» на карте порта дал бы десятки миллионов
 * треугольников. Жадный алгоритм склеивает соседние одинаковые грани в один
 * прямоугольник, и сплошная стена 100×100 превращается в один квад.
 *
 * Затенение в углах (AO) входит в ключ склейки: два соседних квада с разным
 * затенением не сливаются, иначе на месте угла получилась бы плоская заливка.
 */
export function meshShape(shape: VoxelShape, opts: MeshOptions = {}): MeshData {
  const paint = opts.paintPalette ?? DEFAULT_PAINT;
  const aoStrength = opts.aoStrength ?? 0.35;
  const pass = opts.pass ?? 'opaque';
  const wantTransparent = pass === 'transparent';

  const dims = [shape.sx, shape.sy, shape.sz];
  const s = shape.voxelSize;
  const r = opts.region;
  const lo = [
    Math.max(0, r ? r.x0 : 0),
    Math.max(0, r ? r.y0 : 0),
    Math.max(0, r ? r.z0 : 0),
  ];
  const hi = [
    Math.min(dims[0], r ? r.x1 : dims[0]),
    Math.min(dims[1], r ? r.y1 : dims[1]),
    Math.min(dims[2], r ? r.z1 : dims[2]),
  ];
  const shift = opts.originAtRegion ? lo : [0, 0, 0];
  if (hi[0] <= lo[0] || hi[1] <= lo[1] || hi[2] <= lo[2]) {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      colors: new Float32Array(0),
      indices: new Uint32Array(0),
      quads: 0,
    };
  }

  // Пустой чанк не мешается вовсе: в полой коробке склада таких большинство,
  // а шесть проходов по 32³ клеткам стоят как настоящая работа.
  if (r && opts.originAtRegion) {
    const chunk = shape.chunkIndexAt(lo[0], lo[1], lo[2]);
    const bounds = shape.chunkBounds(chunk);
    if (
      bounds.x0 === lo[0] &&
      bounds.y0 === lo[1] &&
      bounds.z0 === lo[2] &&
      shape.solidInChunk(chunk) === 0
    ) {
      return {
        positions: new Float32Array(0),
        normals: new Float32Array(0),
        colors: new Float32Array(0),
        indices: new Uint32Array(0),
        quads: 0,
      };
    }
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let quads = 0;

  const visible = (x: number, y: number, z: number): number => {
    if (x < 0 || y < 0 || z < 0 || x >= shape.sx || y >= shape.sy || z >= shape.sz) return Mat.Air;
    const m = shape.data[shape.idx(x, y, z)];
    if (m === Mat.Air) return Mat.Air;
    return isTransparent(m) === wantTransparent ? m : Mat.Air;
  };

  /** Есть ли что-то, что закрывает грань со стороны соседа. */
  const occludes = (x: number, y: number, z: number): boolean => {
    if (x < 0 || y < 0 || z < 0 || x >= shape.sx || y >= shape.sy || z >= shape.sz) return false;
    const m = shape.data[shape.idx(x, y, z)];
    if (m === Mat.Air) return false;
    // Прозрачное не закрывает непрозрачное, но закрывает такое же прозрачное.
    return wantTransparent ? isTransparent(m) : !isTransparent(m);
  };

  const solidForAo = (x: number, y: number, z: number): boolean => {
    if (x < 0 || y < 0 || z < 0 || x >= shape.sx || y >= shape.sy || z >= shape.sz) return false;
    const m = shape.data[shape.idx(x, y, z)];
    return m !== Mat.Air && !isTransparent(m);
  };

  // Буфер цвета один на весь проход: массив на каждую видимую грань —
  // это десятки тысяч короткоживущих объектов на один чанк.
  const rgb = [0, 0, 0];
  const colorOf = (x: number, y: number, z: number, mat: number, ao: number): number[] => {
    const i = shape.idx(x, y, z);
    const painted = shape.paint.get(i);
    const base = painted !== undefined ? (paint[painted % paint.length] ?? paint[0]) : MATERIALS[mat].color;
    const shade = 1 - aoStrength * (1 - ao / 3);
    rgb[0] = (base[0] / 255) * shade;
    rgb[1] = (base[1] / 255) * shade;
    rgb[2] = (base[2] / 255) * shade;
    return rgb;
  };

  const pos = [0, 0, 0];
  const off = [0, 0, 0];

  for (let d = 0; d < 3; d++) {
    const u = AXIS_U[d];
    const v = AXIS_V[d];
    const w = hi[d];
    const hu = hi[u] - lo[u];
    const hv = hi[v] - lo[v];

    const maskMat = new Int32Array(hu * hv);
    const maskAo = new Int32Array(hu * hv);
    const maskCol = new Float32Array(hu * hv * 3);

    for (const dir of [-1, 1] as const) {

      for (let slice = lo[d]; slice < w; slice++) {
        // Слой без единого твёрдого вокселя граней не даёт.
        if (d === 1 && shape.solidInLayer(slice) === 0) continue;
        maskMat.fill(0);

        for (let j = 0; j < hv; j++) {
          for (let i = 0; i < hu; i++) {
            pos[d] = slice;
            pos[u] = lo[u] + i;
            pos[v] = lo[v] + j;
            // В строке (y,z) вообще нет твёрдых вокселей — значит и грани
            // здесь взяться неоткуда. Проверка дешевле, чем visible().
            if (shape.solidInRow(pos[1], pos[2]) === 0) continue;
            const mat = visible(pos[0], pos[1], pos[2]);
            if (mat === Mat.Air) continue;

            off[d] = slice + dir;
            off[u] = pos[u];
            off[v] = pos[v];
            if (occludes(off[0], off[1], off[2])) continue;

            const ao = cornerAo(pos, d, u, v, dir, solidForAo);
            const cell = j * hu + i;
            maskMat[cell] = mat;
            maskAo[cell] = ao.key;
            const c = colorOf(pos[0], pos[1], pos[2], mat, ao.mean);
            maskCol[cell * 3] = c[0];
            maskCol[cell * 3 + 1] = c[1];
            maskCol[cell * 3 + 2] = c[2];
          }
        }

        // Жадная склейка прямоугольников в маске.
        for (let j = 0; j < hv; j++) {
          for (let i = 0; i < hu; ) {
            const cell = j * hu + i;
            const mat = maskMat[cell];
            if (mat === 0) {
              i++;
              continue;
            }
            const aoKey = maskAo[cell];

            let wRun = 1;
            while (
              i + wRun < hu &&
              maskMat[cell + wRun] === mat &&
              maskAo[cell + wRun] === aoKey &&
              sameColor(maskCol, cell, cell + wRun)
            ) {
              wRun++;
            }

            let hRun = 1;
            outer: while (j + hRun < hv) {
              for (let k = 0; k < wRun; k++) {
                const c2 = (j + hRun) * hu + i + k;
                if (
                  maskMat[c2] !== mat ||
                  maskAo[c2] !== aoKey ||
                  !sameColor(maskCol, cell, c2)
                ) {
                  break outer;
                }
              }
              hRun++;
            }

            emitQuad(
              positions,
              normals,
              colors,
              indices,
              d,
              u,
              v,
              slice,
              i,
              j,
              wRun,
              hRun,
              dir,
              s,
              lo,
              shift,
              maskCol[cell * 3],
              maskCol[cell * 3 + 1],
              maskCol[cell * 3 + 2],
            );
            quads++;

            for (let dj = 0; dj < hRun; dj++) {
              for (let di = 0; di < wRun; di++) {
                maskMat[(j + dj) * hu + i + di] = 0;
              }
            }
            i += wRun;
          }
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
    quads,
  };
}

function sameColor(mask: Float32Array, a: number, b: number): boolean {
  return (
    mask[a * 3] === mask[b * 3] &&
    mask[a * 3 + 1] === mask[b * 3 + 1] &&
    mask[a * 3 + 2] === mask[b * 3 + 2]
  );
}

/**
 * Затенение в четырёх углах грани по классической воксельной схеме:
 * два соседа по краям и один по диагонали.
 */
/** Смещения углов грани: (du, dv) четырёх вершин. */
const AO_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/** Результат затенения — один на всё меширование: считается и сразу читается. */
const aoOut = { key: 0, mean: 0 };
const aoQ = [0, 0, 0];
const aoCorners = [0, 0, 0, 0];

function cornerAo(
  pos: number[],
  d: number,
  u: number,
  v: number,
  dir: number,
  solid: (x: number, y: number, z: number) => boolean,
): { key: number; mean: number } {
  for (let k = 0; k < 4; k++) {
    const cu = AO_CORNERS[k][0];
    const cv = AO_CORNERS[k][1];
    const side1 = sampleAo(pos, d, u, v, dir, cu, 0, solid);
    const side2 = sampleAo(pos, d, u, v, dir, 0, cv, solid);
    const corner = sampleAo(pos, d, u, v, dir, cu, cv, solid);
    aoCorners[k] = side1 && side2 ? 0 : 3 - ((side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner ? 1 : 0));
  }
  const corners = aoCorners;
  const key = corners[0] * 64 + corners[1] * 16 + corners[2] * 4 + corners[3];
  const mean = (corners[0] + corners[1] + corners[2] + corners[3]) / 4;
  aoOut.key = key;
  aoOut.mean = mean;
  return aoOut;
}

function sampleAo(
  pos: number[],
  d: number,
  u: number,
  v: number,
  dir: number,
  du: number,
  dv: number,
  solid: (x: number, y: number, z: number) => boolean,
): boolean {
  aoQ[0] = pos[0];
  aoQ[1] = pos[1];
  aoQ[2] = pos[2];
  aoQ[d] += dir;
  aoQ[u] += du;
  aoQ[v] += dv;
  return solid(aoQ[0], aoQ[1], aoQ[2]);
}

function emitQuad(
  positions: number[],
  normals: number[],
  colors: number[],
  indices: number[],
  d: number,
  u: number,
  v: number,
  slice: number,
  i: number,
  j: number,
  w: number,
  h: number,
  dir: number,
  s: number,
  lo: number[],
  shift: number[],
  r: number,
  g: number,
  b: number,
): void {
  const base = positions.length / 3;
  // Грань лежит на плоскости slice (для dir=-1) или slice+1 (для dir=+1).
  const layer = dir > 0 ? slice + 1 : slice;

  const corner = (du: number, dv: number): [number, number, number] => {
    const p = [0, 0, 0];
    p[d] = layer;
    p[u] = lo[u] + i + du;
    p[v] = lo[v] + j + dv;
    return [(p[0] - shift[0]) * s, (p[1] - shift[1]) * s, (p[2] - shift[2]) * s];
  };

  const quad =
    dir > 0
      ? [corner(0, 0), corner(w, 0), corner(w, h), corner(0, h)]
      : [corner(0, 0), corner(0, h), corner(w, h), corner(w, 0)];

  const n = [0, 0, 0];
  n[d] = dir;

  for (const c of quad) {
    positions.push(c[0], c[1], c[2]);
    normals.push(n[0], n[1], n[2]);
    colors.push(r, g, b);
  }
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** Суммарная площадь видимых граней — для тестов на герметичность меша. */
export function surfaceArea(mesh: MeshData): number {
  let area = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i] * 3;
    const b = mesh.indices[i + 1] * 3;
    const c = mesh.indices[i + 2] * 3;
    const abx = mesh.positions[b] - mesh.positions[a];
    const aby = mesh.positions[b + 1] - mesh.positions[a + 1];
    const abz = mesh.positions[b + 2] - mesh.positions[a + 2];
    const acx = mesh.positions[c] - mesh.positions[a];
    const acy = mesh.positions[c + 1] - mesh.positions[a + 1];
    const acz = mesh.positions[c + 2] - mesh.positions[a + 2];
    const cx = aby * acz - abz * acy;
    const cy = abz * acx - abx * acz;
    const cz = abx * acy - aby * acx;
    area += Math.hypot(cx, cy, cz) / 2;
  }
  return area;
}
