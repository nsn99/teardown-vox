import { Aabb, Body, Mat, Simulation, Vec3, VoxelShape, aabbOverlaps, add, clamp, v3 } from '@tvox/core';
import { GateDef } from './level.js';

/** Подъёмная створка; датчик работает с обеих сторон и учитывает весь транспорт. */
export class AutomaticGate {
  readonly body: Body;
  private readonly closed: Vec3;
  private readonly aperture: Aabb;
  private offset = 0;
  private hold = 0;
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

  get opening(): number { return this.offset / this.def.rise; }

  update(visitor: Aabb, dt: number): void {
    if (dt <= 0 || this.body.destroyed || !this.body.kinematic) return;
    if (this.support && this.support.shape.data[this.support.index] === Mat.Air) {
      this.body.kinematic = false;
      this.body.tags.add('debris');
      this.body.collidersDirty = true;
      this.body.wake();
      this.sim.physics.sync(this.body);
      return;
    }
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
    const target = nearby || blocked || this.hold > 0 ? this.def.rise : 0;
    const next = this.offset + clamp(target - this.offset, -this.def.speed * dt, this.def.speed * dt);
    if (next === this.offset) return;
    this.offset = next;
    this.body.transform.position = add(this.closed, v3(0, this.offset, 0));
    this.sim.physics.sync(this.body);
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
