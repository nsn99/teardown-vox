import { Body, SerializedShape, VoxelShape, decodeRle } from '@tvox/core';
import { Heist } from './heist.js';

/** Only geometry changed since level construction is copied/encoded. */
export class SessionCheckpoint {
  private bodies: Body[];
  private shapes: VoxelShape[];
  private revisions: number[];
  private fingerprint: string;
  private geometry = new WeakMap<VoxelShape, { revision: number; json: SerializedShape }>();

  constructor(private h: Heist) {
    this.bodies = [...h.sim.world.bodies.values()];
    this.shapes = this.bodies.flatMap(b => b.shapes);
    this.revisions = this.shapes.map(s => s.revision);
    // Hash the actual baseline, not runtime IDs (which change on each reload).
    let hash = 2166136261;
    for (const shape of this.shapes) for (const material of shape.data) hash = Math.imul(hash ^ material, 16777619);
    this.fingerprint = JSON.stringify([hash >>> 0, h.level.spawn, h.level.vehicles, h.level.gates, h.level.cranes,
      h.level.mission, this.bodies.map(b => [b.name, b.transform]),
      this.shapes.map(s => [s.name, s.sx, s.sy, s.sz, s.voxelSize, s.transform])]);
  }

  capture() {
    const h = this.h;
    return structuredClone({ version: 1 as const, fingerprint: this.fingerprint, levelId: h.level.id, savedAt: Date.now(), sandbox: h.sandbox,
      bodies: [...new Set([...this.bodies, ...h.sim.world.bodies.values()])].map(b => ({
        id: b.id, base: this.bodies.indexOf(b), kind: b.kind, name: b.name, tags: [...b.tags],
        passive: b.passive, kinematic: b.kinematic, transform: b.transform,
        velocity: b.velocity, angularVelocity: b.angularVelocity, sleeping: b.sleeping,
        restTime: b.restTime, fractureOnImpact: b.fractureOnImpact, fracturePoint: b.fracturePoint, fractureSpeed: b.fractureSpeed,
        destroyed: b.destroyed || !h.sim.world.bodies.has(b.id),
        shapes: b.shapes.map(s => {
          const base = this.shapes.indexOf(s);
          let json: SerializedShape | undefined;
          if (base < 0 || s.revision !== this.revisions[base]) {
            let cached = this.geometry.get(s);
            if (!cached || cached.revision !== s.revision) {
              cached = { revision: s.revision, json: s.toJSON() };
              cached.json.paint = []; // Paint is stored once, in a compact typed array below.
              this.geometry.set(s, cached);
            }
            json = cached.json;
          }
          const damage: [number, number][] = [];
          if (json) for (let i = 0; i < s.damage.length; i++) if (s.damage[i]) damage.push([i, s.damage[i]]);
          const paint = new Uint32Array(s.paint.size * 2); let p = 0;
          for (const [index, color] of s.paint) { paint[p++] = index; paint[p++] = color; }
          return { id: s.id, base, json, damage, transform: s.transform, grounded: s.grounded,
            structural: s.structural, paint, attachments: [...s.attachments], anchors: [...s.attachmentAnchors] };
        }),
      })),
      hand: h.hands.snapshot(), heist: h.snapshot(), triggers: h.triggers.snapshot(), mission: h.mission.snapshot(), inventory: h.inventory.snapshot(), character: h.character.state,
      yaw: h.yaw, pitch: h.pitch, drivingId: h.drivingId, operatingId: h.operatingId, time: h.sim.world.time,
      vehicles: [...h.vehicles].map(([id, v]) => ({ id, state: v.snapshot(), deck: v.deck?.snapshot(), forklift: v.forklift?.snapshot() })),
      cranes: [...h.cranes].map(([id, c]) => ({ id, state: c.snapshot() })),
      gates: h.gates.map(g => g.snapshot()), charges: h.charges.list(), destruction: h.sim.destruction.snapshot(),
      fire: h.sim.fire.snapshot(), smoke: h.sim.smoke.snapshot(),
      chasers: h.pursuit.chasers.map(c => c.snapshot()),
    });
  }

  restore(saved: SessionSave): void {
    const h = this.h;
    if (saved.version !== 1 || saved.levelId !== h.level.id || saved.sandbox !== h.sandbox || saved.fingerprint !== this.fingerprint) throw new Error('Несовместимое сохранение');
    const bodies = new Map<number, Body>(), shapes = new Map<number, VoxelShape>();
    const retainedShapes = new Set(saved.bodies.flatMap(b => b.shapes.map(s => s.base)).filter(i => i >= 0));
    // Call only on a newly constructed level, before the first physics step.
    for (const record of saved.bodies) {
      const b = record.base < 0 ? new Body() : this.bodies[record.base];
      if (!b) throw new Error('Карта сохранения изменилась');
      bodies.set(record.id, b);
      const restored = record.shapes.map(r => {
        const shape = r.base < 0 && r.json ? VoxelShape.fromJSON(r.json) : this.shapes[r.base];
        if (!shape) throw new Error('Форма сохранения отсутствует');
        if (r.json && r.base >= 0) {
          if (shape.sx !== r.json.sx || shape.sy !== r.json.sy || shape.sz !== r.json.sz) throw new Error('Размер карты изменился');
          decodeRle(r.json.rle, shape.data); shape.recountSolid(); shape.structureScanned = false;
          // Every chunk is dirty, without allocating a list of every voxel.
          for (let y = 0; y < shape.sy; y += 32) for (let z = 0; z < shape.sz; z += 32)
            for (let x = 0; x < shape.sx; x += 32) shape.markDirty(x, y, z);
        }
        shape.damage.fill(0); for (const [i, amount] of r.damage) shape.damage[i] = amount;
        shape.transform = structuredClone(r.transform); shape.grounded = r.grounded; shape.structural = r.structural;
        shape.paint.clear(); for (let p = 0; p < r.paint.length; p += 2) shape.paint.set(r.paint[p], r.paint[p + 1]);
        shape.attachmentAnchors.clear(); for (const i of r.anchors) shape.attachmentAnchors.add(i);
        shapes.set(r.id, shape); return shape;
      });
      for (const shape of b.shapes) if (!restored.includes(shape) && !retainedShapes.has(this.shapes.indexOf(shape))) shape.fill({ x0: 0, y0: 0, z0: 0, x1: shape.sx, y1: shape.sy, z1: shape.sz }, 0);
      b.shapes = restored; b.kind = record.kind; b.name = record.name; b.tags = new Set(record.tags);
      b.passive = record.passive; b.kinematic = record.kinematic; b.transform = structuredClone(record.transform);
      b.velocity = { ...record.velocity }; b.angularVelocity = { ...record.angularVelocity };
      b.sleeping = record.sleeping; b.restTime = record.restTime;
      b.fractureOnImpact = record.fractureOnImpact; b.fracturePoint = { ...record.fracturePoint }; b.fractureSpeed = record.fractureSpeed;
      b.velocityDirty = true; b.collidersDirty = true; b.collidersImmediate = true;
      if (record.destroyed) { h.sim.world.removeBody(b); b.destroyed = true; }
      else if (record.base < 0) h.sim.world.addBody(b);
    }
    for (const b of saved.bodies) for (const r of b.shapes) {
      const shape = shapes.get(r.id)!; shape.attachments.clear();
      for (const [i, a] of r.attachments) {
        const body = bodies.get(a.bodyId), support = shapes.get(a.shapeId);
        if (body && support) shape.attachments.set(i, { bodyId: body.id, shapeId: support.id, index: a.index });
      }
    }
    h.sim.world.reindex();
    h.hands.restore(saved.hand, bodies);
    h.restore(saved.heist); h.triggers.restore(saved.triggers); h.mission.restore(saved.mission); h.inventory.restore(saved.inventory);
    h.character.teleport(saved.character.position); h.character.velocity = { ...saved.character.velocity };
    h.character.onGround = saved.character.onGround; h.character.inWater = saved.character.inWater;
    h.character.crouching = saved.character.crouching;
    h.yaw = saved.yaw; h.pitch = saved.pitch; h.drivingId = saved.drivingId; h.operatingId = saved.operatingId;
    h.sim.world.time = saved.time;
    for (const r of saved.vehicles) { const v = h.vehicles.get(r.id); if (!v) continue;
      v.restore(r.state); if (r.forklift) v.forklift?.restore(r.forklift, bodies); if (r.deck) v.deck?.restore(r.deck, bodies); }
    for (const r of saved.cranes) h.cranes.get(r.id)?.restore(r.state, bodies);
    saved.gates.forEach((r, i) => h.gates[i]?.restore(r));
    h.sim.destruction.restore(saved.destruction, new Map([...bodies].map(([old, body]) => [old, body.id])));
    h.charges.restore(saved.charges); h.sim.fire.restore(saved.fire, bodies, shapes); h.sim.smoke.restore(saved.smoke);
    saved.chasers.forEach((r, i) => h.pursuit.chasers[i]?.restore(r, bodies));
    for (const b of h.sim.world.bodies.values()) h.sim.physics.sync(b);
  }
}

export type SessionSave = ReturnType<SessionCheckpoint['capture']>;
