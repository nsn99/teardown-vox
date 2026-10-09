import { Aabb, add, scale, v3 } from '@tvox/core';
import { AutomaticGate } from '@tvox/game';

/** A player grabs the panel and walks along its rail, then lets go. */
export function slideGate(gate: AutomaticGate, target: number, visitor: Aabb = { min: v3(-30, 0, -30), max: v3(-29, 2, -29) }): void {
  const box = gate.body.aabb();
  const point = v3((box.min.x + box.max.x) / 2, box.min.y + 1, (box.min.z + box.max.z) / 2);
  const direction = gate.def.axis === 'z' ? v3(1, 0, 0) : v3(0, 0, 1);
  const eye = add(point, scale(direction, -1)), shift = v3();
  shift[gate.def.axis ?? 'y'] = target - gate.opening * gate.def.rise;
  gate.grab(eye, direction, point); gate.pull(add(eye, shift), direction);
  for (let i = 0; i < 120; i++) gate.update(visitor, 1 / 60);
  gate.release();
}
