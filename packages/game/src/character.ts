import {
  Aabb,
  Mat,
  Vec3,
  VoxelWorld,
  aabbOverlaps,
  clamp,
  inverseTransformPoint,
  v3,
} from '@tvox/core';

export interface CharacterInput {
  /** -1..1, вперёд/назад относительно взгляда. */
  forward: number;
  /** -1..1, вправо/влево. */
  right: number;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
}

export interface CharacterOptions {
  position?: Vec3;
  /** Полуширина коробки игрока, м. */
  halfWidth?: number;
  height?: number;
  crouchHeight?: number;
  walkSpeed?: number;
  sprintSpeed?: number;
  crouchSpeed?: number;
  swimSpeed?: number;
  jumpSpeed?: number;
  /** На какую высоту игрок сам заходит без прыжка (обломки, бордюр). */
  stepHeight?: number;
  gravity?: number;
  /** Ускорение набора скорости на земле и в воздухе. */
  groundAccel?: number;
  airAccel?: number;
  maxFallSpeed?: number;
}

const DEFAULTS = {
  halfWidth: 0.28,
  height: 1.75,
  crouchHeight: 1.0,
  walkSpeed: 4.2,
  sprintSpeed: 6.8,
  crouchSpeed: 2.0,
  swimSpeed: 2.6,
  jumpSpeed: 5.1,
  stepHeight: 0.55,
  gravity: 19.0,
  groundAccel: 45,
  airAccel: 9,
  maxFallSpeed: 45,
} satisfies Required<Omit<CharacterOptions, 'position'>>;

export interface CharacterState {
  position: Vec3;
  velocity: Vec3;
  onGround: boolean;
  crouching: boolean;
  inWater: boolean;
  height: number;
}

/**
 * Контроллер игрока: коробка против вокселей, движение по осям с откатом.
 *
 * Разбор по осям (X, потом Y, потом Z) с автоматическим шагом вверх —
 * это то, что делает разрушенный уровень проходимым: игрок сам
 * забирается на завалы, не превращая каждый обломок в стену.
 */
export class CharacterController {
  private cfg: Required<Omit<CharacterOptions, 'position'>>;
  /** Позиция ног. */
  position: Vec3;
  velocity: Vec3 = v3();
  onGround = false;
  crouching = false;
  inWater = false;

  constructor(opts: CharacterOptions = {}) {
    const { position, ...rest } = opts;
    this.cfg = { ...DEFAULTS, ...rest };
    this.position = position ? { ...position } : v3(0, 0, 0);
  }

  get height(): number {
    return this.crouching ? this.cfg.crouchHeight : this.cfg.height;
  }

  /** Точка глаз — отсюда стреляет прицел. */
  get eye(): Vec3 {
    return v3(this.position.x, this.position.y + this.height - 0.18, this.position.z);
  }

  aabbAt(p: Vec3, height = this.height): Aabb {
    const h = this.cfg.halfWidth;
    return {
      min: v3(p.x - h, p.y, p.z - h),
      max: v3(p.x + h, p.y + height, p.z + h),
    };
  }

  get state(): CharacterState {
    return {
      position: { ...this.position },
      velocity: { ...this.velocity },
      onGround: this.onGround,
      crouching: this.crouching,
      inWater: this.inWater,
      height: this.height,
    };
  }

  teleport(p: Vec3): void {
    this.position = { ...p };
    this.velocity = v3();
    this.onGround = false;
  }

  /**
   * Шаг движения. yaw — направление взгляда вокруг Y (радианы).
   * dt желательно фиксированный: контроллер сам дробит длинные шаги,
   * но детерминизм всё равно приятнее.
   */
  update(world: VoxelWorld, input: CharacterInput, yaw: number, dt: number): void {
    const cfg = this.cfg;

    // Приседание отпускаем только если сверху есть место.
    const wantCrouch = input.crouch;
    if (this.crouching && !wantCrouch) {
      if (!overlapsSolid(world, this.aabbAt(this.position, cfg.height))) this.crouching = false;
    } else {
      this.crouching = wantCrouch;
    }

    this.inWater = overlapsMaterial(world, this.aabbAt(this.position), Mat.Water);

    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // Взгляд по -Z при yaw=0 — стандарт для правой системы с Y вверх.
    const wishX = -sin * input.forward + cos * input.right;
    const wishZ = -cos * input.forward - sin * input.right;
    const wishLen = Math.hypot(wishX, wishZ);

    const speed = this.inWater
      ? cfg.swimSpeed
      : this.crouching
        ? cfg.crouchSpeed
        : input.sprint
          ? cfg.sprintSpeed
          : cfg.walkSpeed;

    const targetX = wishLen > 0 ? (wishX / wishLen) * speed : 0;
    const targetZ = wishLen > 0 ? (wishZ / wishLen) * speed : 0;

    const accel = this.onGround || this.inWater ? cfg.groundAccel : cfg.airAccel;
    this.velocity.x = approach(this.velocity.x, targetX, accel * dt);
    this.velocity.z = approach(this.velocity.z, targetZ, accel * dt);

    if (this.inWater) {
      // Выталкивающая сила: в воде тонешь медленно, всплываешь пробелом.
      this.velocity.y = approach(this.velocity.y, input.jump ? 2.4 : -0.9, 12 * dt);
    } else {
      if (input.jump && this.onGround) {
        this.velocity.y = cfg.jumpSpeed;
        this.onGround = false;
      }
      this.velocity.y = Math.max(-cfg.maxFallSpeed, this.velocity.y - cfg.gravity * dt);
    }

    this.integrate(world, dt);
  }

  /** Дробим перемещение так, чтобы за подшаг не проскочить воксель. */
  private integrate(world: VoxelWorld, dt: number): void {
    const maxStep = 0.05;
    const dist = Math.hypot(this.velocity.x * dt, this.velocity.y * dt, this.velocity.z * dt);
    const sub = Math.max(1, Math.min(16, Math.ceil(dist / maxStep)));
    const h = dt / sub;
    for (let i = 0; i < sub; i++) this.integrateOnce(world, h);
  }

  private integrateOnce(world: VoxelWorld, dt: number): void {
    const cfg = this.cfg;

    // --- X ---
    if (this.velocity.x !== 0) {
      const next = v3(this.position.x + this.velocity.x * dt, this.position.y, this.position.z);
      if (overlapsSolid(world, this.aabbAt(next))) {
        if (!this.tryStepUp(world, next)) this.velocity.x = 0;
      } else {
        this.position = next;
      }
    }

    // --- Z ---
    if (this.velocity.z !== 0) {
      const next = v3(this.position.x, this.position.y, this.position.z + this.velocity.z * dt);
      if (overlapsSolid(world, this.aabbAt(next))) {
        if (!this.tryStepUp(world, next)) this.velocity.z = 0;
      } else {
        this.position = next;
      }
    }

    // --- Y ---
    const nextY = v3(this.position.x, this.position.y + this.velocity.y * dt, this.position.z);
    if (overlapsSolid(world, this.aabbAt(nextY))) {
      if (this.velocity.y <= 0) {
        this.onGround = true;
        // Прижимаемся к опоре с точностью до сантиметра.
        this.position.y = snapDown(world, this, this.position.y, nextY.y);
      }
      this.velocity.y = 0;
    } else {
      this.position = nextY;
      this.onGround = false;
      // Проверка «есть ли пол прямо под ногами» — иначе игрок «висит»
      // один кадр после каждого микроперемещения по склону.
      const probe = v3(this.position.x, this.position.y - 0.02, this.position.z);
      if (this.velocity.y <= 0 && overlapsSolid(world, this.aabbAt(probe))) this.onGround = true;
    }

    void cfg;
  }

  /** Пробуем зайти на препятствие высотой не больше stepHeight. */
  private tryStepUp(world: VoxelWorld, target: Vec3): boolean {
    if (!this.onGround && !this.inWater) return false;
    const step = this.cfg.stepHeight;
    for (let lift = 0.1; lift <= step + 1e-6; lift += 0.1) {
      const raised = v3(target.x, this.position.y + lift, target.z);
      if (!overlapsSolid(world, this.aabbAt(raised))) {
        this.position = raised;
        return true;
      }
    }
    return false;
  }
}

function approach(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

function snapDown(
  world: VoxelWorld,
  ch: CharacterController,
  freeY: number,
  blockedY: number,
): number {
  let lo = blockedY;
  let hi = freeY;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    if (overlapsSolid(world, ch.aabbAt(v3(ch.position.x, mid, ch.position.z)))) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Есть ли в коробке хоть один твёрдый воксель (вода — не твёрдая). */
export function overlapsSolid(world: VoxelWorld, box: Aabb): boolean {
  return scanAabb(world, box, (mat) => mat !== Mat.Air && mat !== Mat.Water && mat !== Mat.Paint);
}

export function overlapsMaterial(world: VoxelWorld, box: Aabb, mat: number): boolean {
  return scanAabb(world, box, (m) => m === mat);
}

/**
 * Обход вокселей, попавших в коробку.
 *
 * Для повёрнутых тел берём консервативный локальный AABB по восьми углам:
 * пара лишних вокселей на проверку дешевле, чем полноценный SAT, а
 * уровень всё равно выровнен по осям.
 */
function scanAabb(world: VoxelWorld, box: Aabb, accept: (mat: number) => boolean): boolean {
  for (const body of world.bodies.values()) {
    if (body.destroyed) continue;
    if (!aabbOverlaps(body.aabb(), box)) continue;

    for (const shape of body.shapes) {
      if (shape.solidVoxels === 0) continue;
      const s = shape.voxelSize;
      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;

      for (let i = 0; i < 8; i++) {
        const corner = v3(
          i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z,
        );
        const local = inverseTransformPoint(
          shape.transform,
          inverseTransformPoint(body.transform, corner),
        );
        if (local.x < minX) minX = local.x;
        if (local.y < minY) minY = local.y;
        if (local.z < minZ) minZ = local.z;
        if (local.x > maxX) maxX = local.x;
        if (local.y > maxY) maxY = local.y;
        if (local.z > maxZ) maxZ = local.z;
      }

      // Ужимаем коробку на микрон: касание грань-в-грань не должно
      // считаться пересечением, иначе игрок «прилипает» к полу, на который
      // только что встал, и не может с него шагнуть.
      const e = 1e-6;
      const rx0 = Math.floor((minX + e) / s);
      const ry0 = Math.floor((minY + e) / s);
      const rz0 = Math.floor((minZ + e) / s);
      const rx1 = Math.ceil((maxX - e) / s);
      const ry1 = Math.ceil((maxY - e) / s);
      const rz1 = Math.ceil((maxZ - e) / s);
      if (rx1 <= 0 || ry1 <= 0 || rz1 <= 0) continue;
      if (rx0 >= shape.sx || ry0 >= shape.sy || rz0 >= shape.sz) continue;

      const x0 = clamp(rx0, 0, shape.sx - 1);
      const y0 = clamp(ry0, 0, shape.sy - 1);
      const z0 = clamp(rz0, 0, shape.sz - 1);
      const x1 = clamp(rx1, 0, shape.sx);
      const y1 = clamp(ry1, 0, shape.sy);
      const z1 = clamp(rz1, 0, shape.sz);

      for (let y = y0; y < y1; y++) {
        for (let z = z0; z < z1; z++) {
          const base = (y * shape.sz + z) * shape.sx;
          for (let x = x0; x < x1; x++) {
            if (accept(shape.data[base + x])) return true;
          }
        }
      }
    }
  }
  return false;
}
