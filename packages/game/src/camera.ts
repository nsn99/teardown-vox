import { Vec3, VoxelWorld, add, clamp, normalize, scale, v3 } from '@tvox/core';

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

/**
 * Тряска камеры.
 *
 * Модель травмы: событие добавляет «травму» 0..1, она сама затухает, а
 * смещение считается как квадрат травмы. Квадрат — чтобы слабый удар
 * почти не мешал, а близкий взрыв бил заметно; линейная тряска ощущается
 * как дрожь рук на пустом месте.
 *
 * Главное требование приёмки — «тряска не мешает целиться». Поэтому
 * смещается только камера, а направление выстрела берётся от честного
 * курса игрока: картинка дёргается, прицел — нет.
 */
export interface ShakeOptions {
  /** За сколько секунд травма спадает полностью. */
  recovery?: number;
  /** Максимальный сдвиг камеры, м. */
  maxOffset?: number;
  /** Максимальный поворот, рад. */
  maxAngle?: number;
  /** Частота дрожания, Гц. */
  frequency?: number;
}

export interface ShakeState {
  /** Смещение камеры относительно глаз, м. */
  offset: Vec3;
  /** Довороты картинки, рад. */
  yaw: number;
  pitch: number;
  roll: number;
}

const SHAKE_DEFAULTS = {
  recovery: 1.4,
  maxOffset: 0.16,
  maxAngle: 0.05,
  frequency: 18,
} satisfies Required<ShakeOptions>;

export class CameraShake {
  private trauma = 0;
  private time = 0;
  private cfg: Required<ShakeOptions>;

  constructor(opts: ShakeOptions = {}) {
    this.cfg = { ...SHAKE_DEFAULTS, ...opts };
  }

  /** Текущая травма 0..1 — для интерфейса и звука. */
  get level(): number {
    return this.trauma;
  }

  /**
   * Добавить встряску от события в точке.
   * Дальше — слабее, квадратично: взрыв за сорок метров не должен
   * ощущаться так же, как за четыре.
   */
  add(strength: number, distance = 0, falloff = 30): void {
    const near = clamp(1 - distance / Math.max(1e-6, falloff), 0, 1);
    this.trauma = clamp(this.trauma + strength * near * near, 0, 1);
  }

  reset(): void {
    this.trauma = 0;
    this.time = 0;
  }

  /** Шаг и текущее состояние тряски. */
  update(dt: number): ShakeState {
    this.time += dt;
    this.trauma = clamp(this.trauma - dt / this.cfg.recovery, 0, 1);
    if (this.trauma <= 0) return { offset: v3(), yaw: 0, pitch: 0, roll: 0 };

    const power = this.trauma * this.trauma;
    const t = this.time * this.cfg.frequency;
    // Три синуса с несоизмеримыми частотами вместо шума: повторяемо,
    // не требует таблиц и на глаз неотличимо от случайного дрожания.
    const a = Math.sin(t * 1.0) * Math.sin(t * 0.37);
    const b = Math.sin(t * 1.31 + 1.7) * Math.sin(t * 0.53);
    const c = Math.sin(t * 0.79 + 3.1) * Math.sin(t * 0.61);

    return {
      offset: v3(a * this.cfg.maxOffset * power, b * this.cfg.maxOffset * power, c * this.cfg.maxOffset * power),
      yaw: b * this.cfg.maxAngle * power,
      pitch: c * this.cfg.maxAngle * power,
      roll: a * this.cfg.maxAngle * power,
    };
  }
}
