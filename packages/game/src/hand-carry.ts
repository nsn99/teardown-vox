import { Aabb, Body, Simulation, Vec3, normalize, aabbOverlaps, add, bodySolidBounds, distance, scale, sub, v3 } from '@tvox/core';
import { overlapsSolid } from './character.js';

/** Gameplay limits for one person, including awkward but light objects. */
export const HAND_LIMITS = { mass: 30, length: 2.5, volume: 1.5, reach: 2.4 };
export class HandCarry {
  body: Body | null = null;
  message = '';

  pick(sim: Simulation, eye: Vec3, direction: Vec3): boolean {
    const hit = sim.world.raycast(eye, direction, { maxDistance: HAND_LIMITS.reach });
    if (!hit) { this.message = 'Подойдите ближе и наведите на предмет'; return false; }
    const source = hit.body;
    const merged = source.tags.has('debris-field');
    const thaw = merged || source.tags.has('frozen');
    const b = merged ? new Body({ kind: 'dynamic', shapes: [hit.shape], name: 'Обломок', tags: ['debris'],
      transform: structuredClone(source.transform) }) : source;
    if ((b.passive && !thaw) || b.kinematic || b.tags.has('vehicle') || [...b.tags].some(t => t.startsWith('target:')) ||
        b.shapes.some(s => s.grounded || s.attachments.size > 0 || s.attachmentAnchors.size > 0)) {
      this.message = 'Предмет закреплён'; return false;
    }
    const box = bodySolidBounds(b), size = sub(box.max, box.min);
    if (b.mass() > HAND_LIMITS.mass) { this.message = `Слишком тяжело: ${Math.ceil(b.mass())} кг (предел ${HAND_LIMITS.mass} кг)`; return false; }
    if (Math.max(size.x, size.y, size.z) > HAND_LIMITS.length || size.x * size.y * size.z > HAND_LIMITS.volume) {
      this.message = 'Предмет слишком большой для переноски'; return false;
    }
    if (merged) {
      source.removeShape(hit.shape); source.collidersImmediate = true;
      sim.physics.sync(source); sim.world.addBody(b);
    }
    if (thaw) { b.passive = false; b.tags.delete('frozen'); }
    this.body = b;
    b.kind = 'dynamic'; b.kinematic = true; b.velocity = v3(); b.angularVelocity = v3(); b.wake();
    sim.physics.sync(b);
    this.message = `В руках: ${Math.ceil(b.mass())} кг · E — положить · ЛКМ — бросить`;
    return true;
  }

  update(sim: Simulation, eye: Vec3, direction: Vec3, player: Aabb): void {
    const b = this.body;
    if (!b) return;
    if (b.destroyed || !sim.world.bodies.has(b.id) || b.solidVoxels === 0) { this.drop(sim); return; }
    const box = bodySolidBounds(b), centre = scale(add(box.min, box.max), .5);
    if (distance(centre, eye) > 3.5) { this.drop(sim); return; }
    const size = sub(box.max, box.min);
    const reach = Math.min(2.1, .8 + Math.max(size.x, size.y, size.z) * .5);
    const target = add(add(eye, scale(direction, reach)), v3(0, -.22, 0));
    const delta = sub(target, centre);
    const steps = Math.max(1, Math.ceil(distance(target, centre) / .04));
    const start = { ...b.transform.position }, ignore = new Set([b.id]);
    for (let i = 1; i <= steps; i++) {
      const shift = scale(delta, i / steps);
      const next = { min: add(box.min, shift), max: add(box.max, shift) };
      if (aabbOverlaps(next, player) || overlapsSolid(sim.world, next, ignore)) break;
      b.transform.position = add(start, shift);
    }
    b.velocity = v3(); b.angularVelocity = v3();
    sim.physics.sync(b);
  }

  drop(sim: Simulation): Body | null {
    const b = this.body; this.body = null;
    if (b) { b.kinematic = false; b.velocity = v3(); b.angularVelocity = v3(); b.velocityDirty = true; b.wake(); sim.physics.sync(b); }
    this.message = 'Предмет отпущен';
    return b;
  }

  throw(sim: Simulation, direction: Vec3, inherited = v3()): Body | null {
    const body = this.drop(sim);
    if (!body) return null;
    // One person's finite effort: a brick flies faster than a 30 kg crate.
    const speed = Math.min(9, Math.sqrt(240 / Math.max(.5, body.mass())));
    body.velocity = add(inherited, scale(normalize(direction), speed));
    body.angularVelocity = v3(1.2, .5, -.8); body.velocityDirty = true; body.wake(); sim.physics.sync(body);
    this.message = 'Предмет брошен';
    return body;
  }

  snapshot(): number | null { return this.body?.id ?? null; }
  restore(id: number | null | undefined, bodies: Map<number, Body>): void {
    this.body = id == null ? null : bodies.get(id) ?? null;
  }
}
