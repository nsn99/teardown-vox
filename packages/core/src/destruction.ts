import {
  Aabb,
  Quat,
  Vec3,
  add,
  aabbEmpty,
  aabbExpand,
  clamp,
  dot,
  inverseTransformDirection,
  inverseTransformPoint,
  length,
  normalize,
  quatConjugate,
  quatIdentity,
  quatMultiply,
  scale,
  sub,
  v3,
} from './math.js';
import { Mat, material } from './materials.js';
import { VoxelRegion, VoxelShape } from './voxel-shape.js';
import { Body } from './body.js';
import { VoxelWorld } from './world.js';

/** Кисть разрушения в мировых координатах. */
export type Brush =
  | { kind: 'sphere'; center: Vec3; radius: number }
  | { kind: 'box'; center: Vec3; halfExtents: Vec3; rotation?: Quat }
  | { kind: 'capsule'; a: Vec3; b: Vec3; radius: number }
  | {
      kind: 'cone';
      apex: Vec3;
      direction: Vec3;
      length: number;
      /** Полуугол раствора, радианы. */
      angle: number;
    };

export type Falloff = 'none' | 'linear' | 'quadratic';

export interface CarveOptions {
  /** Сила инструмента 0..1. Ниже toughness материала — эффекта нет вообще. */
  power: number;
  /** Единиц урона при полной силе за один вызов. */
  damage: number;
  cause?: string;
  falloff?: Falloff;
  /** Мгновенное удаление без накопления (взрыв). */
  instant?: boolean;
  /** Эти материалы не трогаем (напр. цели миссии). */
  protect?: ReadonlySet<number>;
  /** Ограничение на количество удалённых вокселей за вызов. */
  maxVoxels?: number;
  /** Не трогать эти тела. */
  ignoreBodies?: ReadonlySet<number>;
}

export interface DebrisSample {
  /** Мировая позиция центра удалённого вокселя. */
  position: Vec3;
  material: number;
}

export interface TouchedShape {
  body: Body;
  shape: VoxelShape;
  region: VoxelRegion;
  removed: number;
  damaged: number;
  materials: Map<number, number>;
  debris: DebrisSample[];
}

export interface CarveResult {
  removed: number;
  damaged: number;
  byMaterial: Map<number, number>;
  touched: TouchedShape[];
  /** Выборка обломков для частиц (ограничена, не весь объём). */
  debris: DebrisSample[];
  /** Центр фактически задетой области в мире. */
  center: Vec3;
}

const MAX_DEBRIS_SAMPLES = 256;
/** Полудиагональ вокселя: √3/2 ≈ 0.866. */
const MIN_BRUSH_FACTOR = 0.87;

interface LocalField {
  /** Границы в индексах вокселей, уже обрезанные по форме. */
  bounds: VoxelRegion | null;
  /** Вес 0..1 в точке (локальные метры формы). 0 — вне кисти. */
  weight(x: number, y: number, z: number): number;
}

function worldAabbOfBrush(brush: Brush): Aabb {
  const box = aabbEmpty();
  switch (brush.kind) {
    case 'sphere': {
      const r = brush.radius;
      aabbExpand(box, sub(brush.center, v3(r, r, r)));
      aabbExpand(box, add(brush.center, v3(r, r, r)));
      break;
    }
    case 'box': {
      const h = brush.halfExtents;
      const q = brush.rotation ?? quatIdentity();
      for (let i = 0; i < 8; i++) {
        const corner = v3(
          (i & 1 ? 1 : -1) * h.x,
          (i & 2 ? 1 : -1) * h.y,
          (i & 4 ? 1 : -1) * h.z,
        );
        aabbExpand(box, add(brush.center, rotate(q, corner)));
      }
      break;
    }
    case 'capsule': {
      const r = brush.radius;
      aabbExpand(box, sub(brush.a, v3(r, r, r)));
      aabbExpand(box, add(brush.a, v3(r, r, r)));
      aabbExpand(box, sub(brush.b, v3(r, r, r)));
      aabbExpand(box, add(brush.b, v3(r, r, r)));
      break;
    }
    case 'cone': {
      const dir = normalize(brush.direction);
      const end = add(brush.apex, scale(dir, brush.length));
      const r = Math.tan(brush.angle) * brush.length;
      aabbExpand(box, brush.apex);
      aabbExpand(box, sub(end, v3(r, r, r)));
      aabbExpand(box, add(end, v3(r, r, r)));
      break;
    }
  }
  return box;
}

function rotate(q: Quat, v: Vec3): Vec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return v3(
    v.x + q.w * tx + (q.y * tz - q.z * ty),
    v.y + q.w * ty + (q.z * tx - q.x * tz),
    v.z + q.w * tz + (q.x * ty - q.y * tx),
  );
}

const applyFalloff = (t: number, mode: Falloff): number => {
  const u = clamp(1 - t, 0, 1);
  if (mode === 'none') return t <= 1 ? 1 : 0;
  if (mode === 'quadratic') return u * u;
  return u;
};

/** Ближайшая точка отрезка ab к точке p, параметр 0..1. */
function closestOnSegment(a: Vec3, b: Vec3, p: Vec3): number {
  const ab = sub(b, a);
  const denom = dot(ab, ab);
  if (denom < 1e-12) return 0;
  return clamp(dot(sub(p, a), ab) / denom, 0, 1);
}

/** Переводит кисть в локальное пространство формы и строит поле веса. */
function makeLocalField(
  brush: Brush,
  body: Body,
  shape: VoxelShape,
  falloff: Falloff,
): LocalField {
  const toLocal = (p: Vec3): Vec3 =>
    inverseTransformPoint(shape.transform, inverseTransformPoint(body.transform, p));
  const dirToLocal = (d: Vec3): Vec3 =>
    inverseTransformDirection(shape.transform, inverseTransformDirection(body.transform, d));

  const s = shape.voxelSize;
  const clip = (box: Aabb): VoxelRegion | null => {
    const x0 = Math.max(0, Math.floor(box.min.x / s));
    const y0 = Math.max(0, Math.floor(box.min.y / s));
    const z0 = Math.max(0, Math.floor(box.min.z / s));
    const x1 = Math.min(shape.sx, Math.ceil(box.max.x / s));
    const y1 = Math.min(shape.sy, Math.ceil(box.max.y / s));
    const z1 = Math.min(shape.sz, Math.ceil(box.max.z / s));
    if (x1 <= x0 || y1 <= y0 || z1 <= z0) return null;
    return { x0, y0, z0, x1, y1, z1 };
  };

  switch (brush.kind) {
    case 'sphere': {
      const c = toLocal(brush.center);
      // Кисть тоньше вокселя может пролететь мимо всех центров и не
      // задеть ничего. Полудиагональ вокселя — минимум, при котором
      // инструмент гарантированно берёт хотя бы одну клетку.
      const r = Math.max(brush.radius, shape.voxelSize * MIN_BRUSH_FACTOR);
      const box: Aabb = { min: sub(c, v3(r, r, r)), max: add(c, v3(r, r, r)) };
      return {
        bounds: clip(box),
        weight(x, y, z) {
          const d = Math.hypot(x - c.x, y - c.y, z - c.z);
          return applyFalloff(d / r, falloff);
        },
      };
    }
    case 'box': {
      const c = toLocal(brush.center);
      const bodyRot = quatMultiply(body.transform.rotation, shape.transform.rotation);
      const q = quatMultiply(quatConjugate(bodyRot), brush.rotation ?? quatIdentity());
      const h = brush.halfExtents;
      const box = aabbEmpty();
      for (let i = 0; i < 8; i++) {
        aabbExpand(
          box,
          add(
            c,
            rotate(q, v3((i & 1 ? 1 : -1) * h.x, (i & 2 ? 1 : -1) * h.y, (i & 4 ? 1 : -1) * h.z)),
          ),
        );
      }
      const inv = quatConjugate(q);
      return {
        bounds: clip(box),
        weight(x, y, z) {
          const p = rotate(inv, v3(x - c.x, y - c.y, z - c.z));
          const t = Math.max(
            Math.abs(p.x) / h.x,
            Math.abs(p.y) / h.y,
            Math.abs(p.z) / h.z,
          );
          return applyFalloff(t, falloff);
        },
      };
    }
    case 'capsule': {
      const a = toLocal(brush.a);
      const b = toLocal(brush.b);
      const r = Math.max(brush.radius, shape.voxelSize * MIN_BRUSH_FACTOR);
      const box = aabbEmpty();
      aabbExpand(box, sub(a, v3(r, r, r)));
      aabbExpand(box, add(a, v3(r, r, r)));
      aabbExpand(box, sub(b, v3(r, r, r)));
      aabbExpand(box, add(b, v3(r, r, r)));
      return {
        bounds: clip(box),
        weight(x, y, z) {
          const p = v3(x, y, z);
          const t = closestOnSegment(a, b, p);
          const q = add(a, scale(sub(b, a), t));
          return applyFalloff(length(sub(p, q)) / r, falloff);
        },
      };
    }
    case 'cone': {
      const apex = toLocal(brush.apex);
      const dir = normalize(dirToLocal(brush.direction));
      const len = brush.length;
      const tanA = Math.tan(brush.angle);
      const endR = tanA * len;
      const end = add(apex, scale(dir, len));
      const box = aabbEmpty();
      aabbExpand(box, apex);
      aabbExpand(box, sub(end, v3(endR, endR, endR)));
      aabbExpand(box, add(end, v3(endR, endR, endR)));
      return {
        bounds: clip(box),
        weight(x, y, z) {
          const rel = v3(x - apex.x, y - apex.y, z - apex.z);
          const axial = dot(rel, dir);
          if (axial < 0 || axial > len) return 0;
          const radial = length(sub(rel, scale(dir, axial)));
          const maxR = Math.max(tanA * axial, 1e-6);
          if (radial > maxR) return 0;
          // Ослабление и по дальности, и к краю конуса.
          const axialT = axial / len;
          const radialT = radial / maxR;
          return applyFalloff(Math.max(axialT, radialT), falloff);
        },
      };
    }
  }
}

/**
 * Разрушение. Проходит по всем телам, пересечённым кистью, и снимает
 * материал согласно модели «сила инструмента против прочности материала».
 *
 * Ключевое правило Teardown, которое здесь воспроизведено буквально:
 * если сила инструмента ниже порога материала, воксель не берётся ВООБЩЕ,
 * сколько по нему ни бей. Кувалда не пробивает стальную дверь.
 */
export function carve(world: VoxelWorld, brush: Brush, opts: CarveOptions): CarveResult {
  const falloff = opts.falloff ?? 'linear';
  const cause = opts.cause ?? 'unknown';
  const maxVoxels = opts.maxVoxels ?? Infinity;
  const worldBox = worldAabbOfBrush(brush);

  const result: CarveResult = {
    removed: 0,
    damaged: 0,
    byMaterial: new Map(),
    touched: [],
    debris: [],
    center: v3(),
  };

  let cx = 0;
  let cy = 0;
  let cz = 0;

  for (const body of world.bodies.values()) {
    if (body.destroyed || body.passive) continue;
    if (opts.ignoreBodies?.has(body.id)) continue;
    if (!aabbOverlap(body.aabb(), worldBox)) continue;

    for (const shape of body.shapes) {
      if (shape.solidVoxels === 0) continue;
      const field = makeLocalField(brush, body, shape, falloff);
      if (!field.bounds) continue;

      const { x0, y0, z0, x1, y1, z1 } = field.bounds;
      const s = shape.voxelSize;
      let shapeRemoved = 0;
      let shapeDamaged = 0;
      const debrisStart = result.debris.length;
      const shapeMaterials = new Map<number, number>();
      const region: VoxelRegion = { x0: x1, y0: y1, z0: z1, x1: x0, y1: y0, z1: z0 };

      for (let y = y0; y < y1; y++) {
        // Пустые слои и строки перешагиваем: кисть заряда верхней ступени
        // накрывает под сотню тысяч клеток в каждой форме, и почти все они
        // воздух. Считать по ним ослабление — чистая потеря кадра.
        if (shape.solidInLayer(y) === 0) continue;
        for (let z = z0; z < z1; z++) {
          if (shape.solidInRow(y, z) === 0) continue;
          const rowBase = (y * shape.sz + z) * shape.sx;
          for (let x = x0; x < x1; x++) {
            if (result.removed >= maxVoxels) break;
            const i = rowBase + x;
            const mat = shape.data[i];
            if (mat === Mat.Air) continue;
            if (opts.protect?.has(mat)) continue;
            const def = material(mat);
            if (def.indestructible) continue;

            const w = field.weight((x + 0.5) * s, (y + 0.5) * s, (z + 0.5) * s);
            if (w <= 0) continue;

            // Два разных режима — и это принципиально.
            //
            // Мгновенный (взрыв): ослабление входит в порог, поэтому
            // воронка сама собой получается неровной, а по краю заряд
            // уже не берёт прочный материал — ровно как надо.
            //
            // Накопительный (инструмент): порог берётся от полной силы
            // инструмента, а ослабление управляет только скоростью урона.
            // Иначе кувалда, сила которой чуть выше прочности кирпича,
            // грызёт пятно в один воксель, и игрок решает, что она сломана.
            const gate = opts.instant ? opts.power * w : opts.power;
            if (gate <= def.toughness) {
              // Вмятина не накапливается до пробоя стали кувалдой.
              if (mat === Mat.Metal && cause === 'sledge') {
                shape.damage[i] = Math.min(def.hp - 1, shape.damage[i] + Math.max(1, Math.round(opts.damage * w)));
                shape.markDirty(x, y, z);
                shapeDamaged++;
                expand(region, x, y, z);
              }
              continue;
            }

            // Трещина проходит по связанному листу, но не перескакивает
            // через раму. Общий бюджет разрушения действует и здесь.
            if (mat === Mat.Glass) {
              const queue = [i];
              const seen = new Set(queue);
              for (let q = 0; q < queue.length && result.removed < maxVoxels; q++) {
                const at = queue[q];
                const gx = at % shape.sx;
                const gz = Math.floor(at / shape.sx) % shape.sz;
                const gy = Math.floor(at / (shape.sx * shape.sz));
                removeVoxel(shape, at, mat, result, shapeMaterials, body, gx, gy, gz);
                shapeRemoved++;
                expand(region, gx, gy, gz);
                for (const [nx, ny, nz] of [[gx-1,gy,gz], [gx+1,gy,gz], [gx,gy-1,gz], [gx,gy+1,gz], [gx,gy,gz-1], [gx,gy,gz+1]]) {
                  if (nx < 0 || ny < 0 || nz < 0 || nx >= shape.sx || ny >= shape.sy || nz >= shape.sz) continue;
                  const next = shape.idx(nx, ny, nz);
                  if (shape.data[next] !== Mat.Glass || seen.has(next)) continue;
                  seen.add(next);
                  queue.push(next);
                }
              }
              continue;
            }

            if (opts.instant) {
              removeVoxel(shape, i, mat, result, shapeMaterials, body, x, y, z);
              shapeRemoved++;
              expand(region, x, y, z);
              continue;
            }

            // Порог — бинарный: инструмент либо берёт материал, либо нет.
            // Скорость же зависит от ослабления, а не от «запаса» силы:
            // иначе инструмент, едва прошедший порог, грызёт стену вечно,
            // и игрок не понимает, работает он вообще или нет.
            const inc = Math.max(1, Math.round(opts.damage * w));
            const next = shape.damage[i] + inc;
            if (next >= def.hp) {
              removeVoxel(shape, i, mat, result, shapeMaterials, body, x, y, z);
              shapeRemoved++;
            } else {
              shape.damage[i] = next;
              shapeDamaged++;
              shape.markDirty(x, y, z);
            }
            expand(region, x, y, z);
          }
        }
      }

      if (shapeRemoved > 0 || shapeDamaged > 0) {
        result.damaged += shapeDamaged;
        result.touched.push({
          body,
          shape,
          region,
          removed: shapeRemoved,
          damaged: shapeDamaged,
          materials: shapeMaterials,
          debris: result.debris.slice(debrisStart),
        });
      }
    }
  }

  if (result.debris.length > 0) {
    for (const d of result.debris) {
      cx += d.position.x;
      cy += d.position.y;
      cz += d.position.z;
    }
    const n = result.debris.length;
    result.center = v3(cx / n, cy / n, cz / n);
  } else {
    result.center = brushCenter(brush);
  }

  for (const t of result.touched) {
    world.events.emit('voxels:removed', {
      body: t.body,
      shape: t.shape,
      count: t.removed,
      center: result.center,
      materials: t.materials,
      cause,
      debris: t.debris,
    });
  }

  return result;
}

function expand(r: VoxelRegion, x: number, y: number, z: number): void {
  if (x < r.x0) r.x0 = x;
  if (y < r.y0) r.y0 = y;
  if (z < r.z0) r.z0 = z;
  if (x + 1 > r.x1) r.x1 = x + 1;
  if (y + 1 > r.y1) r.y1 = y + 1;
  if (z + 1 > r.z1) r.z1 = z + 1;
}

function removeVoxel(
  shape: VoxelShape,
  index: number,
  mat: number,
  result: CarveResult,
  shapeMaterials: Map<number, number>,
  body: Body,
  x: number,
  y: number,
  z: number,
): void {
  shape.setAt(index, Mat.Air);
  result.removed++;
  result.byMaterial.set(mat, (result.byMaterial.get(mat) ?? 0) + 1);
  shapeMaterials.set(mat, (shapeMaterials.get(mat) ?? 0) + 1);
  if (mat !== Mat.Foliage && result.debris.length < MAX_DEBRIS_SAMPLES) {
    result.debris.push({
      position: shape.voxelCenterWorld(x, y, z, body.transform),
      material: mat,
    });
  }
}

function brushCenter(brush: Brush): Vec3 {
  switch (brush.kind) {
    case 'sphere':
      return brush.center;
    case 'box':
      return brush.center;
    case 'capsule':
      return scale(add(brush.a, brush.b), 0.5);
    case 'cone':
      return add(brush.apex, scale(normalize(brush.direction), brush.length * 0.5));
  }
}

function aabbOverlap(a: Aabb, b: Aabb): boolean {
  return (
    a.min.x <= b.max.x &&
    a.max.x >= b.min.x &&
    a.min.y <= b.max.y &&
    a.max.y >= b.min.y &&
    a.min.z <= b.max.z &&
    a.max.z >= b.min.z
  );
}

export interface ExplosionOptions {
  center: Vec3;
  radius: number;
  /** Сила в центре, 0..1+. На краю падает до нуля. */
  power?: number;
  cause?: string;
  ignoreBodies?: ReadonlySet<number>;
  /** Материалы, которые взрыв не берёт (цели миссии). */
  protect?: ReadonlySet<number>;
  /** Потолок вокселей за вызов: остаток доедает очередь отложенного разрушения. */
  maxVoxels?: number;
}

/**
 * Взрыв: мгновенный сферический carve с квадратичным ослаблением.
 * Импульс телам добавляет физический бэкенд по возвращённому центру и радиусу.
 */
export function explode(world: VoxelWorld, opts: ExplosionOptions): CarveResult {
  return carve(
    world,
    { kind: 'sphere', center: opts.center, radius: opts.radius },
    {
      power: opts.power ?? 1.2,
      damage: 0,
      instant: true,
      falloff: 'quadratic',
      cause: opts.cause ?? 'explosion',
      ignoreBodies: opts.ignoreBodies,
      protect: opts.protect,
      maxVoxels: opts.maxVoxels,
    },
  );
}

/**
 * Разметка баллончиком. Красит поверхностные воксели, не трогая материал:
 * маршрут, нарисованный на стене, не должен её ослаблять.
 */
export function paint(
  world: VoxelWorld,
  center: Vec3,
  radius: number,
  colorIndex: number,
): number {
  const box: Aabb = { min: sub(center, v3(radius, radius, radius)), max: add(center, v3(radius, radius, radius)) };
  let painted = 0;
  for (const body of world.bodies.values()) {
    if (body.destroyed) continue;
    if (!aabbOverlap(body.aabb(), box)) continue;
    for (const shape of body.shapes) {
      if (shape.solidVoxels === 0) continue;
      const c = inverseTransformPoint(
        shape.transform,
        inverseTransformPoint(body.transform, center),
      );
      const s = shape.voxelSize;
      const x0 = Math.max(0, Math.floor((c.x - radius) / s));
      const y0 = Math.max(0, Math.floor((c.y - radius) / s));
      const z0 = Math.max(0, Math.floor((c.z - radius) / s));
      const x1 = Math.min(shape.sx, Math.ceil((c.x + radius) / s));
      const y1 = Math.min(shape.sy, Math.ceil((c.y + radius) / s));
      const z1 = Math.min(shape.sz, Math.ceil((c.z + radius) / s));
      for (let y = y0; y < y1; y++) {
        for (let z = z0; z < z1; z++) {
          for (let x = x0; x < x1; x++) {
            const i = shape.idx(x, y, z);
            if (shape.data[i] === Mat.Air) continue;
            const d = Math.hypot((x + 0.5) * s - c.x, (y + 0.5) * s - c.y, (z + 0.5) * s - c.z);
            if (d > radius) continue;
            if (!isSurface(shape, x, y, z)) continue;
            if (shape.paint.get(i) === colorIndex) continue;
            shape.paint.set(i, colorIndex);
            // Краска не меняет ни материал, ни прочность — структурный
            // анализ трогать незачем, только меш.
            shape.markMeshDirty(x, y, z);
            painted++;
          }
        }
      }
    }
  }
  return painted;
}

export function isSurface(shape: VoxelShape, x: number, y: number, z: number): boolean {
  return (
    shape.get(x + 1, y, z) === Mat.Air ||
    shape.get(x - 1, y, z) === Mat.Air ||
    shape.get(x, y + 1, z) === Mat.Air ||
    shape.get(x, y - 1, z) === Mat.Air ||
    shape.get(x, y, z + 1) === Mat.Air ||
    shape.get(x, y, z - 1) === Mat.Air
  );
}
