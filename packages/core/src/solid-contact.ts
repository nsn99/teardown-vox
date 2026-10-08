import { Aabb, Transform, Vec3, aabbEmpty, aabbExpand, aabbOverlaps, cross, dot, inverseTransformPoint,
  quatMultiply, rotateVec, rotateVecInverse, sub, transformPoint, v3 } from './math.js';
import { Body } from './body.js';
import { ColliderBox, buildColliders } from './collider.js';
import { Mat } from './materials.js';
import { CHUNK_SIZE, VoxelShape } from './voxel-shape.js';
import { VoxelWorld } from './world.js';

interface Geometry { revision: number; chunks: Map<number, ColliderBox[]> }
const geometry = new WeakMap<VoxelShape, Geometry>();
const axes = [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)];
const solid = (mat: number) => mat !== Mat.Air && mat !== Mat.Water && mat !== Mat.Paint;

/** Точные боксы кэшируются по чанкам; пустой салон не становится сплошной коробкой. */
function chunkBoxes(shape: VoxelShape, chunk: number): ColliderBox[] {
  let cached = geometry.get(shape);
  if (!cached || cached.revision !== shape.revision) {
    cached = { revision: shape.revision, chunks: new Map() }; geometry.set(shape, cached);
  }
  let boxes = cached.chunks.get(chunk);
  if (!boxes) {
    boxes = buildColliders(shape, { region: shape.chunkBounds(chunk), maxBoxes: Infinity, includes: solid });
    cached.chunks.set(chunk, boxes);
  }
  return boxes;
}

function shapePose(bodyPose: Transform, shape: VoxelShape): Transform {
  return { position: transformPoint(bodyPose, shape.transform.position),
    rotation: quatMultiply(bodyPose.rotation, shape.transform.rotation) };
}

function bounds(pose: Transform, box: ColliderBox): Aabb {
  const aabb = aabbEmpty();
  for (let i = 0; i < 8; i++) aabbExpand(aabb, transformPoint(pose, v3(
    box.cx + (i & 1 ? box.hx : -box.hx), box.cy + (i & 2 ? box.hy : -box.hy),
    box.cz + (i & 4 ? box.hz : -box.hz))));
  return aabb;
}

/** Границы только занятых вокселей, без воздушных углов исходной формы. */
export function bodySolidBounds(body: Body, pose = body.transform): Aabb {
  const result = aabbEmpty();
  for (const shape of body.shapes) for (let chunk = 0; chunk < shape.chunkCount; chunk++) {
    if (shape.solidInChunk(chunk) === 0) continue;
    for (const box of chunkBoxes(shape, chunk)) {
      const extent = bounds(shapePose(pose, shape), box);
      aabbExpand(result, extent.min); aabbExpand(result, extent.max);
    }
  }
  return result;
}

/** SAT: ориентированный бокс корпуса против бокса в локальных осях препятствия. */
function intersects(center: Vec3, half: Vec3, directions: Vec3[], box: ColliderBox): boolean {
  const delta = sub(center, v3(box.cx, box.cy, box.cz));
  const sizes = [half.x, half.y, half.z];
  for (const axis of [...axes, ...directions, ...directions.flatMap(a => axes.map(b => cross(a, b)))]) {
    const norm = Math.hypot(axis.x, axis.y, axis.z);
    if (norm < 1e-8) continue;
    const radius = box.hx * Math.abs(axis.x) + box.hy * Math.abs(axis.y) + box.hz * Math.abs(axis.z) +
      directions.reduce((sum, direction, i) => sum + sizes[i] * Math.abs(dot(direction, axis)), 0);
    if (Math.abs(dot(delta, axis)) >= radius - 1e-6 * norm) return false;
  }
  return true;
}

/** Объём пересечения проекций; при неизменной ориентации позволяет отъехать из старого контакта. */
function overlapVolume(center: Vec3, half: Vec3, directions: Vec3[], box: ColliderBox): number {
  const sizes = [half.x, half.y, half.z];
  let volume = 1;
  for (const [i, axis] of axes.entries()) {
    const r = directions.reduce((sum, direction, j) => sum + sizes[j] * Math.abs(dot(direction, axis)), 0);
    const c = dot(center, axis), b = [box.cx, box.cy, box.cz][i], h = [box.hx, box.hy, box.hz][i];
    volume *= Math.max(0, Math.min(c + r, b + h) - Math.max(c - r, b - h));
  }
  return volume;
}

/** Точная геометрия тела на предложенной позиции; пустоты и повороты сохраняются. */
export function bodyOverlapsWorld(world: VoxelWorld, body: Body, pose: Transform,
  ignore?: ReadonlySet<number>, filter?: (body: Body) => boolean): boolean {
  return overlapsWorld(world, body, pose, ignore, filter);
}

/** Новый контакт блокируется; уже проникшая геометрия может только уменьшать пересечение при отъезде. */
export function bodyMovementBlocked(world: VoxelWorld, body: Body, from: Transform, to: Transform,
  ignore?: ReadonlySet<number>, filter?: (body: Body) => boolean): boolean {
  const unchanged = Math.abs(from.rotation.x - to.rotation.x) + Math.abs(from.rotation.y - to.rotation.y) +
    Math.abs(from.rotation.z - to.rotation.z) + Math.abs(from.rotation.w - to.rotation.w) < 1e-8;
  return overlapsWorld(world, body, to, ignore, filter, unchanged ? from : undefined);
}

function overlapsWorld(world: VoxelWorld, body: Body, pose: Transform,
  ignore?: ReadonlySet<number>, filter?: (body: Body) => boolean, escapeFrom?: Transform): boolean {
  const components: { pose: Transform; previous?: Transform; box: ColliderBox; bounds: Aabb }[] = [];
  const broad = aabbEmpty();
  for (const shape of body.shapes) {
    const transform = shapePose(pose, shape);
    for (let chunk = 0; chunk < shape.chunkCount; chunk++) {
      if (shape.solidInChunk(chunk) === 0) continue;
      for (const box of chunkBoxes(shape, chunk)) {
        const extent = bounds(transform, box);
        aabbExpand(broad, extent.min); aabbExpand(broad, extent.max);
        components.push({ pose: transform, previous: escapeFrom ? shapePose(escapeFrom, shape) : undefined, box, bounds: extent });
      }
    }
  }
  for (const other of world.bodies.values()) {
    if (other.destroyed || other === body || other.tags.has('water') || ignore?.has(other.id) ||
        (filter && !filter(other))) continue;
    if (!aabbOverlaps(broad, other.aabb())) continue;
    for (const shape of other.shapes) {
      if (shape.solidVoxels === 0) continue;
      const transform = shapePose(other.transform, shape);
      for (const component of components) {
        const local = aabbEmpty();
        for (let i = 0; i < 8; i++) aabbExpand(local, inverseTransformPoint(transform, v3(
          i & 1 ? component.bounds.max.x : component.bounds.min.x,
          i & 2 ? component.bounds.max.y : component.bounds.min.y,
          i & 4 ? component.bounds.max.z : component.bounds.min.z)));
        const size = shape.voxelSize;
        if (local.max.x <= 0 || local.max.y <= 0 || local.max.z <= 0 ||
            local.min.x >= shape.sx * size || local.min.y >= shape.sy * size || local.min.z >= shape.sz * size) continue;
        const center = inverseTransformPoint(transform, transformPoint(component.pose,
          v3(component.box.cx, component.box.cy, component.box.cz)));
        const directions = axes.map(axis => rotateVecInverse(transform.rotation, rotateVec(component.pose.rotation, axis)));
        // Только чанки, пересекающиеся с данным компонентом; огромный склад целиком не сканируем.
        const x0 = Math.max(0, Math.floor(local.min.x / (size * CHUNK_SIZE)));
        const y0 = Math.max(0, Math.floor(local.min.y / (size * CHUNK_SIZE)));
        const z0 = Math.max(0, Math.floor(local.min.z / (size * CHUNK_SIZE)));
        const x1 = Math.min(shape.chunksX, Math.ceil(local.max.x / (size * CHUNK_SIZE)));
        const y1 = Math.min(shape.chunksY, Math.ceil(local.max.y / (size * CHUNK_SIZE)));
        const z1 = Math.min(shape.chunksZ, Math.ceil(local.max.z / (size * CHUNK_SIZE)));
        for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
          const chunk = (y * shape.chunksZ + z) * shape.chunksX + x;
          if (shape.solidInChunk(chunk) === 0) continue;
          for (const box of chunkBoxes(shape, chunk)) {
            const half = v3(component.box.hx, component.box.hy, component.box.hz);
            if (!intersects(center, half, directions, box)) continue;
            if (component.previous) {
              const before = inverseTransformPoint(transform, transformPoint(component.previous,
                v3(component.box.cx, component.box.cy, component.box.cz)));
              if (intersects(before, half, directions, box) &&
                  overlapVolume(center, half, directions, box) < overlapVolume(before, half, directions, box) - 1e-10) continue;
            }
            return true;
          }
        }
      }
    }
  }
  return false;
}
