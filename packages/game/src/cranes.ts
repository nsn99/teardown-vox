import {
  Body, Mat, Quat, Simulation, Vec3, VoxelShape, add, clamp, cross, distance, dot,
  extractFragment, inverseTransformPoint, length, normalize, quatFromAxisAngle,
  quatFromEulerYXZ, quatIdentity, quatMultiply, rotateVec, scale, solveBodyStructure,
  sub, transformPoint, v3, bodyOverlapsWorld,
} from '@tvox/core';
import { CraneDef, CranePartDef } from './level.js';

export interface CraneInput {
  slew: number;
  luff: number;
  hoist: number;
}
export const NEUTRAL_CRANE_INPUT: CraneInput = { slew: 0, luff: 0, hoist: 0 };
export type CraneLoadResult = 'attached' | 'released' | 'empty' | 'overweight' | 'broken';
type Part = { body: Body; shape: VoxelShape; anchors: number[] };

/** Реальные воксельные узлы: приводы задают позу, повреждения отделяют обломки. */
export class PortCrane {
  readonly house: Body;
  readonly boom: Body;
  readonly hook: Body;
  readonly ropes: Body;
  readonly stay: Body;
  readonly bodyIds: ReadonlySet<number>;
  yaw = 0;
  angle: number;
  ropeLength: number;
  blocked = false;
  private parts: Part[];
  private base: { body: Body; shape: VoxelShape; indices: number[] };
  private boomSupport: number[];
  private ropeShape: VoxelShape;
  private stayShape: VoxelShape;
  private liveColumns: Set<number>;
  private ropeRows: number;
  private stayRows = 0;
  private cabIndex: number;
  private gripVoxel: Vec3;
  private payload?: { body: Body; offset: Vec3; rotation: Quat; previous: Vec3 };

  constructor(private sim: Simulation, readonly def: CraneDef) {
    this.angle = def.angle;
    this.ropeLength = def.ropes.length;
    const baseBody = [...sim.world.bodies.values()].find(b => b.shapes.some(s => s.name === def.base.volume));
    const baseShape = baseBody?.shapes.find(s => s.name === def.base.volume);
    if (!baseBody || !baseShape) throw new Error(`Кран «${def.id}»: нет опоры «${def.base.volume}»`);
    this.base = { body: baseBody, shape: baseShape, indices: def.base.anchors.map(p => baseShape.idx(p.x, p.y, p.z)) };
    this.parts = [def.house, def.boom, def.hook].map(p => this.mountPart(p));
    [this.house, this.boom, this.hook] = this.parts.map(p => p.body);
    const hookShape = this.parts[2].shape;
    const grip = inverseTransformPoint(hookShape.transform, v3(0.05, -1.3, 0));
    this.gripVoxel = v3(Math.floor(grip.x / hookShape.voxelSize), Math.floor(grip.y / hookShape.voxelSize),
      Math.floor(grip.z / hookShape.voxelSize));
    this.boomSupport = def.boom.support.map(p => this.parts[0].shape.idx(p.x, p.y, p.z));
    const cab = inverseTransformPoint(this.parts[0].shape.transform, sub(def.cab.control, def.house.pivot));
    const vs = this.parts[0].shape.voxelSize;
    this.cabIndex = this.parts[0].shape.idx(Math.floor(cab.x / vs), Math.floor(cab.y / vs), Math.floor(cab.z / vs));
    this.ropes = this.findBody(def.ropes.body);
    this.ropeShape = this.ropes.shapes[0];
    this.ropeShape.transform.position = sub(this.ropeShape.transform.position, def.hook.pivot);
    this.ropeShape.structural = false;
    this.liveColumns = new Set(def.ropes.columns);
    this.ropeRows = Math.ceil(def.ropes.length / this.ropeShape.voxelSize);
    this.stay = this.findBody(def.stay.body);
    this.stayShape = this.stay.shapes[0];
    this.stayShape.transform.position = sub(this.stayShape.transform.position, def.stay.from);
    this.stayShape.structural = false;
    this.bodyIds = new Set([this.house, this.boom, this.hook, this.ropes, this.stay].map(b => b.id));
    this.pose();
    this.resizeStay();
    this.pose();
    for (const body of [this.house, this.boom, this.hook, this.ropes, this.stay]) {
      body.tags.add('crane');
      body.tags.add(`crane:${def.id}`);
      this.sim.physics.sync(body);
    }
  }

  snapshot() { return structuredClone({ yaw: this.yaw, angle: this.angle, ropeLength: this.ropeLength,
    liveColumns: [...this.liveColumns], ropeRows: this.ropeRows, stayRows: this.stayRows,
    payload: this.payload ? { bodyId: this.payload.body.id, offset: this.payload.offset,
      rotation: this.payload.rotation, previous: this.payload.previous } : null }); }
  restore(s: ReturnType<PortCrane['snapshot']>, bodies: Map<number, Body>): void {
    this.yaw = s.yaw; this.angle = s.angle; this.ropeLength = s.ropeLength;
    this.liveColumns = new Set(s.liveColumns); this.ropeRows = s.ropeRows; this.stayRows = s.stayRows;
    const body = s.payload && bodies.get(s.payload.bodyId);
    this.payload = s.payload && body ? { body, offset: s.payload.offset, rotation: s.payload.rotation, previous: s.payload.previous } : undefined;
  }

  private findBody(name: string): Body {
    const body = [...this.sim.world.bodies.values()].find(b => b.name === name);
    if (!body || body.shapes.length !== 1 || !body.kinematic || body.passive) {
      throw new Error(`Кран «${this.def.id}»: нужен один разрушаемый кинематический объём «${name}»`);
    }
    return body;
  }

  private mountPart(def: CranePartDef): Part {
    const body = this.findBody(def.body);
    const shape = body.shapes[0];
    shape.transform.position = sub(shape.transform.position, def.pivot);
    body.transform.position = { ...def.pivot };
    shape.grounded = false;
    const anchors = def.anchors.map(p => shape.idx(p.x, p.y, p.z));
    for (const index of anchors) shape.attachmentAnchors.add(index);
    return { body, shape, anchors };
  }

  private alive(body: Body): boolean { return !body.destroyed && body.kinematic && body.solidVoxels > 0; }
  get operable(): boolean {
    return this.alive(this.house) && this.parts[0].shape.data[this.cabIndex] !== Mat.Air;
  }
  get hoistIntact(): boolean {
    return this.alive(this.boom) && this.alive(this.hook) && this.liveColumns.size > 0 &&
      this.parts[2].shape.get(this.gripVoxel.x, this.gripVoxel.y, this.gripVoxel.z) !== Mat.Air;
  }
  get load(): Body | null { return this.payload?.body ?? null; }
  get seat(): Vec3 { return transformPoint(this.house.transform, sub(this.def.cab.seat, this.def.house.pivot)); }
  get exit(): Vec3 { return transformPoint(this.house.transform, sub(this.def.cab.exit, this.def.house.pivot)); }
  get tip(): Vec3 { return transformPoint(this.boom.transform, sub(this.def.tip, this.def.boom.pivot)); }
  get grip(): Vec3 { return transformPoint(this.hook.transform, v3(0.05, -1.3, 0)); }

  canEnter(position: Vec3): boolean {
    return this.operable && distance(position, this.exit) < 1.5 && Math.abs(position.y - this.exit.y) < 0.7;
  }

  update(input: CraneInput, dt: number): void {
    this.checkDamage();
    if (!this.operable || dt <= 0) return;
    dt = Math.min(dt, 0.1);
    const old = { yaw: this.yaw, angle: this.angle, length: this.ropeLength };
    this.yaw -= clamp(input.slew, -1, 1) * this.def.slewSpeed * dt;
    this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
    if (this.alive(this.boom)) this.angle = clamp(this.angle + clamp(input.luff, -1, 1) * this.def.luffSpeed * dt,
      this.def.minAngle, this.def.maxAngle);
    if (this.hoistIntact) this.ropeLength = clamp(this.ropeLength - clamp(input.hoist, -1, 1) * this.def.hoistSpeed * dt,
      this.def.ropes.min, this.def.ropes.max);
    this.blocked = false;
    if (old.yaw === this.yaw && old.angle === this.angle && old.length === this.ropeLength) {
      if (this.payload) this.payload.body.velocity = v3();
      return;
    }
    this.pose();
    if (this.alive(this.hook) && this.obstructed()) {
      this.blocked = true;
      this.yaw = old.yaw; this.angle = old.angle; this.ropeLength = old.length;
      this.pose();
      if (this.payload) this.payload.body.velocity = v3();
      return;
    }
    this.resizeRopes();
    if (this.alive(this.stay)) this.resizeStay();
    this.moveLoad(dt);
    for (const body of [this.house, this.boom, this.hook, this.ropes, this.stay]) {
      if (this.alive(body)) this.sim.physics.sync(body);
    }
  }

  private pose(): void {
    const rotation = quatFromEulerYXZ(this.yaw, 0);
    if (this.alive(this.house)) this.house.transform.rotation = rotation;
    if (this.alive(this.boom)) {
      this.boom.transform.position = transformPoint(this.house.transform, sub(this.def.boom.pivot, this.def.house.pivot));
      this.boom.transform.rotation = quatFromEulerYXZ(this.yaw, this.angle - this.def.angle);
    }
    if (this.alive(this.hook)) {
      this.hook.transform.position = add(this.tip, v3(0, -this.ropeLength, 0));
      this.hook.transform.rotation = rotation;
    }
    if (this.alive(this.ropes)) {
      this.ropes.transform.position = add(this.tip, v3(0, -this.ropeLength, 0));
      this.ropes.transform.rotation = rotation;
    }
    if (this.alive(this.stay)) {
      const from = transformPoint(this.house.transform, sub(this.def.stay.from, this.def.house.pivot));
      const to = transformPoint(this.boom.transform, sub(this.def.stay.to, this.def.boom.pivot));
      const dir = normalize(sub(to, from));
      const up = v3(0, 1, 0);
      const cosine = clamp(dot(up, dir), -1, 1);
      this.stay.transform = { position: from, rotation: cosine > 0.999999 ? quatIdentity()
        : quatFromAxisAngle(cosine < -0.999999 ? v3(1, 0, 0) : cross(up, dir), Math.acos(cosine)) };
    }
  }

  private obstructed(): boolean {
    const ignore = new Set(this.bodyIds);
    if (this.payload) ignore.add(this.payload.body.id);
    if (bodyOverlapsWorld(this.sim.world, this.hook, this.hook.transform, ignore)) return true;
    const hit = this.sim.world.raycast(this.tip, v3(0, -1, 0), {
      maxDistance: this.ropeLength, ignore, filter: mat => mat !== Mat.Air && mat !== Mat.Water && mat !== Mat.Paint,
    });
    if (hit) return true;
    if (this.payload) {
      const body = this.payload.body;
      const blocked = bodyOverlapsWorld(this.sim.world, body, this.loadPose(), ignore);
      if (blocked) return true;
    }
    return false;
  }

  private resizeRopes(): void {
    const s = this.ropeShape;
    const rows = Math.min(s.sy, Math.ceil(this.ropeLength / s.voxelSize));
    for (const x of this.liveColumns) for (let y = Math.min(rows, this.ropeRows); y < Math.max(rows, this.ropeRows); y++) {
      s.set(x, y, 0, y < rows ? Mat.Metal : Mat.Air);
      if (y < rows) s.paint.set(s.idx(x, y, 0), 0x1000000 | 0x4b5d67);
    }
    if (rows !== this.ropeRows) this.ropes.collidersDirty = true;
    this.ropeRows = rows;
  }

  private resizeStay(): void {
    const from = transformPoint(this.house.transform, sub(this.def.stay.from, this.def.house.pivot));
    const to = transformPoint(this.boom.transform, sub(this.def.stay.to, this.def.boom.pivot));
    const s = this.stayShape;
    const rows = Math.min(s.sy, Math.ceil(length(sub(to, from)) / s.voxelSize));
    for (let y = Math.min(rows, this.stayRows); y < Math.max(rows, this.stayRows); y++) {
      for (let z = 0; z < s.sz; z++) for (let x = 0; x < s.sx; x++) {
        s.set(x, y, z, y < rows ? Mat.HeavyMetal : Mat.Air);
        if (y < rows) s.paint.set(s.idx(x, y, z), 0x1000000 | 0x71838d);
      }
    }
    if (rows !== this.stayRows) this.stay.collidersDirty = true;
    this.stayRows = rows;
  }

  private release(body: Body): void {
    if (!body.kinematic) return;
    body.kinematic = false;
    body.tags.add('debris');
    body.wake();
    this.sim.physics.sync(body);
  }

  private checkDamage(): void {
    if (this.base.body.destroyed || !this.base.body.shapes.includes(this.base.shape) ||
        this.base.indices.every(i => this.base.shape.data[i] === Mat.Air)) {
      for (const body of [this.house, this.boom, this.hook, this.ropes, this.stay]) this.release(body);
      this.releaseLoad();
      return;
    }
    for (const part of this.parts) {
      if (!this.alive(part.body)) continue;
      if (part.shape.structureDirty) {
        const result = solveBodyStructure(part.body, { stress: false, incremental: true });
        for (const f of result.fragments) {
          this.sim.world.addBody(f.body);
          this.sim.physics.sync(f.body);
        }
        if (result.fragments.length) this.sim.world.events.emit('body:split', {
          source: part.body, fragments: result.fragments.map(f => f.body), reason: 'disconnected',
        });
      }
      if (part.anchors.every(i => part.shape.data[i] === Mat.Air)) this.release(part.body);
    }
    if (!this.alive(this.house)) {
      for (const body of [this.boom, this.hook, this.ropes, this.stay]) this.release(body);
    } else if (this.boomSupport.every(i => this.parts[0].shape.data[i] === Mat.Air)) this.release(this.boom);
    if (this.alive(this.stay)) {
      for (let y = 0; y < this.stayRows; y++) {
        let solids = 0;
        for (let z = 0; z < this.stayShape.sz; z++) for (let x = 0; x < this.stayShape.sx; x++) {
          if (this.stayShape.get(x, y, z) !== Mat.Air) solids++;
        }
        if (solids === 0) { this.release(this.stay); this.release(this.boom); break; }
      }
    } else this.release(this.boom);
    if (this.alive(this.ropes)) for (const x of [...this.liveColumns]) {
      for (let y = 0; y < this.ropeRows; y++) {
        if (this.ropeShape.get(x, y, 0) !== Mat.Air) continue;
        const voxels: number[] = [];
        for (let r = 0; r < this.ropeRows; r++) if (this.ropeShape.get(x, r, 0) !== Mat.Air) voxels.push(this.ropeShape.idx(x, r, 0));
        if (voxels.length) {
          const fragment = extractFragment(this.ropes, this.ropeShape, voxels).body;
          this.sim.world.addBody(fragment);
          this.sim.physics.sync(fragment);
        }
        this.liveColumns.delete(x);
        this.ropes.collidersDirty = true;
        break;
      }
    }
    if (!this.alive(this.boom) || this.liveColumns.size === 0) {
      this.release(this.hook); this.release(this.ropes);
    }
    if (!this.hoistIntact || this.payload?.body.destroyed || this.payload?.body.solidVoxels === 0) this.releaseLoad();
  }

  /** Крюк берёт отдельные ящики и обломки; карта и техника остаются на месте. */
  toggleLoad(): CraneLoadResult {
    if (this.payload) { this.releaseLoad(); return 'released'; }
    if (!this.hoistIntact) return 'broken';
    let nearest: Body | undefined;
    let best = 1.1;
    for (const body of this.sim.world.bodies.values()) {
      if (body.destroyed || body.passive || body.kind !== 'dynamic' || body.kinematic || body.solidVoxels === 0 ||
          body.tags.has('crane') || body.tags.has('target') || body.tags.has('vehicle') || body.tags.has('truck-load')) continue;
      const box = body.aabb();
      const at = v3(clamp(this.grip.x, box.min.x, box.max.x), clamp(this.grip.y, box.min.y, box.max.y), clamp(this.grip.z, box.min.z, box.max.z));
      const d = distance(this.grip, at);
      if (d < best) { nearest = body; best = d; }
    }
    if (!nearest) return 'empty';
    if (nearest.mass() > this.def.capacity) return 'overweight';
    // При зацеплении выбирается слабина: верх груза касается нижней
    // дуги крюка, а не висит под ним на невидимом промежутке.
    const box = nearest.aabb();
    const original = nearest.transform.position;
    nearest.transform.position = add(original, v3(
      this.grip.x - clamp(this.grip.x, box.min.x + .001, box.max.x - .001),
      Math.max(0, this.hook.aabb().min.y - box.max.y),
      this.grip.z - clamp(this.grip.z, box.min.z + .001, box.max.z - .001),
    ));
    const ignore = new Set(this.bodyIds); ignore.add(nearest.id);
    if (bodyOverlapsWorld(this.sim.world, nearest, nearest.transform, ignore)) {
      nearest.transform.position = original;
      return 'empty';
    }
    const rotation = quatFromEulerYXZ(-this.yaw, 0);
    this.payload = { body: nearest, offset: rotateVec(rotation, sub(nearest.transform.position, this.grip)),
      rotation: quatMultiply(rotation, nearest.transform.rotation), previous: { ...nearest.transform.position } };
    nearest.kinematic = true;
    nearest.tags.add('crane-load');
    nearest.wake();
    nearest.velocity = v3(); nearest.angularVelocity = v3();
    this.sim.physics.sync(nearest);
    return 'attached';
  }

  private loadPose() {
    const yaw = quatFromEulerYXZ(this.yaw, 0);
    return { position: add(this.grip, rotateVec(yaw, this.payload!.offset)),
      rotation: quatMultiply(yaw, this.payload!.rotation) };
  }

  private moveLoad(dt: number): void {
    if (!this.payload) return;
    const body = this.payload.body;
    body.transform = this.loadPose();
    body.velocity = scale(sub(body.transform.position, this.payload.previous), 1 / dt);
    this.payload.previous = { ...body.transform.position };
    this.sim.physics.sync(body);
  }

  private releaseLoad(): void {
    if (!this.payload) return;
    const body = this.payload.body;
    body.kinematic = false;
    body.tags.delete('crane-load');
    body.velocityDirty = true;
    body.wake();
    this.sim.physics.sync(body);
    this.payload = undefined;
  }
}
