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


function addVehicleCabin(
  shape: VoxelShape,
  material: Mat,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
): void {
  // Металлическая оболочка кабины с пустым салоном.
  shape.fill({ x0, x1, y0, y1, z0, z1 }, material);
  shape.fill(
    { x0: x0 + 1, x1: x1 - 1, y0: y0 + 1, y1: y1 - 1, z0: z0 + 1, z1: z1 - 1 },
    Mat.Air,
  );

  const wy0 = y0 + 2;
  const wy1 = y1 - 1;
  if (wy1 <= wy0) return;

  // Боковые окна.
  shape.fill({ x0: x0 + 2, x1: x1 - 2, y0: wy0, y1: wy1, z0, z1: z0 + 1 }, Mat.Glass);
  shape.fill({ x0: x0 + 2, x1: x1 - 2, y0: wy0, y1: wy1, z0: z1 - 1, z1 }, Mat.Glass);

  // Переднее и заднее стёкла.
  shape.fill({ x0, x1: x0 + 1, y0: wy0, y1: wy1, z0: z0 + 2, z1: z1 - 2 }, Mat.Glass);
  shape.fill({ x0: x1 - 1, x1, y0: wy0, y1: wy1, z0: z0 + 2, z1: z1 - 2 }, Mat.Glass);
}

function buildVehicleHull(shape: VoxelShape, kind: VehicleKind, material: Mat): void {
  const x = shape.sx;
  const y = shape.sy;
  const z = shape.sz;

  // Машину собираем из деталей, а не вырезаем из полного параллелепипеда.
  // Так пустое пространство вокруг кабины, колёс, гусениц и рабочего
  // оборудования действительно остаётся пустым.
  shape.fill({}, Mat.Air);

  switch (kind) {
    case 'car': {
      // Колёса выступают ниже и шире кузова.
      for (const wx of [5, 27]) {
        shape.fill({ x0: wx, x1: wx + 7, y0: 0, y1: 4, z0: 0, z1: 3 }, material);
        shape.fill({ x0: wx, x1: wx + 7, y0: 0, y1: 4, z0: z - 3, z1: z }, material);
      }

      // Рама и нижняя часть кузова.
      shape.fill({ x0: 1, x1: x - 1, y0: 3, y1: 7, z0: 2, z1: z - 2 }, material);

      // Низкие багажник и капот.
      shape.fill({ x0: 1, x1: 10, y0: 7, y1: 9, z0: 2, z1: z - 2 }, material);
      shape.fill({ x0: 29, x1: x - 1, y0: 7, y1: 9, z0: 2, z1: z - 2 }, material);

      addVehicleCabin(shape, material, 10, 29, 6, y, 3, z - 3);
      break;
    }

    case 'pickup': {
      for (const wx of [6, 33]) {
        shape.fill({ x0: wx, x1: wx + 7, y0: 0, y1: 5, z0: 0, z1: 3 }, material);
        shape.fill({ x0: wx, x1: wx + 7, y0: 0, y1: 5, z0: z - 3, z1: z }, material);
      }

      shape.fill({ x0: 1, x1: x - 1, y0: 4, y1: 8, z0: 2, z1: z - 2 }, material);

      // Открытый грузовой кузов с низким полом и тремя бортами.
      shape.fill({ x0: 1, x1: 23, y0: 8, y1: 9, z0: 2, z1: z - 2 }, material);
      shape.fill({ x0: 1, x1: 23, y0: 9, y1: 12, z0: 1, z1: 3 }, material);
      shape.fill({ x0: 1, x1: 23, y0: 9, y1: 12, z0: z - 3, z1: z - 1 }, material);
      shape.fill({ x0: 1, x1: 3, y0: 9, y1: 12, z0: 2, z1: z - 2 }, material);

      addVehicleCabin(shape, material, 23, 38, 7, y, 3, z - 3);

      // Капот.
      shape.fill({ x0: 38, x1: x - 1, y0: 7, y1: 11, z0: 2, z1: z - 2 }, material);
      break;
    }

    case 'boat': {
      // Низ корпуса: узкий киль.
      shape.fill({ x0: 2, x1: 39, y0: 0, y1: 2, z0: 8, z1: 14 }, material);

      // Корма широкая, к носу корпус ступенчато сужается.
      shape.fill({ x0: 1, x1: 30, y0: 2, y1: 5, z0: 4, z1: 18 }, material);
      shape.fill({ x0: 30, x1: 39, y0: 2, y1: 5, z0: 5, z1: 17 }, material);
      shape.fill({ x0: 39, x1: 45, y0: 2, y1: 5, z0: 7, z1: 15 }, material);
      shape.fill({ x0: 45, x1: 49, y0: 3, y1: 6, z0: 9, z1: 13 }, material);
      shape.fill({ x0: 49, x1: 52, y0: 4, y1: 7, z0: 10, z1: 12 }, material);

      // Верхние борта повторяют тот же клиновидный нос.
      shape.fill({ x0: 0, x1: 31, y0: 5, y1: 8, z0: 2, z1: 20 }, material);
      shape.fill({ x0: 31, x1: 40, y0: 5, y1: 8, z0: 4, z1: 18 }, material);
      shape.fill({ x0: 40, x1: 46, y0: 5, y1: 8, z0: 6, z1: 16 }, material);
      shape.fill({ x0: 46, x1: 50, y0: 6, y1: 9, z0: 8, z1: 14 }, material);
      shape.fill({ x0: 50, x1: 52, y0: 7, y1: 10, z0: 10, z1: 12 }, material);

      // Палуба не доходит до самого носа.
      shape.fill({ x0: 2, x1: 43, y0: 8, y1: 9, z0: 3, z1: 19 }, material);

      // Небольшая рубка ближе к корме.
      addVehicleCabin(shape, material, 8, 24, 8, y - 2, 6, z - 6);
      break;
    }

    case 'excavator': {
      // Две отдельные гусеницы.
      shape.fill({ x0: 2, x1: 47, y0: 0, y1: 6, z0: 1, z1: 6 }, material);
      shape.fill({ x0: 2, x1: 47, y0: 0, y1: 6, z0: z - 6, z1: z - 1 }, material);

      // Шасси связывает гусеницы.
      shape.fill({ x0: 8, x1: 42, y0: 4, y1: 9, z0: 5, z1: z - 5 }, material);

      // Противовес и моторный отсек сзади.
      shape.fill({ x0: 3, x1: 22, y0: 9, y1: 18, z0: 6, z1: z - 6 }, material);

      // Кабина сбоку.
      addVehicleCabin(shape, material, 18, 35, 10, 27, 3, 15);

      // Центральный шарнир.
      shape.fill({ x0: 29, x1: 36, y0: 13, y1: 20, z0: 10, z1: 18 }, material);

      // Ступенчатая стрела.
      shape.fill({ x0: 34, x1: 42, y0: 18, y1: 22, z0: 11, z1: 17 }, material);
      shape.fill({ x0: 40, x1: 48, y0: 20, y1: 24, z0: 11, z1: 17 }, material);
      shape.fill({ x0: 46, x1: 52, y0: 14, y1: 22, z0: 11, z1: 17 }, material);

      // Ковш впереди и ниже стрелы.
      shape.fill({ x0: 50, x1: x, y0: 7, y1: 15, z0: 8, z1: 20 }, material);
      shape.fill({ x0: 48, x1: x, y0: 7, y1: 10, z0: 6, z1: 22 }, material);
      break;
    }

    case 'bulldozer': {
      // Гусеницы с большим пустым промежутком между ними.
      shape.fill({ x0: 3, x1: 50, y0: 0, y1: 7, z0: 1, z1: 7 }, material);
      shape.fill({ x0: 3, x1: 50, y0: 0, y1: 7, z0: z - 7, z1: z - 1 }, material);

      // Рама.
      shape.fill({ x0: 8, x1: 49, y0: 4, y1: 9, z0: 6, z1: z - 6 }, material);

      // Кабина сзади.
      addVehicleCabin(shape, material, 9, 29, 8, 24, 7, z - 7);

      // Низкий моторный отсек перед кабиной.
      shape.fill({ x0: 29, x1: 50, y0: 8, y1: 14, z0: 8, z1: z - 8 }, material);

      // Две тяги отвала.
      shape.fill({ x0: 47, x1: 56, y0: 5, y1: 9, z0: 5, z1: 10 }, material);
      shape.fill({ x0: 47, x1: 56, y0: 5, y1: 9, z0: z - 10, z1: z - 5 }, material);

      // Сам отвал — тонкая широкая пластина впереди машины.
      shape.fill({ x0: 55, x1: x, y0: 2, y1: 14, z0: 1, z1: z - 1 }, material);
      break;
    }
  }
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
  /** Цели, лежащие в кузове. Едут вместе с машиной. */
  readonly cargo = new Set<string>();
  private flooded = 0;
  private drowned = 0;
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
    buildVehicleHull(shape, kind, this.spec.material);

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

  /** Целость корпуса, 0..1. */
  get hullIntegrity(): number {
    return this.initialVoxels === 0 ? 0 : this.body.solidVoxels / this.initialVoxels;
  }

  /** Набранная вода, 0..1. Единица — утонул. */
  get flooding(): number {
    return this.flooded;
  }

  /**
   * Насколько корпус ещё держит на воде.
   *
   * Пробоина топит не мгновенно: катер сначала садится, теряет ход и
   * только потом уходит под воду. Это даёт игроку шанс догрести до
   * причала — и делает дырку в борту решением, а не приговором.
   */
  get buoyancy(): number {
    return clamp(1 - this.flooded, 0, 1);
  }

  /** Может ли техника сейчас двигаться в этой среде. */
  canDrive(): boolean {
    if (this.wrecked) return false;
    if (this.flooded >= 1) return false;
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

    this.updateWater(dt);
    if (this.wrecked) return;

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
    // выброшенный на берег он просто стоит. Пробитый корпус садится тем
    // глубже, чем больше набрал воды.
    if (this.spec.aquatic && this.position.y <= this.waterLevel) {
      this.position.y = this.waterLevel - this.flooded * SINK_DEPTH;
    }
    if (input.blade && this.spec.blade) this.dig(sim, dt);

    this.syncBody();
  }

  /**
   * Вода в корпусе.
   *
   * У катера течь считается от пробоин: чем меньше осталось корпуса, тем
   * быстрее набирается вода. У колёсной техники всё проще — утопил, значит
   * заглохла: двигатель под водой не работает, и никакая целость корпуса
   * этого не меняет.
   */
  private updateWater(dt: number): void {
    if (this.spec.aquatic) {
      const breach = Math.max(0, HULL_TIGHT - this.hullIntegrity);
      if (breach > 0) this.flooded = clamp(this.flooded + breach * FLOOD_RATE * dt, 0, 1);
      if (this.flooded >= 1) {
        this.wrecked = true;
        this.speed = 0;
      }
      return;
    }

    if (!this.spec.amphibious && this.position.y < this.waterLevel - DROWN_DEPTH) {
      this.drowned += dt;
      this.speed = approach(this.speed, 0, this.spec.brake * 2 * dt);
      if (this.drowned > DROWN_SECONDS) {
        this.wrecked = true;
        this.speed = 0;
      }
    } else {
      this.drowned = 0;
    }
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
    // Проверяем препятствие со стороны фактического движения.
    // При заднем ходе щуп должен быть у заднего бампера, иначе стена
    // перед носом не даёт машине отъехать от неё.
    const motionDir = this.speed < 0 ? scale(this.forward, -1) : this.forward;
    const probe = add(next, scale(motionDir, half + PROBE_MARGIN));
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
    const useBlade = input.blade && this.spec.blade && this.speed >= 0;
    if (!useBlade && speed < this.spec.ramSpeed) return false;

    const blade = this.spec.blade;
    // Потолок 0.55 — ниже прочности стали: корпусом сталь не берут
    // ни на какой скорости, для неё есть лампа и заряд.
    const power = useBlade ? blade!.power : clamp(0.15 + speed * 0.02, 0, 0.55);
    const halfW = useBlade ? blade!.halfWidth : (this.spec.size.z / 2) * this.voxelSize;
    const halfH = useBlade ? blade!.halfHeight : (this.spec.size.y / 2) * this.voxelSize;
    const reach = useBlade ? blade!.reach : clamp(speed * 0.06, 0.15, 0.9);

    const direction = scale(this.forward, this.speed < 0 ? -1 : 1);
    const bumper = add(this.position, scale(direction, this.spec.size.x * this.voxelSize / 2));
    const center = add(bumper, scale(direction, reach * 0.5));
    const impact = v3(center.x, center.y + halfH, center.z);
    const side = v3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    // Скруглённый скол должен очищать не только центр, но и весь щуп:
    // иначе верхние углы проёма снова останавливают машину.
    const radius = Math.hypot(halfH, PROBE_HALF) + this.voxelSize * 0.5;
    const span = Math.max(0, halfW - radius);
    const ignore = new Set([this.body.id]);
    for (const body of sim.world.bodies.values()) {
      if (body.tags.has('carved-debris')) ignore.add(body.id);
    }
    const res = carve(
      sim.world,
      useBlade ? {
        kind: 'box', center: impact,
        halfExtents: v3(reach, halfH, halfW), rotation: this.orientation,
      } : {
        kind: 'capsule',
        a: add(impact, scale(side, -span)),
        b: add(impact, scale(side, span)),
        radius,
      },
      {
        power,
        damage: 0,
        instant: true,
        falloff: 'none',
        cause: useBlade ? 'blade' : 'ram',
        ignoreBodies: ignore,
        physicalDebris: useBlade ? undefined : {
          velocity: add(scale(direction, speed * 0.3), v3(0, 1.5, 0)),
        },
      },
    );

    if (res.removed === 0) return false;
    // Удар о стену гасит скорость, но не останавливает намертво.
    const next = add(this.position, scale(this.forward, this.speed * dt));
    this.speed *= useBlade ? 0.85 : 0.7;
    // Снятая древесина рядом со сталью ещё не означает свободный проход.
    return !this.probeBlocked(sim, next);
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

/** Ниже этой целости корпуса катер начинает набирать воду. */
const HULL_TIGHT = 0.92;
/** Скорость затопления при полностью разбитом корпусе, доли в секунду. */
const FLOOD_RATE = 1.4;
/** Насколько глубоко садится полностью затопленный корпус, м. */
const SINK_DEPTH = 1.2;
/** Глубина, ниже которой колёсная техника считается утопленной, м. */
const DROWN_DEPTH = 0.35;
/** Сколько секунд под водой выдерживает двигатель. */
const DROWN_SECONDS = 1.5;

/** Точка кузова, где едет груз: над центром, ближе к корме. */
export const CARGO_OFFSET = { x: 0, y: 0.9, z: -0.6 };

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
  // Мелкие выбитые куски толкает физика. Они не блокируют щуп и не
  // превращаются повторно в новые обломки от того же бампера.
  const ignored = new Set(ignore);
  for (const body of sim.world.bodies.values()) {
    if (body.tags.has('carved-debris')) ignored.add(body.id);
  }
  for (const id of ignored) {
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
