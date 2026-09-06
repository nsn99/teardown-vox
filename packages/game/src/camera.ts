import { Vec3, VoxelWorld, add, normalize, scale, v3 } from '@tvox/core';

/**
 * Камера от третьего лица.
 *
 * Всё интересное здесь — одна строчка про трассировку: камера не имеет
 * права оказаться за стеной. Причём подтягивать её надо к точке удара
 * лучом, а не «выталкивать» после того, как она уже провалилась: второй
 * способ даёт кадр в бетоне на каждом резком повороте у стены.
 *
 * Логика чистая и живёт в игре, а не в приложении: провал камеры сквозь
 * геометрию — баг, который надо ловить тестом, а не глазами.
 */

export interface ChaseOptions {
  /** Желаемое удаление от цели, м. */
  distance: number;
  /** Подъём над целью, м. */
  height: number;
  /** Ближе этого не подтягиваем: иначе камера влезает внутрь машины. */
  minDistance?: number;
  /** Зазор до стены, м. */
  margin?: number;
  /** Тела, которые камера не замечает: своя техника, несомая цель. */
  ignore?: ReadonlySet<number>;
}

/** Направление взгляда по курсу и тангажу. */
export function lookDirection(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return normalize(v3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp));
}

/**
 * Точка камеры позади цели с учётом препятствий.
 * Возвращает саму цель, если места нет вообще — лучше вид «изнутри»,
 * чем вид из бетона.
 */
export function chaseCamera(
  world: VoxelWorld,
  focus: Vec3,
  yaw: number,
  pitch: number,
  opts: ChaseOptions,
): Vec3 {
  const margin = opts.margin ?? 0.35;
  const minDistance = opts.minDistance ?? 0.6;
  const pivot = v3(focus.x, focus.y + opts.height, focus.z);
  const back = scale(lookDirection(yaw, pitch), -1);

  const hit = world.raycast(pivot, back, {
    maxDistance: opts.distance + margin,
    ...(opts.ignore ? { ignore: opts.ignore } : {}),
  });

  const room = hit ? hit.distance - margin : opts.distance;
  if (room <= minDistance) return { ...pivot };
  return add(pivot, scale(back, Math.min(room, opts.distance)));
}
