import { Body, Mat, Simulation, Vec3, clamp, dot, inverseTransformPoint, quatFromEulerYXZ, rotateVecInverse, scale, sub, transformPoint, v3 } from '@tvox/core';

export interface VehicleFootprint {
  position: Vec3;
  yaw: number;
  length: number;
  width: number;
  height: number;
}

/** Точка на ударенной грани, с учётом ширины кузова и смещения второй машины. */
export function vehicleContactPoint(a: VehicleFootprint, b: VehicleFootprint, normal: Vec3): Vec3 {
  const transform = { position: a.position, rotation: quatFromEulerYXZ(a.yaw + Math.PI / 2, 0) };
  const local = inverseTransformPoint(transform, b.position);
  const direction = rotateVecInverse(transform.rotation, normal);
  const x = Math.abs(direction.x) >= Math.abs(direction.z)
    ? Math.sign(direction.x) * a.length / 2 : clamp(local.x, -a.length / 2, a.length / 2);
  const z = Math.abs(direction.z) > Math.abs(direction.x)
    ? Math.sign(direction.z) * a.width / 2 : clamp(local.z, -a.width / 2, a.width / 2);
  const low = Math.max(a.position.y, b.position.y);
  const high = Math.min(a.position.y + a.height, b.position.y + b.height);
  return transformPoint(transform, v3(x, low - a.position.y + (high - low) * 0.35, z));
}

/** Проверка ориентированных кузовов по разделяющим осям, включая боковой контакт. */
export function vehicleContact(a: VehicleFootprint, b: VehicleFootprint): { normal: Vec3; depth: number } | null {
  if (a.position.y + a.height <= b.position.y || b.position.y + b.height <= a.position.y) return null;
  const axes = (yaw: number) => [v3(-Math.sin(yaw), 0, -Math.cos(yaw)), v3(Math.cos(yaw), 0, -Math.sin(yaw))];
  const aa = axes(a.yaw), bb = axes(b.yaw);
  const radius = (v: VehicleFootprint, axes: Vec3[], axis: Vec3) =>
    Math.abs(dot(axes[0], axis)) * v.length / 2 + Math.abs(dot(axes[1], axis)) * v.width / 2;
  const delta = sub(b.position, a.position);
  let depth = Infinity, normal = v3();
  for (const axis of [...aa, ...bb]) {
    const distance = dot(delta, axis);
    const overlap = radius(a, aa, axis) + radius(b, bb, axis) + 0.015 - Math.abs(distance);
    if (overlap <= 0) return null;
    if (overlap < depth) { depth = overlap; normal = scale(axis, distance < 0 ? -1 : 1); }
  }
  return { normal, depth };
}

/** Сминаем ударенный участок внутрь кузова; стекло разбивается, металл образует вмятину. */
export function dentVehicle(sim: Simulation, body: Body, point: Vec3, inward: Vec3, speed: number): void {
  if (speed < 2.5) return;
  const radius = Math.min(1, 0.22 + speed * 0.035);
  for (const shape of body.shapes) {
    const local = inverseTransformPoint(shape.transform, inverseTransformPoint(body.transform, point));
    const direction = rotateVecInverse(shape.transform.rotation, rotateVecInverse(body.transform.rotation, inward));
    const components = [direction.x, direction.y, direction.z];
    const axis = Math.abs(components[0]) > Math.abs(components[2]) ? 0 : 2;
    const depth = Math.max(1, Math.min(4, Math.floor(speed / 5)));
    const shift = v3(axis === 0 ? Math.sign(components[0]) * depth : 0, 0,
      axis === 2 ? Math.sign(components[2]) * depth : 0);
    const s = shape.voxelSize;
    const entries: { x: number; y: number; z: number; mat: number; paint?: number; damage: number }[] = [];
    const before = shape.solidVoxels;
    for (let y = Math.max(0, Math.floor((local.y - radius) / s)); y < Math.min(shape.sy, Math.ceil((local.y + radius) / s)); y++) {
      for (let z = Math.max(0, Math.floor((local.z - radius) / s)); z < Math.min(shape.sz, Math.ceil((local.z + radius) / s)); z++) {
        for (let x = Math.max(0, Math.floor((local.x - radius) / s)); x < Math.min(shape.sx, Math.ceil((local.x + radius) / s)); x++) {
          const i = shape.idx(x, y, z), mat = shape.data[i];
          if (mat !== Mat.Metal && mat !== Mat.Glass && !(mat === Mat.HeavyMetal && speed >= 12)) continue;
          if (Math.hypot((x + 0.5) * s - local.x, (y + 0.5) * s - local.y, (z + 0.5) * s - local.z) > radius) continue;
          entries.push({ x, y, z, mat, paint: shape.paint.get(i), damage: shape.damage[i] });
        }
      }
    }
    if (entries.length === 0) continue;
    const materials = new Map<number, number>();
    for (const e of entries) materials.set(e.mat, (materials.get(e.mat) ?? 0) + 1);
    for (const e of entries) shape.set(e.x, e.y, e.z, Mat.Air);
    for (const e of entries) {
      const x = e.x + shift.x, y = e.y, z = e.z + shift.z;
      if (e.mat === Mat.Glass || !shape.inBounds(x, y, z) || shape.get(x, y, z) !== Mat.Air) continue;
      shape.set(x, y, z, e.mat);
      materials.set(e.mat, materials.get(e.mat)! - 1);
      const i = shape.idx(x, y, z);
      if (e.paint !== undefined) shape.paint.set(i, e.paint);
      shape.damage[i] = e.damage;
    }
    body.collidersDirty = true;
    body.wake();
    const removed = before - shape.solidVoxels;
    if (removed > 0) sim.world.events.emit('voxels:removed', { body, shape, count: removed,
      center: point, materials: new Map([...materials].filter(([, count]) => count > 0)), cause: 'vehicle-crash' });
  }
}
