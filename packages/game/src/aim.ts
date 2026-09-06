import { SmokeField, Vec3, add, cross, normalize, scale, v3 } from '@tvox/core';

/**
 * Прицел в дыму.
 *
 * «Дым мешает целиться» должно означать именно это, а не «поверх кадра
 * нарисованы серые кляксы». Поэтому дым уводит луч инструмента: чем
 * плотнее завеса между глазом и точкой, тем меньше шансов попасть туда,
 * куда целился.
 *
 * Увод детерминированный — по сиду. Случайность, которую нельзя
 * воспроизвести, ломает и тесты, и разбор полётов после неудачного
 * захода: «я же целился в колонну» должно быть проверяемым
 * утверждением, а не спором.
 */

/** Максимальный увод в сплошном дыму, рад. Около двух градусов. */
const MAX_SPREAD = 0.035;
/** Ниже этой непрозрачности рука не дрожит вовсе. */
const FLOOR = 0.08;

export interface AimThroughSmoke {
  /** Направление с учётом дыма. */
  direction: Vec3;
  /** Непрозрачность завесы, 0..1 — для интерфейса и звука. */
  opacity: number;
}

/**
 * Увести направление прицела по плотности дыма на пути.
 *
 * Отклонение считается в плоскости, перпендикулярной взгляду: увод вбок
 * и вверх, а не «ближе-дальше» — по дальности дым не врёт.
 */
export function aimThroughSmoke(
  smoke: SmokeField,
  origin: Vec3,
  direction: Vec3,
  distance: number,
  rng: () => number,
): AimThroughSmoke {
  const dir = normalize(direction);
  const to = add(origin, scale(dir, distance));
  const opacity = smoke.opacityAlong(origin, to);
  if (opacity <= FLOOR) return { direction: dir, opacity };

  // Квадрат непрозрачности: лёгкая дымка почти не мешает, густая — сильно.
  const spread = MAX_SPREAD * opacity * opacity;
  const angle = rng() * Math.PI * 2;
  const amount = spread * Math.sqrt(rng());

  // Любой вектор, не сонаправленный со взглядом, даёт нам базис.
  const up = Math.abs(dir.y) > 0.9 ? v3(1, 0, 0) : v3(0, 1, 0);
  const right = normalize(cross(dir, up));
  const top = cross(right, dir);

  const offset = add(
    scale(right, Math.cos(angle) * amount),
    scale(top, Math.sin(angle) * amount),
  );
  return { direction: normalize(add(dir, offset)), opacity };
}
