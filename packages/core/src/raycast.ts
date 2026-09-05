import {
  Aabb,
  Transform,
  Vec3,
  inverseTransformDirection,
  inverseTransformPoint,
  normalize,
  rayAabb,
  transformDirection,
  transformPoint,
  v3,
} from './math.js';
import { Mat } from './materials.js';
import { VoxelShape } from './voxel-shape.js';
import { Body } from './body.js';

export interface RayHit {
  body: Body;
  shape: VoxelShape;
  /** Индексы попавшего вокселя в форме. */
  vx: number;
  vy: number;
  vz: number;
  material: number;
  /** Расстояние от начала луча в метрах. */
  distance: number;
  /** Точка попадания в мировых координатах. */
  point: Vec3;
  /** Нормаль грани в мировых координатах. */
  normal: Vec3;
}

export interface RaycastOptions {
  maxDistance?: number;
  /** Вернуть true, чтобы воксель считался попаданием. По умолчанию — любой непустой. */
  filter?: (mat: number, shape: VoxelShape, body: Body) => boolean;
  /** Пропустить эти тела (обычно — само тело стрелка). */
  ignore?: ReadonlySet<number>;
}

const DEFAULT_MAX = 500;

/**
 * DDA по вокселям одной формы (Amanatides & Woo).
 * origin/dir заданы в локальном пространстве формы, в метрах.
 */
export function raycastShape(
  shape: VoxelShape,
  origin: Vec3,
  dir: Vec3,
  maxDistance: number,
  accept?: (mat: number) => boolean,
): { vx: number; vy: number; vz: number; t: number; normal: Vec3; material: number } | null {
  const s = shape.voxelSize;
  // Переходим в воксельные единицы: направление не меняется, t делится на s.
  const ox = origin.x / s;
  const oy = origin.y / s;
  const oz = origin.z / s;

  const box: Aabb = { min: v3(0, 0, 0), max: v3(shape.sx, shape.sy, shape.sz) };
  const span = rayAabb(v3(ox, oy, oz), dir, box);
  if (!span) return null;

  const maxT = maxDistance / s;
  let t = Math.max(span[0], 0);
  const tEnd = Math.min(span[1], maxT);
  if (t > tEnd) return null;

  // Небольшой сдвиг внутрь, иначе на грани floor даёт соседнюю ячейку.
  const eps = 1e-6;
  let px = ox + dir.x * (t + eps);
  let py = oy + dir.y * (t + eps);
  let pz = oz + dir.z * (t + eps);

  let x = Math.floor(px);
  let y = Math.floor(py);
  let z = Math.floor(pz);
  x = x < 0 ? 0 : x >= shape.sx ? shape.sx - 1 : x;
  y = y < 0 ? 0 : y >= shape.sy ? shape.sy - 1 : y;
  z = z < 0 ? 0 : z >= shape.sz ? shape.sz - 1 : z;

  const stepX = dir.x > 0 ? 1 : dir.x < 0 ? -1 : 0;
  const stepY = dir.y > 0 ? 1 : dir.y < 0 ? -1 : 0;
  const stepZ = dir.z > 0 ? 1 : dir.z < 0 ? -1 : 0;

  const invX = dir.x !== 0 ? 1 / Math.abs(dir.x) : Infinity;
  const invY = dir.y !== 0 ? 1 / Math.abs(dir.y) : Infinity;
  const invZ = dir.z !== 0 ? 1 / Math.abs(dir.z) : Infinity;

  const nextBoundary = (p: number, cell: number, step: number): number =>
    step > 0 ? cell + 1 - p : step < 0 ? p - cell : Infinity;

  let tMaxX = stepX === 0 ? Infinity : t + nextBoundary(px, x, stepX) * invX;
  let tMaxY = stepY === 0 ? Infinity : t + nextBoundary(py, y, stepY) * invY;
  let tMaxZ = stepZ === 0 ? Infinity : t + nextBoundary(pz, z, stepZ) * invZ;

  const tDeltaX = invX;
  const tDeltaY = invY;
  const tDeltaZ = invZ;

  // Нормаль грани, через которую вошли. Для старта внутри — против луча.
  let nx = 0;
  let ny = 0;
  let nz = 0;
  if (span[0] > 0) {
    const entry = span[0];
    const ex = ox + dir.x * entry;
    const ey = oy + dir.y * entry;
    const ez = oz + dir.z * entry;
    if (Math.abs(ex) < 1e-4) nx = -1;
    else if (Math.abs(ex - shape.sx) < 1e-4) nx = 1;
    else if (Math.abs(ey) < 1e-4) ny = -1;
    else if (Math.abs(ey - shape.sy) < 1e-4) ny = 1;
    else if (Math.abs(ez) < 1e-4) nz = -1;
    else nz = 1;
  } else {
    nx = -stepX;
  }

  const test = accept ?? ((m: number) => m !== Mat.Air);

  // Верхняя граница шагов: манхэттенская длина плюс запас.
  const budget = (shape.sx + shape.sy + shape.sz) * 3 + 8;
  for (let i = 0; i < budget; i++) {
    if (x < 0 || y < 0 || z < 0 || x >= shape.sx || y >= shape.sy || z >= shape.sz) return null;
    if (t > tEnd) return null;

    const mat = shape.data[shape.idx(x, y, z)];
    if (mat !== Mat.Air && test(mat)) {
      return {
        vx: x,
        vy: y,
        vz: z,
        t: t * s,
        normal: v3(nx, ny, nz),
        material: mat,
      };
    }

    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      t = tMaxX;
      x += stepX;
      tMaxX += tDeltaX;
      nx = -stepX;
      ny = 0;
      nz = 0;
    } else if (tMaxY <= tMaxZ) {
      t = tMaxY;
      y += stepY;
      tMaxY += tDeltaY;
      nx = 0;
      ny = -stepY;
      nz = 0;
    } else {
      t = tMaxZ;
      z += stepZ;
      tMaxZ += tDeltaZ;
      nx = 0;
      ny = 0;
      nz = -stepZ;
    }
  }
  return null;
}

/** Трассировка луча по всем телам мира. Возвращает ближайшее попадание. */
export function raycastBodies(
  bodies: Iterable<Body>,
  origin: Vec3,
  direction: Vec3,
  opts: RaycastOptions = {},
): RayHit | null {
  const dir = normalize(direction);
  if (dir.x === 0 && dir.y === 0 && dir.z === 0) return null;
  const maxDistance = opts.maxDistance ?? DEFAULT_MAX;
  let best: RayHit | null = null;
  let bestT = maxDistance;

  for (const body of bodies) {
    if (body.destroyed) continue;
    if (opts.ignore?.has(body.id)) continue;

    const bodyOrigin = inverseTransformPoint(body.transform, origin);
    const bodyDir = inverseTransformDirection(body.transform, dir);

    for (const shape of body.shapes) {
      if (shape.solidVoxels === 0) continue;
      const localOrigin = inverseTransformPoint(shape.transform, bodyOrigin);
      const localDir = inverseTransformDirection(shape.transform, bodyDir);

      const accept = opts.filter
        ? (mat: number) => opts.filter!(mat, shape, body)
        : undefined;
      const hit = raycastShape(shape, localOrigin, localDir, bestT, accept);
      if (!hit || hit.t >= bestT) continue;

      bestT = hit.t;
      const worldNormalShape = transformDirection(shape.transform, hit.normal);
      const worldNormal = transformDirection(body.transform, worldNormalShape);
      const localPoint = v3(
        localOrigin.x + localDir.x * hit.t,
        localOrigin.y + localDir.y * hit.t,
        localOrigin.z + localDir.z * hit.t,
      );
      const worldPoint = transformPoint(
        body.transform,
        transformPoint(shape.transform, localPoint),
      );
      best = {
        body,
        shape,
        vx: hit.vx,
        vy: hit.vy,
        vz: hit.vz,
        material: hit.material,
        distance: hit.t,
        point: worldPoint,
        normal: worldNormal,
      };
    }
  }
  return best;
}

/** Мировая точка → координаты вокселя внутри формы (может быть вне границ). */
export function worldToVoxel(
  body: Body,
  shape: VoxelShape,
  p: Vec3,
): { x: number; y: number; z: number } {
  const inBody = inverseTransformPoint(body.transform, p);
  const local = inverseTransformPoint(shape.transform, inBody);
  const s = shape.voxelSize;
  return {
    x: Math.floor(local.x / s),
    y: Math.floor(local.y / s),
    z: Math.floor(local.z / s),
  };
}

/** Координаты вокселя → центр вокселя в мире. */
export function voxelToWorld(
  body: Body,
  shape: VoxelShape,
  x: number,
  y: number,
  z: number,
): Vec3 {
  return transformPoint(body.transform, shape.voxelCenterWorld(x, y, z));
}

export { transformPoint as _transformPoint, type Transform };
