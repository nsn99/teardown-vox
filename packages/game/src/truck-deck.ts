import { Body, Simulation, Transform, Vec3, add, inverseTransformPoint, length, quatConjugate,
  cross, quatMultiply, sub, transformPoint, v3 } from '@tvox/core';

interface SecuredLoad { body: Body; local: Transform }
export type TruckLoadResult = 'secured' | 'released' | 'empty' | 'moving';

/** Физический груз крана закрепляется на открытой платформе, цели миссии остаются в Heist. */
export class TruckDeck {
  private loads = new Map<number, SecuredLoad>();
  readonly min: Vec3;
  readonly max: Vec3;
  constructor(private truck: Body, size: number) {
    this.min = v3(-46 * size, 12 * size, -13 * size);
    this.max = v3(16 * size, 40 * size, 13 * size);
  }
  get count(): number { return this.loads.size; }
  get mass(): number { return [...this.loads.values()].reduce((n, load) => n + load.body.mass(), 0); }

  toggle(sim: Simulation): TruckLoadResult {
    if (length(this.truck.velocity) > 0.6) return 'moving';
    if (this.loads.size) { this.release(sim); return 'released'; }
    for (const body of sim.world.bodies.values()) {
      if (body.destroyed || body.passive || body.kind !== 'dynamic' || body.kinematic || body.solidVoxels === 0 ||
          body.tags.has('vehicle') || body.tags.has('target') || body.tags.has('crane') || body.tags.has('crane-load') ||
          (!body.tags.has('cargo') && !body.tags.has('debris')) || length(body.velocity) > 1.5) continue;
      const box = body.aabb();
      const corners = Array.from({ length: 8 }, (_, i) => inverseTransformPoint(this.truck.transform,
        v3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)));
      const min = v3(Math.min(...corners.map(p => p.x)), Math.min(...corners.map(p => p.y)), Math.min(...corners.map(p => p.z)));
      if (corners.some(p => p.x < this.min.x - 0.08 || p.x > this.max.x + 0.08 ||
          p.z < this.min.z - 0.08 || p.z > this.max.z + 0.08) || Math.abs(min.y - this.min.y) > 0.25 ||
          this.mass + body.mass() > 8000) continue;
      this.loads.set(body.id, { body, local: { position: inverseTransformPoint(this.truck.transform, body.transform.position),
        rotation: quatMultiply(quatConjugate(this.truck.transform.rotation), body.transform.rotation) } });
      body.kinematic = true; body.tags.add('truck-load'); body.wake();
      sim.physics.sync(body);
    }
    return this.loads.size ? 'secured' : 'empty';
  }

  update(sim: Simulation, wrecked: boolean): void {
    if (wrecked || this.truck.destroyed) { this.release(sim); return; }
    for (const [id, load] of this.loads) {
      if (load.body.destroyed || !sim.world.bodies.has(id) || load.body.solidVoxels === 0) { this.loads.delete(id); continue; }
      load.body.transform = { position: transformPoint(this.truck.transform, load.local.position),
        rotation: quatMultiply(this.truck.transform.rotation, load.local.rotation) };
      load.body.velocity = add(this.truck.velocity, cross(this.truck.angularVelocity,
        sub(load.body.transform.position, this.truck.transform.position)));
      load.body.angularVelocity = { ...this.truck.angularVelocity };
      sim.physics.sync(load.body);
    }
  }

  release(sim: Simulation): number {
    const count = this.loads.size;
    for (const { body } of this.loads.values()) {
      body.kinematic = false; body.tags.delete('truck-load'); body.velocityDirty = true; body.wake(); sim.physics.sync(body);
    }
    this.loads.clear(); return count;
  }
}
