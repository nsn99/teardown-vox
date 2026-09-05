/**
 * Минимальная математика движка. Никаких классов: только plain-объекты и
 * свободные функции — так проще держать нулевые аллокации в горячих циклах
 * и тривиально сравнивать значения в тестах.
 *
 * Система координат: правая, Y вверх. Единица мира — метр.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Позиция + ориентация. Масштаб живёт в VoxelShape.scale. */
export interface Transform {
  position: Vec3;
  rotation: Quat;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const quatIdentity = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });

export const transformIdentity = (): Transform => ({
  position: v3(),
  rotation: quatIdentity(),
});

export const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export const lengthSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const length = (a: Vec3): number => Math.sqrt(lengthSq(a));

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len < 1e-12) return v3();
  return v3(a.x / len, a.y / len, a.z / len);
}

export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
}

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const n = normalize(axis);
  const h = angle * 0.5;
  const s = Math.sin(h);
  return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(h) };
}

/** Порядок YXZ — привычный для FPS-камеры (yaw вокруг Y, затем pitch). */
export function quatFromEulerYXZ(yaw: number, pitch: number, roll = 0): Quat {
  const cy = Math.cos(yaw * 0.5);
  const sy = Math.sin(yaw * 0.5);
  const cp = Math.cos(pitch * 0.5);
  const sp = Math.sin(pitch * 0.5);
  const cr = Math.cos(roll * 0.5);
  const sr = Math.sin(roll * 0.5);
  return {
    x: cy * sp * cr + sy * cp * sr,
    y: sy * cp * cr - cy * sp * sr,
    z: cy * cp * sr - sy * sp * cr,
    w: cy * cp * cr + sy * sp * sr,
  };
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function quatConjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

export function quatNormalize(q: Quat): Quat {
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (len < 1e-12) return quatIdentity();
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}

/** Поворот вектора кватернионом (формула Родрига, без построения матрицы). */
export function rotateVec(q: Quat, v: Vec3): Vec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return v3(
    v.x + q.w * tx + (q.y * tz - q.z * ty),
    v.y + q.w * ty + (q.z * tx - q.x * tz),
    v.z + q.w * tz + (q.x * ty - q.y * tx),
  );
}

export const rotateVecInverse = (q: Quat, v: Vec3): Vec3 => rotateVec(quatConjugate(q), v);

/** Точка из локального пространства трансформа в мировое. */
export function transformPoint(t: Transform, p: Vec3): Vec3 {
  return add(rotateVec(t.rotation, p), t.position);
}

/** Точка из мирового пространства в локальное. */
export function inverseTransformPoint(t: Transform, p: Vec3): Vec3 {
  return rotateVecInverse(t.rotation, sub(p, t.position));
}

export function transformDirection(t: Transform, d: Vec3): Vec3 {
  return rotateVec(t.rotation, d);
}

export function inverseTransformDirection(t: Transform, d: Vec3): Vec3 {
  return rotateVecInverse(t.rotation, d);
}

export function composeTransform(parent: Transform, child: Transform): Transform {
  return {
    position: transformPoint(parent, child.position),
    rotation: quatNormalize(quatMultiply(parent.rotation, child.rotation)),
  };
}

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

export const aabbEmpty = (): Aabb => ({
  min: v3(Infinity, Infinity, Infinity),
  max: v3(-Infinity, -Infinity, -Infinity),
});

export function aabbExpand(box: Aabb, p: Vec3): Aabb {
  box.min.x = Math.min(box.min.x, p.x);
  box.min.y = Math.min(box.min.y, p.y);
  box.min.z = Math.min(box.min.z, p.z);
  box.max.x = Math.max(box.max.x, p.x);
  box.max.y = Math.max(box.max.y, p.y);
  box.max.z = Math.max(box.max.z, p.z);
  return box;
}

export const aabbIsEmpty = (box: Aabb): boolean =>
  box.min.x > box.max.x || box.min.y > box.max.y || box.min.z > box.max.z;

export function aabbContains(box: Aabb, p: Vec3): boolean {
  return (
    p.x >= box.min.x &&
    p.x <= box.max.x &&
    p.y >= box.min.y &&
    p.y <= box.max.y &&
    p.z >= box.min.z &&
    p.z <= box.max.z
  );
}

export function aabbOverlaps(a: Aabb, b: Aabb): boolean {
  return (
    a.min.x <= b.max.x &&
    a.max.x >= b.min.x &&
    a.min.y <= b.max.y &&
    a.max.y >= b.min.y &&
    a.min.z <= b.max.z &&
    a.max.z >= b.min.z
  );
}

/**
 * Пересечение луча с AABB (slab-метод). Возвращает [tMin, tMax] или null.
 * tMin может быть отрицательным, если начало луча внутри бокса.
 */
export function rayAabb(origin: Vec3, dir: Vec3, box: Aabb): [number, number] | null {
  let tMin = -Infinity;
  let tMax = Infinity;
  const o = [origin.x, origin.y, origin.z];
  const d = [dir.x, dir.y, dir.z];
  const lo = [box.min.x, box.min.y, box.min.z];
  const hi = [box.max.x, box.max.y, box.max.z];

  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null;
      continue;
    }
    const inv = 1 / d[i];
    let t1 = (lo[i] - o[i]) * inv;
    let t2 = (hi[i] - o[i]) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return [tMin, tMax];
}

export const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

/**
 * mulberry32 — быстрый детерминированный PRNG.
 * Весь недетерминизм в игре идёт только отсюда, чтобы прогон физики
 * воспроизводился в тестах и реплеях бит в бит.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
