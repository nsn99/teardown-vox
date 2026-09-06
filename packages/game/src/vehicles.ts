import {
  Body,
  Mat,
  Quat,
  Simulation,
  Vec3,
  VoxelShape,
  add,
  carve,
  clamp,
  quatFromEulerYXZ,
  scale,
  v3,
} from '@tvox/core';
import { overlapsSolid } from './character.js';

export type VehicleKind = 'car' | 'pickup' | 'boat' | 'excavator' | 'bulldozer';

export interface VehicleSpec {
  kind: VehicleKind;
  name: string;
  /** Габариты кузова в вокселях. */
  size: { x: number; y: number; z: number };
  material: Mat;
  /** м/с. */
  maxSpeed: number;
  reverseSpeed: number;
  /** м/с². */
  accel: number;
  brake: number;
  /** рад/с на полной скорости руля. */
  turnRate: number;
  /** Плавает: держится на уровне воды и не едет по суше. */
  aquatic: boolean;
  /** Едет и по воде, и по суше. */
  amphibious: boolean;
  /**
   * Отвал/ковш: сила и радиус прорезания вокселей впереди.
   * Обычная машина пробивает стену только на скорости, бульдозер — всегда.
   */
  blade: { power: number; halfWidth: number; halfHeight: number; reach: number } | null;
  /** Скорость, ниже которой обычный корпус уже ничего не ломает. */
  ramSpeed: number;
}

export const VEHICLES: Record<VehicleKind, VehicleSpec> = {
  car: {
    kind: 'car',
    name: 'Легковая',
    size: { x: 38, y: 14, z: 18 },
    material: Mat.Metal,
    maxSpeed: 22,
    reverseSpeed: 6,
    accel: 9,
    brake: 16,
    turnRate: 1.9,
    aquatic: false,
    amphibious: false,
    blade: null,
    ramSpeed: 9,
  },
  pickup: {
    kind: 'pickup',
    name: 'Пикап',
    size: { x: 46, y: 17, z: 20 },
    material: Mat.Metal,
    maxSpeed: 19,
    reverseSpeed: 6,
    accel: 8,
    brake: 15,
    turnRate: 1.6,
    aquatic: false,
    amphibious: false,
    blade: null,
    ramSpeed: 8,
  },
  boat: {
    kind: 'boat',
    name: 'Катер',
    size: { x: 52, y: 16, z: 22 },
    material: Mat.Metal,
    maxSpeed: 17,
    reverseSpeed: 5,
    accel: 5,
    brake: 6,
    turnRate: 1.1,
    aquatic: true,
    amphibious: false,
    blade: null,
    ramSpeed: 12,
  },
  excavator: {
    kind: 'excavator',
    name: 'Экскаватор',
    size: { x: 55, y: 30, z: 28 },
    material: Mat.HeavyMetal,
    maxSpeed: 6,
    reverseSpeed: 4,
    accel: 4,
    brake: 8,
    turnRate: 1.0,
    aquatic: false,
    amphibious: false,
    blade: { power: 0.62, halfWidth: 0.9, halfHeight: 0.7, reach: 2.2 },
    ramSpeed: 3,
  },
  bulldozer: {
    kind: 'bulldozer',
    name: 'Бульдозер',
    size: { x: 60, y: 26, z: 34 },
    material: Mat.HeavyMetal,
    maxSpeed: 8,
    reverseSpeed: 4,
    accel: 5,
    brake: 10,
    turnRate: 0.9,
    aquatic: false,
    amphibious: false,
    blade: { power: 0.68, halfWidth: 1.5, halfHeight: 0.9, reach: 1.6 },
    ramSpeed: 2,
  },
};

export interface VehicleInput {
  /** -1..1. Отрицательное — назад. */
  throttle: number;
  /** -1..1. Положительное — вправо. */
  steer: number;
  brake: boolean;
  /** Ковш/отвал опущен: режет воксели даже на месте. */
  blade: boolean;
}

export const NEUTRAL_INPUT: VehicleInput = { throttle: 0, steer: 0, brake: false, blade: false };

/** Насколько щуп вынесен за бампер, м. */
const PROBE_MARGIN = 0.15;
/** Полуразмер щупа, м. */
const PROBE_HALF = 0.3;

export interface VehicleOptions {
  position: Vec3;
  yaw?: number;
  voxelSize?: number;
  /** Уровень воды по Y. */
  waterLevel?: number;
}

/**
 * Управляемая техника.
 *
 * Кинематическая модель: позиция, курс, скорость вдоль курса. Аркадно,
 * зато предсказуемо и не разваливается, когда под колёсами исчезает
 * половина уровня. Взаимодействие с вокселями — главное: на скорости
 * корпус пробивает стену, а отвал бульдозера расчищает завал стоя.
 */
export class Vehicle {
  readonly spec: VehicleSpec;
  readonly body: Body;
  position: Vec3;
  yaw: number;
  speed = 0;
  /** Разрушено — больше не едет. */
  wrecked = false;
  /** Сколько вокселей было в целом корпусе. */
  readonly initialVoxels: number;
  private voxelSize: number;
  private waterLevel: number;

  constructor(kind: VehicleKind, opts: VehicleOptions) {
    this.spec = VEHICLES[kind];
    this.position = { ...opts.position };
    this.yaw = opts.yaw ?? 0;
    this.voxelSize = opts.voxelSize ?? 0.1;
    this.waterLevel = opts.waterLevel ?? 0;

    const { x, y, z } = this.spec.size;
    const shape = new VoxelShape({
      sx: x,
      sy: y,
      sz: z,
      voxelSize: this.voxelSize,
      grounded: false,
      name: `${kind}-hull`,
    });
    // Корпус полый: сплошной металлический параллелепипед размером
    // с пикап весил бы сто тонн и продавливал набережную одним фактом
    // своего существования.
    const wall = 2;
    shape.fill({}, this.spec.material);
    shape.fill(
      { x0: wall, x1: x - wall, y0: wall, y1: y - wall, z0: wall, z1: z - wall },
      Mat.Air,
    );
    // Рама по низу: без неё корпус разваливается от первого же удара.
    shape.fill({ y0: 0, y1: wall + 1 }, this.spec.material);
    // Кабина из стекла — узнаваемый силуэт и повод для дробовика.
    shape.fill(
      { x0: Math.floor(x * 0.45), x1: Math.floor(x * 0.75), y0: y - 4, y1: y, z0: 2, z1: z - 2 },
      Mat.Glass,
    );
    // Центрируем корпус относительно точки позиции.
    shape.transform = {
      position: v3((-x / 2) * this.voxelSize, 0, (-z / 2) * this.voxelSize),
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    };

    this.body = new Body({
      kind: 'dynamic',
      shapes: [shape],
      name: this.spec.name,
      tags: ['vehicle', kind],
      kinematic: true,
      transform: { position: { ...this.position }, rotation: quatFromEulerYXZ(opts.yaw ?? 0, 0) },
    });
    this.body.transform.rotation = this.orientation;
    this.initialVoxels = this.body.solidVoxels;
  }

  get forward(): Vec3 {
    return v3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  /**
   * Ориентация корпуса. Локальная ось +X формы должна смотреть вперёд,
   * а «вперёд» у нас при yaw=0 — это мировая -Z (общая договорённость
   * с камерой и контроллером игрока). Отсюда доворот на 90°.
   */
  get orientation(): Quat {
    return quatFromEulerYXZ(this.yaw + Math.PI / 2, 0);
  }

  /** Точка, из которой машина «смотрит» вперёд — перед бампером. */
  get nose(): Vec3 {
    const half = (this.spec.size.x / 2) * this.voxelSize;
    return add(this.position, scale(this.forward, half));
  }

  spawn(sim: Simulation): Body {
    sim.world.addBody(this.body);
    sim.physics.sync(this.body);
    return this.body;
  }

  get inWater(): boolean {
    return this.position.y <= this.waterLevel + 0.05;
  }

  /** Может ли техника сейчас двигаться в этой среде. */
  canDrive(): boolean {
    if (this.wrecked) return false;
    if (this.spec.amphibious) return true;
    return this.spec.aquatic ? this.inWater : !this.inWater;
  }

  update(sim: Simulation, input: VehicleInput, dt: number): void {
    if (this.wrecked) return;

    // Корпус развалился больше чем наполовину — техника мертва.
    if (this.body.solidVoxels < this.initialVoxels * 0.45) {
      this.wrecked = true;
      this.speed = 0;
      return;
    }

    if (!this.canDrive()) {
      this.speed = approach(this.speed, 0, this.spec.brake * dt);
    } else {
      const throttle = clamp(input.throttle, -1, 1);
      const target =
        throttle >= 0 ? throttle * this.spec.maxSpeed : throttle * this.spec.reverseSpeed;
      const rate = input.brake
        ? this.spec.brake
        : Math.abs(target) > Math.abs(this.speed)
          ? this.spec.accel
          : this.spec.brake * 0.5;
      this.speed = approach(this.speed, input.brake ? 0 : target, rate * dt);
    }

    // Руль работает только когда машина катится.
    const steerFactor = clamp(Math.abs(this.speed) / Math.max(1, this.spec.maxSpeed * 0.35), 0, 1);
    this.yaw -= clamp(input.steer, -1, 1) * this.spec.turnRate * steerFactor * dt * Math.sign(this.speed || 1);

    const delta = scale(this.forward, this.speed * dt);
    const next = add(this.position, delta);

    const blocked = this.probeBlocked(sim, next);
    if (blocked) {
      const punched = this.punchThrough(sim, input, dt);
      if (!punched) {
        this.speed *= 0.15;
      } else {
        this.position = next;
      }
    } else {
      this.position = next;
    }

    // Катер держится на плаву, но не взлетает на воду с суши:
    // выброшенный на берег он просто стоит.
    if (this.spec.aquatic && this.position.y <= this.waterLevel) {
      this.position.y = this.waterLevel;
    }
    if (input.blade && this.spec.blade) this.dig(sim, dt);

    this.syncBody();
  }

  private syncBody(): void {
    this.body.transform.position = { ...this.position };
    this.body.transform.rotation = this.orientation;
    this.body.wake();
  }

  private probeBlocked(sim: Simulation, next: Vec3): boolean {
    // Щуп сидит прямо на бампере и намеренно маленький.
    // Коробка размером с машину «чувствовала» бы стену за три метра,
    // а таран при этом резал бы воксели в метре перед собой — машина
    // вставала бы, ничего не пробив.
    const half = (this.spec.size.x / 2) * this.voxelSize;
    const probe = add(next, scale(this.forward, half + PROBE_MARGIN));
    const r = PROBE_HALF;
    const box = {
      min: v3(probe.x - r, probe.y + 0.15, probe.z - r),
      max: v3(probe.x + r, probe.y + this.spec.size.y * this.voxelSize, probe.z + r),
    };
    return scanIgnoring(sim, box, new Set([this.body.id]));
  }

  /**
   * Таран: на скорости корпус прорезает воксели впереди. Чем быстрее,
   * тем больше дыра — именно так «пробить стену на скорости» и работает.
   */
  private punchThrough(sim: Simulation, input: VehicleInput, dt: number): boolean {
    const speed = Math.abs(this.speed);
    const useBlade = input.blade && this.spec.blade;
    if (!useBlade && speed < this.spec.ramSpeed) return false;

    const blade = this.spec.blade;
    // Потолок 0.55 — ниже прочности стали: корпусом сталь не берут
    // ни на какой скорости, для неё есть лампа и заряд.
    const power = useBlade ? blade!.power : clamp(0.15 + speed * 0.02, 0, 0.55);
    const halfW = useBlade ? blade!.halfWidth : (this.spec.size.z / 2) * this.voxelSize;
    const halfH = useBlade ? blade!.halfHeight : (this.spec.size.y / 2) * this.voxelSize;
    const reach = useBlade ? blade!.reach : clamp(speed * 0.06, 0.15, 0.9);

    const center = add(this.nose, scale(this.forward, reach * 0.5));
    const res = carve(
      sim.world,
      {
        kind: 'box',
        center: v3(center.x, center.y + halfH, center.z),
        halfExtents: v3(reach, halfH, halfW),
        rotation: this.orientation,
      },
      {
        power,
        damage: 0,
        instant: true,
        falloff: 'none',
        cause: useBlade ? 'blade' : 'ram',
        ignoreBodies: new Set([this.body.id]),
      },
    );

    if (res.removed === 0) return false;
    // Удар о стену гасит скорость, но не останавливает намертво.
    this.speed *= useBlade ? 0.85 : 0.7;
    void dt;
    return true;
  }

  /** Ковш: расчистка завала на месте. */
  private dig(sim: Simulation, dt: number): void {
    const blade = this.spec.blade;
    if (!blade) return;
    const center = add(this.nose, scale(this.forward, blade.reach * 0.5));
    carve(
      sim.world,
      {
        kind: 'box',
        center: v3(center.x, center.y + blade.halfHeight * 0.6, center.z),
        halfExtents: v3(blade.reach, blade.halfHeight, blade.halfWidth),
        rotation: this.orientation,
      },
      {
        power: blade.power,
        damage: 200 * dt * 60,
        falloff: 'none',
        cause: 'bucket',
        ignoreBodies: new Set([this.body.id]),
      },
    );
  }
}

function approach(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

function scanIgnoring(
  sim: Simulation,
  box: { min: Vec3; max: Vec3 },
  ignore: ReadonlySet<number>,
): boolean {
  const hidden: Body[] = [];
  for (const id of ignore) {
    const b = sim.world.bodies.get(id);
    if (b && !b.destroyed) {
      hidden.push(b);
      b.destroyed = true;
    }
  }
  try {
    return overlapsSolid(sim.world, box);
  } finally {
    for (const b of hidden) b.destroyed = false;
  }
}
