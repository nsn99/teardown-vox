import { Body, Mat, Simulation, Transform, VoxelShape, add, bodyMovementBlocked, bodyOverlapsWorld,
  bodySolidBounds, clamp, inverseTransformPoint, length, quatConjugate, quatMultiply, transformPoint, v3 } from '@tvox/core';

export type ForkLoadResult = 'attached' | 'released' | 'empty' | 'heavy' | 'moving' | 'broken';

/** Counterbalanced forklift: mast, open operator cage and two real solid tines. */
export function buildForkliftHull(shape: VoxelShape): void {
  const part = (box: number[], mat: Mat, color: number) => {
    const [x0, y0, z0, x1, y1, z1] = box;
    shape.fill({ x0, y0, z0, x1, y1, z1 }, mat);
    for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++)
      shape.paint.set(shape.idx(x, y, z), 0x1000000 | color);
  };
  part([1, 4, 3, 29, 9, 21], Mat.HeavyMetal, 0xe4ad28);
  part([1, 9, 3, 9, 17, 21], Mat.HeavyMetal, 0xe4ad28);
  part([10, 10, 8, 16, 12, 16], Mat.Plastic, 0x29383c);
  part([10, 12, 8, 12, 19, 16], Mat.Plastic, 0x29383c);
  part([20, 10, 10, 22, 18, 14], Mat.Metal, 0x394b51);
  part([19, 18, 8, 23, 19, 16], Mat.Metal, 0x394b51);
  for (const x of [8, 24]) for (const z of [3, 19]) part([x, 9, z, x + 2, 28, z + 2], Mat.Metal, 0x344247);
  part([7, 28, 2, 27, 30, 22], Mat.Metal, 0xe4ad28);
  for (const z of [3, 19]) part([27, 5, z, 29, 34, z + 2], Mat.HeavyMetal, 0x344247);
  part([27, 32, 3, 29, 34, 21], Mat.HeavyMetal, 0x344247);
}

export class Forklift {
  readonly forks: VoxelShape;
  readonly capacity = 5000;
  height = 0;
  load: Body | null = null;
  private local: Transform | null = null;
  private readonly initialForks: number;
  private readonly probe: Body;
  constructor(private vehicle: Body, private size: number) {
    this.forks = new VoxelShape({ sx: 18, sy: 16, sz: 22, voxelSize: size, grounded: false, name: 'forklift-forks' });
    this.forks.structural = false;
    for (const z of [3, 17]) this.forks.fill({ x0: 0, x1: 18, y0: 0, y1: 1, z0: z, z1: z + 2 }, Mat.HeavyMetal);
    this.forks.fill({ x0: 0, x1: 2, y0: 1, y1: 16, z0: 2, z1: 20 }, Mat.HeavyMetal);
    this.initialForks = this.forks.solidVoxels;
    this.pose(); this.vehicle.addShape(this.forks);
    this.probe = new Body({ shapes: [this.forks] });
  }
  private pose(): void { this.forks.transform.position = v3(4 * this.size, this.size + this.height, -11 * this.size); }
  get intact(): boolean {
    const hull = this.vehicle.shapes[0];
    return !this.vehicle.destroyed && this.vehicle.kinematic && this.forks.solidVoxels > this.initialForks * .65 &&
      [3, 19].every(z => hull.get(27, 10, z) !== Mat.Air && hull.get(27, 25, z) !== Mat.Air);
  }
  private loadPose(pose: Transform, lift = 0): Transform {
    return { position: transformPoint(pose, add(this.local!.position, v3(0, lift, 0))),
      rotation: quatMultiply(pose.rotation, this.local!.rotation) };
  }
  blocks(sim: Simulation, pose: Transform): boolean {
    if (!this.load || !this.local) return false;
    return bodyMovementBlocked(sim.world, this.load, this.load.transform, this.loadPose(pose), undefined,
      other => other !== this.vehicle && other !== this.load);
  }
  toggle(sim: Simulation): ForkLoadResult {
    if (this.load) { this.release(sim); return 'released'; }
    if (!this.intact) return 'broken';
    if (length(this.vehicle.velocity) > .6) return 'moving';
    let heavy = false;
    for (const source of sim.world.bodies.values()) for (const shape of source.shapes) {
      if (source === this.vehicle || source.destroyed || source.kinematic || source.tags.has('vehicle') ||
          source.tags.has('crane') || source.tags.has('gate') || shape.grounded || shape.attachments.size) continue;
      const merged = source.tags.has('debris-field');
      if (source.kind !== 'dynamic' && !merged && !source.tags.has('frozen')) continue;
      const body = merged ? new Body({ kind: 'dynamic', shapes: [shape], tags: ['debris'],
        transform: structuredClone(source.transform), name: 'Обломок на вилах' }) : source;
      const box = bodySolidBounds(body);
      const corners = Array.from({ length: 8 }, (_, i) => inverseTransformPoint(this.vehicle.transform,
        v3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)));
      const min = v3(Math.min(...corners.map(p => p.x)), Math.min(...corners.map(p => p.y)), Math.min(...corners.map(p => p.z)));
      const max = v3(Math.max(...corners.map(p => p.x)), Math.max(...corners.map(p => p.y)), Math.max(...corners.map(p => p.z)));
      const top = this.height + 2 * this.size;
      if (max.x < .65 || min.x > 2.1 || min.z > .65 || max.z < -.65 || Math.abs(min.y - top) > .28) continue;
      if (body.mass() > this.capacity || max.x - min.x > 3.2 || max.z - min.z > 3.2) { heavy = true; continue; }
      if (merged) { source.removeShape(shape); source.collidersImmediate = true; sim.physics.sync(source); sim.world.addBody(body); }
      body.passive = false; body.tags.delete('frozen'); body.kind = 'dynamic'; body.kinematic = true;
      body.tags.add('forklift-load'); body.velocity = v3(); body.angularVelocity = v3(); body.wake();
      this.load = body;
      this.local = { position: inverseTransformPoint(this.vehicle.transform, body.transform.position),
        rotation: quatMultiply(quatConjugate(this.vehicle.transform.rotation), body.transform.rotation) };
      sim.physics.sync(body);
      return 'attached';
    }
    return heavy ? 'heavy' : 'empty';
  }
  update(sim: Simulation, lift: number, dt: number, wrecked: boolean): void {
    if (wrecked || !this.intact || this.load?.destroyed) { this.release(sim); return; }
    const next = clamp(this.height + lift * dt * .7, 0, 2);
    const delta = next - this.height;
    if (!delta) return;
    const old = this.height;
    this.height = next; this.pose();
    const filter = (other: Body) => other !== this.vehicle && other !== this.load;
    const forkBlocked = bodyOverlapsWorld(sim.world, this.probe, this.vehicle.transform, undefined, filter);
    const loadBlocked = this.load && bodyMovementBlocked(sim.world, this.load, this.load.transform,
      this.loadPose(this.vehicle.transform, delta), undefined, filter);
    if (forkBlocked || loadBlocked) { this.height = old; this.pose(); return; }
    if (this.local) this.local.position.y += delta;
    this.vehicle.collidersDirty = true; this.vehicle.collidersImmediate = true;
    this.follow(sim);
  }
  follow(sim: Simulation): void {
    if (!this.load || !this.local) return;
    if (!this.intact || this.load.destroyed) { this.release(sim); return; }
    this.load.transform = this.loadPose(this.vehicle.transform);
    this.load.velocity = { ...this.vehicle.velocity };
    this.load.angularVelocity = { ...this.vehicle.angularVelocity };
    sim.physics.sync(this.load);
  }
  release(sim: Simulation): void {
    if (this.load) {
      this.load.kinematic = false; this.load.tags.delete('forklift-load');
      this.load.velocity = { ...this.vehicle.velocity }; this.load.velocityDirty = true;
      this.load.wake(); sim.physics.sync(this.load);
    }
    this.load = null; this.local = null;
  }
  snapshot() { return { height: this.height, bodyId: this.load?.id, local: structuredClone(this.local) }; }
  restore(s: ReturnType<Forklift['snapshot']>, bodies: Map<number, Body>): void {
    this.height = s.height; this.pose(); this.load = s.bodyId === undefined ? null : bodies.get(s.bodyId) ?? null;
    this.local = structuredClone(s.local);
  }
}
