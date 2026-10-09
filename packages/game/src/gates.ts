import {
  Aabb, Body, Mat, Simulation, Vec3, VoxelBox, VoxelShape,
  aabbEmpty, aabbExpand, aabbOverlaps, add, clamp, decomposeToBoxes, transformPoint, v3, dot, sub, scale, distance,
} from '@tvox/core';
import { GateDef } from './level.js';
import { overlapsSolid } from './character.js';

/** Подъёмная створка; датчик работает с обеих сторон и учитывает весь транспорт. */
export class AutomaticGate {
  readonly body: Body;
  private readonly closed: Vec3;
  private readonly aperture: Aabb;
  private offset = 0;
  private hand: { point: Vec3; normal: Vec3; offset: number } | null = null;
  private handTarget = 0;
  private visitor?: Aabb;
  private hold = 0;
  private recoilTo: number | null = null;
  private retry = 0;
  private geometry = new Map<VoxelShape, { solids: number; boxes: VoxelBox[] }>();
  private support?: { shape: VoxelShape; index: number };

  constructor(private sim: Simulation, readonly def: GateDef) {
    const body = [...sim.world.bodies.values()].find(b => b.name === def.body);
    if (!body) throw new Error(`Ворота «${def.id}»: нет тела «${def.body}»`);
    this.body = body;
    this.closed = { ...body.transform.position };
    this.aperture = body.aabb();
    if (def.support) {
      const shape = [...sim.world.bodies.values()].flatMap(b => b.shapes)
        .find(s => s.name === def.support!.volume);
      if (!shape) throw new Error(`Ворота «${def.id}»: нет рамы «${def.support.volume}»`);
      const { x, y, z } = def.support.voxel;
      this.support = { shape, index: shape.idx(x, y, z) };
    }
  }

  snapshot() { return { offset: this.offset, hold: this.hold, recoilTo: this.recoilTo, retry: this.retry }; }
  restore(s: ReturnType<AutomaticGate['snapshot']>): void { Object.assign(this, s); this.geometry.clear(); }

  get opening(): number { return this.offset / this.def.rise; }
  get held(): boolean { return this.hand !== null; }
  private shift(n: number): Vec3 { const p = v3(); p[this.def.axis ?? 'y'] = n; return p; }

  grab(eye: Vec3, direction: Vec3, point: Vec3): boolean {
    if (!this.def.manual || !this.body.kinematic || this.body.destroyed || distance(eye, point) > 2.5) return false;
    this.hand = { point: { ...point }, normal: { ...direction }, offset: this.offset };
    this.handTarget = this.offset;
    return true;
  }
  release(): void { this.hand = null; this.handTarget = this.offset; }
  pull(eye: Vec3, direction: Vec3): void {
    const hand = this.hand;
    if (!hand) return;
    const denominator = dot(direction, hand.normal);
    if (Math.abs(denominator) < .15) { this.release(); return; }
    const t = dot(sub(hand.point, eye), hand.normal) / denominator;
    if (t < 0 || t > 5) { this.release(); return; }
    const point = add(eye, scale(direction, t));
    this.handTarget = clamp(hand.offset + dot(sub(point, hand.point), this.shift(1)), 0, this.def.rise);
  }

  update(visitor: Aabb, dt: number): void {
    if (dt <= 0 || this.body.destroyed || !this.body.kinematic) return;
    if (this.support && this.support.shape.data[this.support.index] === Mat.Air) {
      this.release();
      this.body.kinematic = false;
      this.body.tags.add('debris');
      this.body.collidersDirty = true;
      this.body.wake();
      this.sim.physics.sync(this.body);
      return;
    }
    this.visitor = visitor;
    const box = this.aperture;
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    const dx = cx - clamp(cx, visitor.min.x, visitor.max.x);
    const dz = cz - clamp(cz, visitor.min.z, visitor.max.z);
    const nearby = Math.hypot(dx, dz) <= this.def.approachRadius &&
      visitor.min.y < box.max.y + 2 && visitor.max.y > box.min.y - 0.5;
    const blocked = this.obstructed();
    if (nearby || blocked) this.hold = this.def.closeDelay;
    else this.hold = Math.max(0, this.hold - dt);
    this.retry = Math.max(0, this.retry - dt);
    if (this.retry === 0) this.recoilTo = null;
    const recoiling = this.recoilTo !== null;
    const target = this.def.manual ? (this.held ? this.handTarget : this.offset) :
      this.recoilTo ?? (nearby || blocked || this.hold > 0 ? this.def.rise : 0);
    const next = this.offset + clamp(target - this.offset, -this.def.speed * dt, this.def.speed * dt);
    if (next === this.offset) return;
    const motion = this.motionBoxes();
    if (this.pathBlocked(motion, this.offset, next)) {
      // Находим контакт по всему пути, а не только в конце кадра:
      // даже большой dt не должен перескочить через тонкую доску.
      let clear = this.offset;
      let hit = next;
      for (let i = 0; i < 14; i++) {
        const middle = (clear + hit) / 2;
        if (this.pathBlocked(motion, this.offset, middle)) hit = middle;
        else clear = middle;
      }
      this.recoilTo = recoiling ? clear : clamp(clear - Math.sign(next - this.offset) * 0.15, 0, this.def.rise);
      this.retry = Math.max(0.5, this.def.closeDelay);
      this.offset = clear;
    } else this.offset = next;
    this.body.transform.position = add(this.closed, this.shift(this.offset));
    this.sim.physics.sync(this.body);
  }

  /** Боксы только оставшихся вокселей створки, в её закрытом положении. */
  private motionBoxes(): Aabb[] {
    const boxes: Aabb[] = [];
    const transform = { ...this.body.transform, position: this.closed };
    for (const shape of this.body.shapes) {
      let cached = this.geometry.get(shape);
      if (!cached || cached.solids !== shape.solidVoxels) {
        cached = { solids: shape.solidVoxels, boxes: decomposeToBoxes(shape, { maxBoxes: Infinity }) };
        this.geometry.set(shape, cached);
      }
      for (const b of cached.boxes) {
        const box = aabbEmpty();
        for (let i = 0; i < 8; i++) {
          const p = v3(i & 1 ? b.x1 : b.x0, i & 2 ? b.y1 : b.y0, i & 4 ? b.z1 : b.z0);
          p.x *= shape.voxelSize; p.y *= shape.voxelSize; p.z *= shape.voxelSize;
          aabbExpand(box, transformPoint(transform, transformPoint(shape.transform, p)));
        }
        boxes.push(box);
      }
    }
    return boxes;
  }

  private pathBlocked(boxes: Aabb[], from: number, to: number): boolean {
    const ignore = new Set([this.body.id]);
    for (const body of this.sim.world.bodies.values()) if (body.passive) ignore.add(body.id);
    return boxes.some(box => { const swept = {
      min: add(box.min, this.shift(Math.min(from, to))),
      max: add(box.max, this.shift(Math.max(from, to))),
    }; return (this.def.manual && this.visitor && aabbOverlaps(swept, this.visitor)) || overlapsSolid(this.sim.world, swept, ignore); });
  }

  private obstructed(): boolean {
    const box = {
      min: add(this.aperture.min, v3(-0.1, 0, -0.5)),
      max: add(this.aperture.max, v3(0.1, 0.2, 0.5)),
    };
    for (const body of this.sim.world.bodies.values()) {
      if (body === this.body || body.destroyed || body.passive || body.kind !== 'dynamic') continue;
      if (aabbOverlaps(box, body.aabb())) return true;
    }
    return false;
  }
}
