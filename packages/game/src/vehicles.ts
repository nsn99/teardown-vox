import {
  Body,
  Transform,
  Mat,
  Quat,
  Simulation,
  Vec3,
  VoxelShape,
  add,
  carve,
  bodyOverlapsWorld,
  bodyMovementBlocked,
  bodySolidBounds,
  clamp,
  dot,
  length,
  quatFromEulerYXZ,
  scale,
  sub,
  transformPoint,
  inverseTransformPoint,
  rotateVec,
  rotateVecInverse,
  v3,
} from '@tvox/core';
import { overlapsSolid } from './character.js';
import { VehicleFootprint, dentVehicle, vehicleContact, vehicleContactPoint } from './vehicle-contact.js';
import { VehicleWheel, buildVehicleWheels, wheelPose } from './vehicle-wheels.js';
import { VehicleSupportPoint, vehicleOrientation, vehicleSupport } from './vehicle-support.js';
import { TruckDeck } from './truck-deck.js';
import { VehicleTrack, buildVehicleTracks } from './vehicle-tracks.js';

const vehicleBodies = new WeakMap<Body, Vehicle>();

export type VehicleKind = 'car' | 'pickup' | 'truck' | 'boat' | 'excavator' | 'bulldozer';

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
   * Работает только при удержании кнопки; не вырезает опору под машиной.
   */
  blade: { power: number; halfWidth: number; halfHeight: number; reach: number } | null;
  /** Скорость, ниже которой обычный корпус уже ничего не ломает. */
  ramSpeed: number;
}

export const VEHICLES: Record<VehicleKind, VehicleSpec> = {
  truck: {
    kind: 'truck', name: 'Грузовик', size: { x: 96, y: 29, z: 34 }, material: Mat.Metal,
    maxSpeed: 14, reverseSpeed: 5, accel: 3.5, brake: 9, turnRate: 0.65,
    aquatic: false, amphibious: false, blade: null, ramSpeed: 10,
  },
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
    blade: { power: 1.1, halfWidth: 0.9, halfHeight: 0.7, reach: 2.2 },
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
    blade: { power: 1.1, halfWidth: 1.5, halfHeight: 0.9, reach: 1.6 },
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
  /** -1 lower, +1 raise. Working edge cuts automatically while moving. */
  bladeLift?: number;
}

export const NEUTRAL_INPUT: VehicleInput = { throttle: 0, steer: 0, brake: false, blade: false };
export type VehicleRecoveryResult = 'recovered' | 'moving' | 'blocked' | 'broken' | 'upright';

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
    case 'truck': {
      shape.fill({ x0: 2, x1: 95, y0: 5, y1: 9, z0: 5, z1: z - 5 }, material);
      // Длинная открытая платформа: кран опускает груз сверху.
      shape.fill({ x0: 2, x1: 66, y0: 10, y1: 12, z0: 1, z1: z - 1 }, material);
      shape.fill({ x0: 2, x1: 66, y0: 12, y1: 16, z0: 0, z1: 1 }, material);
      shape.fill({ x0: 2, x1: 66, y0: 12, y1: 16, z0: z - 1, z1: z }, material);
      shape.fill({ x0: 2, x1: 3, y0: 12, y1: 16, z0: 1, z1: z - 1 }, material);
      shape.fill({ x0: 64, x1: 66, y0: 12, y1: 22, z0: 1, z1: z - 1 }, material);
      addVehicleCabin(shape, material, 67, 94, 9, y, 1, z - 1);
      shape.fill({ x0: 93, x1: x, y0: 5, y1: 10, z0: 1, z1: z - 1 }, material);
      for (let by = 0; by < y; by++) for (let bz = 0; bz < z; bz++) for (let bx = 0; bx < x; bx++) {
        const index = shape.idx(bx, by, bz);
        if (shape.data[index] === Mat.Air || shape.data[index] === Mat.Glass) continue;
        shape.paint.set(index, 0x1000000 | (bx >= 67 && by >= 10 ? 0xcb543c : by >= 12 ? 0x8295a2 : 0x394b57));
      }
      for (const bz of [3, z - 5]) {
        shape.fill({ x0: 94, x1: 96, y0: 7, y1: 9, z0: bz, z1: bz + 2 }, Mat.Plastic);
        for (let by = 7; by < 9; by++) for (let b = bz; b < bz + 2; b++) for (let bx = 94; bx < 96; bx++) {
          shape.paint.set(shape.idx(bx, by, b), 0x1f5d58a);
        }
      }
      // Контрастная деревянная платформа и четыре метки места погрузки.
      for (let bx = 3; bx < 64; bx++) for (let bz = 1; bz < z - 1; bz++) {
        const corner = (bx < 9 || bx >= 58) && (bz < 4 || bz >= z - 4);
        shape.paint.set(shape.idx(bx, 11, bz), 0x1000000 | (corner ? 0xe9bd52 : bx % 4 ? 0x9b8062 : 0x776049));
      }
      break;
    }
    case 'car': {
      // Рама и нижняя часть кузова.
      shape.fill({ x0: 1, x1: x - 1, y0: 3, y1: 7, z0: 2, z1: z - 2 }, material);

      // Низкие багажник и капот.
      shape.fill({ x0: 1, x1: 10, y0: 7, y1: 9, z0: 2, z1: z - 2 }, material);
      shape.fill({ x0: 29, x1: x - 1, y0: 7, y1: 9, z0: 2, z1: z - 2 }, material);

      addVehicleCabin(shape, material, 10, 29, 6, y, 3, z - 3);
      break;
    }

    case 'pickup': {
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
      // Две низкие гусеницы со скошенными концами, а не общий нижний бокс.
      for (const z0 of [1, z - 8]) {
        const z1 = z0 + 7;
        shape.fill({ x0: 9, x1: 43, y0: 0, y1: 8, z0, z1 }, material);
        shape.fill({ x0: 5, x1: 9, y0: 2, y1: 7, z0, z1 }, material);
        shape.fill({ x0: 43, x1: 48, y0: 2, y1: 7, z0, z1 }, material);
        shape.fill({ x0: 3, x1: 5, y0: 4, y1: 6, z0, z1 }, material);
        shape.fill({ x0: 48, x1: 50, y0: 4, y1: 6, z0, z1 }, material);
      }

      // Узкая рама, высокая кабина и низкий капот читаются по отдельности.
      shape.fill({ x0: 8, x1: 44, y0: 5, y1: 11, z0: 8, z1: z - 8 }, material);
      shape.fill({ x0: 5, x1: 9, y0: 8, y1: 13, z0: 9, z1: z - 9 }, material);
      addVehicleCabin(shape, material, 7, 25, 10, y - 1, 10, z - 10);
      shape.fill({ x0: 6, x1: 26, y0: y - 1, y1: y, z0: 9, z1: z - 9 }, material);
      shape.fill({ x0: 25, x1: 43, y0: 9, y1: 15, z0: 10, z1: z - 10 }, material);
      shape.fill({ x0: 28, x1: 39, y0: 15, y1: 16, z0: 11, z1: z - 11 }, material);
      // Выхлопная труба над капотом.
      shape.fill({ x0: 32, x1: 34, y0: 16, y1: 23, z0: 10, z1: 12 }, material);

      // Подвижные телескопические тяги добавляются отдельными формами.
      // Наклонная поверхность и загнутые края отвала.
      for (let by = 3; by < 14; by++) for (let bz = 1; bz < z - 1; bz++) {
        const edge = bz < 4 || bz >= z - 4 ? 1 : 0;
        const bx = 57 - Math.floor((by - 3) / 4) + edge;
        shape.fill({ x0: bx, x1: bx + 2, y0: by, y1: by + 1, z0: bz, z1: bz + 1 }, material);
      }
      shape.fill({ x0: 57, x1: x, y0: 1, y1: 3, z0: 0, z1: z }, material);

      // Цвет не меняет прочность: корпус и гусеницы остаются тяжёлой сталью.
      // Старый одинаково серый материал скрадывал детали даже у нового силуэта.
      for (let by = 0; by < y; by++) for (let bz = 0; bz < z; bz++) for (let bx = 0; bx < x; bx++) {
        const index = shape.idx(bx, by, bz);
        if (shape.data[index] === Mat.Air || shape.data[index] === Mat.Glass) continue;
        const track = by < 8 && bx < 51 && (bz < 8 || bz >= z - 8);
        const exhaust = bx >= 32 && bx < 34 && by >= 16 && bz >= 10 && bz < 12;
        const color = track ? (bx % 4 === 0 ? 0x59616a : 0x252b31)
          : exhaust ? 0x353b42 : bx >= 54 ? 0xa6b0ba : 0xe9b438;
        // Маркер RGB: маленькие значения paint зарезервированы под палитру баллончика.
        shape.paint.set(index, 0x1000000 | color);
      }
      break;
    }
  }
}

/**
 * Управляемая техника.
 *
 * Управление мотором сочетается с опорой на воксели, падением и обменом
 * импульсом между кузовами. Столкновение сминает панели в точке контакта.
 */
export class Vehicle {
  readonly spec: VehicleSpec;
  readonly body: Body;
  readonly wheels: VehicleWheel[];
  readonly tracks: VehicleTrack[];
  readonly deck: TruckDeck | null;
  position: Vec3;
  yaw: number;
  speed = 0;
  speedLimit = 1;
  bladeHeight = 0;
  readonly bladeShape: VoxelShape | null;
  readonly bladeLinks: VoxelShape[] = [];
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
  private initialHullVoxels: number;
  private slide = v3();
  private verticalSpeed = 0;
  private impactDelay = 0;
  private yawSpeed = 0;
  private waterSurface: number | null;
  grounded = false;
  steeringAngle = 0;
  wheelRotation = 0;
  pitch = 0;
  roll = 0;
  private physicalPrevious = v3();
  private readonly feet: VehicleSupportPoint[];

  constructor(kind: VehicleKind, opts: VehicleOptions) {
    this.spec = VEHICLES[kind];
    this.position = { ...opts.position };
    this.yaw = opts.yaw ?? 0;
    this.voxelSize = opts.voxelSize ?? 0.1;
    this.waterLevel = opts.waterLevel ?? 0;
    this.waterSurface = this.waterLevel;

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
    this.bladeShape = this.spec.blade ? new VoxelShape({ sx: x, sy: y, sz: z,
      voxelSize: this.voxelSize, grounded: false, name: `${kind}-blade` }) : null;
    if (this.bladeShape) {
      this.bladeShape.structural = false;
      for (let bx = kind === 'bulldozer' ? 54 : 48; bx < x; bx++)
        for (let by = 0; by < (kind === 'bulldozer' ? y : 15); by++)
          for (let bz = 0; bz < z; bz++) {
            this.bladeShape.set(bx, by, bz, shape.get(bx, by, bz));
            const index = shape.idx(bx, by, bz), color = shape.paint.get(index);
            if (color !== undefined) this.bladeShape.paint.set(index, color);
            shape.paint.delete(index);
            shape.set(bx, by, bz, Mat.Air);
          }
    }
    if (kind === 'bulldozer') {
      for (const side of [-1, 1]) for (const section of ['cylinder', 'piston']) {
        const thick = section === 'cylinder' ? 3 : 2;
        const link = new VoxelShape({ sx: 13, sy: thick, sz: thick, voxelSize: this.voxelSize,
          name: `blade-${side}-${section}`, grounded: false });
        link.fill({}, Mat.HeavyMetal); link.structural = false;
        for (let i=0;i<link.data.length;i++) link.paint.set(i, 0x1000000 | (section==='cylinder'?0xe9b438:0xb8c4c9));
        this.bladeLinks.push(link);
      }
      this.poseBladeLinks();
    }
    this.wheels = kind === 'car' || kind === 'pickup' || kind === 'truck' ? buildVehicleWheels(kind, this.voxelSize, v3(x, y, z)) : [];
    this.tracks = buildVehicleTracks(kind, this.voxelSize);
    for (const wheel of this.wheels) {
      const cx = wheel.center.x / this.voxelSize + x / 2;
      const outer = wheel.center.z < 0 ? { z0: 0, z1: 4 } : { z0: z - 4, z1: z };
      shape.fill({ x0: Math.floor(cx - wheel.radius / this.voxelSize - 1),
        x1: Math.ceil(cx + wheel.radius / this.voxelSize + 1), y0: 0, y1: wheel.shape.sy + 1, ...outer }, Mat.Air);
    }
    this.initialHullVoxels = shape.solidVoxels;

    // Центрируем корпус относительно точки позиции.
    shape.transform = {
      position: v3((-x / 2) * this.voxelSize, 0, (-z / 2) * this.voxelSize),
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    };
    if (this.bladeShape) this.bladeShape.transform = structuredClone(shape.transform);

    this.body = new Body({
      kind: 'dynamic',
      shapes: [shape, ...this.wheels.map(wheel => wheel.shape), ...(this.bladeShape ? [this.bladeShape] : []), ...this.bladeLinks],
      name: this.spec.name,
      tags: ['vehicle', kind],
      kinematic: true,
      transform: { position: { ...this.position }, rotation: quatFromEulerYXZ(opts.yaw ?? 0, 0) },
    });
    this.body.transform.rotation = this.orientation;
    this.feet = this.wheels.length ? this.wheels.map(wheel => {
      const probes: Vec3[] = [v3()];
      const shape = wheel.shape;
      for (let x = 0; x < shape.sx; x++) {
        let y = 0;
        while (y < shape.sy && shape.get(x, y, 1) === Mat.Air) y++;
        if (y === shape.sy) continue;
        for (const edge of [0.01, 0.99]) probes.push(v3((x + edge) * this.voxelSize - wheel.radius, y * this.voxelSize, 0));
      }
      return { ...v3(wheel.center.x, 0, wheel.center.z), probes };
    }) : [-1, 1].flatMap(x => [-1, 1].map(z => v3(x * this.spec.size.x * this.voxelSize * 0.27,
      0, z * this.spec.size.z * this.voxelSize * 0.36)));
    this.initialVoxels = this.body.solidVoxels;
    this.deck = kind === 'truck' ? new TruckDeck(this.body, this.voxelSize) : null;
    vehicleBodies.set(this.body, this);
  }

  snapshot() { return structuredClone({ position: this.position, yaw: this.yaw, speed: this.speed,
    speedLimit: this.speedLimit, bladeHeight: this.bladeHeight, wrecked: this.wrecked,
    flooded: this.flooded, drowned: this.drowned, slide: this.slide, verticalSpeed: this.verticalSpeed,
    impactDelay: this.impactDelay, yawSpeed: this.yawSpeed, grounded: this.grounded,
    steeringAngle: this.steeringAngle, wheelRotation: this.wheelRotation, pitch: this.pitch, roll: this.roll,
    physicalPrevious: this.physicalPrevious, cargo: [...this.cargo] }); }
  restore(s: ReturnType<Vehicle['snapshot']>): void {
    const { cargo, ...state } = structuredClone(s); Object.assign(this, state);
    this.cargo.clear(); for (const id of cargo) this.cargo.add(id);
  }

  private poseBladeLinks(): void {
    if (!this.bladeLinks.length) return;
    const vs = this.voxelSize, hx = this.spec.size.x / 2, hz = this.spec.size.z / 2;
    for (let side = 0; side < 2; side++) {
      const z = (side ? this.spec.size.z - 7 : 7) - hz;
      const start = v3((42-hx)*vs,.65,z*vs);
      const end = v3((56-hx)*vs,.65+this.bladeHeight,z*vs);
      const delta = sub(end,start), angle = Math.atan2(delta.y,delta.x);
      const rotation = quatFromEulerYXZ(0,0,angle), direction = scale(delta,1/length(delta));
      for (let part=0;part<2;part++) {
        const link = this.bladeLinks[side*2+part];
        const base = part ? sub(end,scale(direction,link.sx*vs)) : start;
        const offset = rotateVec(rotation,v3(0,-link.sy*vs/2,-link.sz*vs/2));
        link.transform={position:add(base,offset),rotation};
      }
    }
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
    return this.body && !this.body.kinematic ? this.body.transform.rotation
      : vehicleOrientation(this.yaw, this.pitch, this.roll);
  }

  /** Точка, из которой машина «смотрит» вперёд — перед бампером. */
  get nose(): Vec3 {
    const half = (this.spec.size.x / 2) * this.voxelSize;
    return transformPoint({ position: this.position, rotation: this.orientation }, v3(half, 0, 0));
  }

  get cargoPosition(): Vec3 {
    return this.deck ? transformPoint(this.body.transform, v3(-1.5, this.deck.min.y + 0.02, 0))
      : add(this.position, v3(CARGO_OFFSET.x, CARGO_OFFSET.y, CARGO_OFFSET.z));
  }

  get driverEye(): Vec3 {
    return this.deck ? transformPoint(this.body.transform, v3(3.3, 2.2, 0)) : add(this.position, v3(0, 1.4, 0));
  }

  spawn(sim: Simulation): Body {
    sim.world.addBody(this.body);
    sim.physics.sync(this.body);
    this.senseWater(sim);
    return this.body;
  }

  get inWater(): boolean {
    return this.waterSurface !== null && this.position.y <= this.waterSurface + 0.05 &&
      (!this.grounded || this.position.y < this.waterSurface - 0.05);
  }

  /** Целость корпуса, 0..1. */
  get hullIntegrity(): number {
    return this.initialHullVoxels === 0 ? 0 : this.body.shapes[0].solidVoxels / this.initialHullVoxels;
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

  /** Восстановление положения сохраняет повреждения и требует свободного места на опоре. */
  recover(sim: Simulation): VehicleRecoveryResult {
    if (this.body.destroyed || this.wrecked || this.spec.aquatic || this.inWater) return 'broken';
    if (length(this.body.velocity) > 1.5 || length(this.body.angularVelocity) > 1) return 'moving';
    if (rotateVec(this.body.transform.rotation, v3(0, 1, 0)).y > 0.9) return 'upright';
    const box = bodySolidBounds(this.body);
    const ignore = new Set([...sim.world.bodies.values()].filter(b => b.tags.has('vehicle') ||
      b.tags.has('truck-load')).map(b => b.id));
    const hit = sim.world.raycast(v3(this.position.x, box.min.y + 0.3, this.position.z), v3(0, -1, 0), {
      maxDistance: this.spec.size.y * this.voxelSize + 3, ignore,
      filter: mat => mat !== Mat.Water && mat !== Mat.Paint,
    });
    if (!hit || hit.normal.y < 0.5) return 'blocked';
    const position = v3(this.position.x, hit.point.y + 0.02, this.position.z);
    const rotation = vehicleOrientation(this.yaw, 0, 0);
    if (this.worldBlocked(sim, { position, rotation }) || this.contactAt(sim, position)) return 'blocked';
    this.deck?.release(sim);
    this.body.kinematic = true;
    this.position = position; this.pitch = 0; this.roll = 0;
    this.speed = 0; this.verticalSpeed = 0; this.slide = v3(); this.yawSpeed = 0;
    this.grounded = true; this.body.velocityDirty = true;
    this.syncBody(); sim.physics.sync(this.body);
    return 'recovered';
  }

  update(sim: Simulation, input: VehicleInput, dt: number): void {
    if (this.body.destroyed) { this.deck?.release(sim); return; }
    if (dt <= 0) return;
    dt = Math.min(dt, 0.1);
    this.impactDelay = Math.max(0, this.impactDelay - dt);
    if (!this.body.kinematic && this.updatePhysical(sim, dt)) return;
    // Корпус развалился больше чем наполовину — техника мертва.
    if (this.hullIntegrity < 0.45) {
      this.wrecked = true;
    }
    this.senseWater(sim);
    this.updateVertical(sim, dt);
    this.updateWater(dt);
    if (!this.body.kinematic) return;
    if (!this.wrecked && this.grounded && this.spec.blade) {
      this.bladeHeight = clamp(this.bladeHeight + (input.bladeLift ?? 0) * dt * 0.8, 0, 1.6);
      if (this.bladeShape && this.bladeShape.transform.position.y !== this.bladeHeight) {
        this.bladeShape.transform.position.y = this.bladeHeight;
        this.poseBladeLinks();
        this.body.collidersDirty = true;
        this.body.collidersImmediate = true;
      }
      if (input.blade || input.throttle > 0 || Math.abs(this.speed) > 0.1 || input.bladeLift) this.dig(sim, dt);
    }

    if (!this.canDrive() || (!this.grounded && !this.spec.aquatic)) {
      this.speed = approach(this.speed, 0, (this.grounded || this.inWater ? this.spec.brake : 0.2) * dt);
    } else if (this.impactDelay === 0) {
      const throttle = clamp(input.throttle, -1, 1);
      const target =
        (throttle >= 0 ? throttle * this.spec.maxSpeed : throttle * this.spec.reverseSpeed) * clamp(this.speedLimit, 0.2, 1);
      const rate = input.brake
        ? this.spec.brake
        : Math.abs(target) > Math.abs(this.speed)
          ? this.spec.accel
          : this.spec.brake * 0.5;
      this.speed = approach(this.speed, input.brake ? 0 : target, rate * dt);
    }

    // Руль работает только когда машина катится.
    const steerFactor = clamp(Math.abs(this.speed) / Math.max(1, this.spec.maxSpeed * 0.35), 0, 1);
    this.steeringAngle = approach(this.steeringAngle, clamp(input.steer, -1, 1) * 0.5, dt * 2.5);
    const oldYaw = this.yaw;
    const turning = this.tracks.length ? Math.max(0.4, steerFactor) : steerFactor;
    this.yaw -= clamp(input.steer, -1, 1) * this.spec.turnRate * turning * dt * Math.sign(this.speed || 1) *
      Number((this.grounded || this.spec.aquatic) && this.canDrive() && !input.brake);
    this.yaw += this.yawSpeed * dt;
    this.yawSpeed *= Math.exp(-4 * dt);
    const turnTo = this.yaw;
    const turnSteps = Math.max(1, Math.ceil(Math.abs(turnTo - oldYaw) * this.spec.size.x * this.voxelSize / 0.1));
    this.yaw = oldYaw;
    for (let i = 1; i <= turnSteps && turnTo !== oldYaw; i++) {
      const previous = this.yaw;
      this.yaw = oldYaw + (turnTo - oldYaw) * i / turnSteps;
      if (this.contactAt(sim, this.position) || this.worldBlocked(sim,
        { position: this.position, rotation: this.orientation })) { this.yaw = previous; this.yawSpeed = 0; break; }
    }
    const velocity = add(scale(this.forward, this.speed), this.slide);
    const delta = scale(velocity, dt);
    const steps = Math.max(1, Math.ceil(length(delta) / 0.15));
    const start = { ...this.position };
    for (let i = 0; i < steps; i++) {
      const next = add(this.position, scale(delta, 1 / steps));
      const collision = this.contactAt(sim, next);
      if (collision) { this.crash(sim, collision.other, collision.normal); break; }
      if (this.probeBlocked(sim, next)) {
        if (!this.wrecked && this.punchThrough(sim, dt / steps)) this.position = next;
        else {
          const impact = Math.abs(this.speed);
          if (impact >= 3 && this.impactDelay === 0) {
            const outward = scale(this.forward, this.speed < 0 ? -1 : 1);
            dentVehicle(sim, this.body, add(add(this.position, scale(outward, this.spec.size.x * this.voxelSize / 2)),
              v3(0, this.spec.size.y * this.voxelSize * 0.35, 0)), scale(outward, -1), impact);
            this.speed *= this.tracks.length ? 0 : -0.25;
            this.impactDelay = this.tracks.length ? 0.06 : 0.4;
          } else this.speed *= 0.15;
          this.slide = v3(); break;
        }
      } else this.position = next;
      if (this.grounded && !this.spec.aquatic) this.updateVertical(sim, 0);
      if (!this.body.kinematic) break;
    }
    this.slide = scale(this.slide, Math.exp(-(this.inWater ? 3 : this.grounded ? 2.5 : 0.2) * dt));
    const travelled = dot(sub(this.position, start), this.forward);
    for (const track of this.tracks) {
      track.travel += travelled + (this.yaw - oldYaw) * track.center.z;
      const shape = this.body.shapes[0];
      const x = Math.round(track.center.x / this.voxelSize + this.spec.size.x / 2);
      const z = Math.round(track.center.z / this.voxelSize + this.spec.size.z / 2);
      track.visible = shape.get(x, 2, z) !== Mat.Air;
    }
    if (this.wheels.length) this.wheelRotation = (this.wheelRotation + travelled / this.wheels[0].radius) % (Math.PI * 2);
    for (const wheel of this.wheels) wheel.pose = wheelPose(wheel, this.steeringAngle, this.wheelRotation);
    this.senseWater(sim);
    this.syncBody();
    sim.physics.sync(this.body);
    this.deck?.update(sim, this.wrecked);
  }

  private footprint(position = this.position): VehicleFootprint {
    return { position, yaw: this.yaw, length: this.spec.size.x * this.voxelSize,
      width: this.spec.size.z * this.voxelSize, height: this.spec.size.y * this.voxelSize };
  }

  private contactAt(sim: Simulation, position: Vec3): { other: Vehicle; normal: Vec3 } | null {
    for (const body of sim.world.bodies.values()) {
      if (body === this.body || body.destroyed || !body.tags.has('vehicle')) continue;
      const other = vehicleBodies.get(body);
      if (!other) continue;
      const contact = vehicleContact(this.footprint(position), other.footprint());
      if (contact) return { other, normal: contact.normal };
    }
    return null;
  }

  private horizontalVelocity(): Vec3 { return add(scale(this.forward, this.speed), this.slide); }

  private setHorizontalVelocity(velocity: Vec3): void {
    this.speed = dot(velocity, this.forward);
    this.slide = sub(velocity, scale(this.forward, this.speed));
  }

  private crash(sim: Simulation, other: Vehicle, normal: Vec3): void {
    const a = this.horizontalVelocity(), b = other.horizontalVelocity();
    const closing = dot(sub(a, b), normal);
    if (closing <= 0) return;
    const m1 = Math.max(1, this.body.mass() + (this.deck?.mass ?? 0));
    const m2 = Math.max(1, other.body.mass() + (other.deck?.mass ?? 0));
    const impulse = (this.tracks.length || other.tracks.length ? 1.04 : 1.32) * closing / (1 / m1 + 1 / m2);
    this.setHorizontalVelocity(sub(a, scale(normal, impulse / m1)));
    other.setHorizontalVelocity(add(b, scale(normal, impulse / m2)));
    const point = vehicleContactPoint(this.footprint(), other.footprint(), normal);
    const otherPoint = vehicleContactPoint(other.footprint(), this.footprint(), scale(normal, -1));
    if (this.impactDelay === 0 && other.impactDelay === 0) {
      dentVehicle(sim, this.body, point, scale(normal, -1), closing * m2 / (m1 + m2));
      dentVehicle(sim, other.body, otherPoint, normal, closing * m1 / (m1 + m2));
      const side = v3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const offset = clamp(dot(sub(other.position, this.position), side), -1, 1);
      this.yawSpeed += offset * closing * 0.04;
      other.yawSpeed -= offset * closing * 0.04;
      sim.world.events.emit('impact', { body: this.body, other: other.body, point, impulse, normal: scale(normal, -1) });
    }
    this.impactDelay = other.impactDelay = 0.4;
    this.syncBody();
    other.syncBody();
    if (!other.body.kinematic) {
      other.body.velocity = add(other.horizontalVelocity(), v3(0, other.verticalSpeed, 0));
      other.body.velocityDirty = true;
    }
    sim.physics.sync(other.body);
  }

  private support(sim: Simulation, dt: number) {
    const support = vehicleSupport(sim, { position: this.position, rotation: this.orientation }, this.yaw,
      this.feet, -this.verticalSpeed * dt);
    // Дублёр для тестов не вращает жёсткие тела: держим центр до края,
    // чтобы он не опускался в асфальт, пока задний мост ещё на площадке.
    if (!sim.physics.rigidBodyDynamics && !support.stable && support.contacts.length >= 2) {
      const ignore = new Set([...sim.world.bodies.values()].filter(b => b.tags.has('vehicle')).map(b => b.id));
      const hit = sim.world.raycast(add(this.position, v3(0, 0.25, 0)), v3(0, -1, 0), {
        maxDistance: 0.5, ignore, filter: (mat, _shape, body) => !body.passive && mat !== Mat.Water && mat !== Mat.Paint,
      });
      if (hit && hit.normal.y > 0.5) return { ...support, height: hit.point.y, pitch: 0, roll: 0, stable: true };
    }
    return support;
  }

  /** Считывать результат солвера, не сбрасывая физический наклон корпуса. */
  afterPhysics(): void {
    if (this.body.kinematic) return;
    this.position = { ...this.body.transform.position };
    const heading = rotateVec(this.body.transform.rotation, v3(1, 0, 0));
    if (Math.hypot(heading.x, heading.z) > 0.01) this.yaw = Math.atan2(-heading.x, -heading.z);
    this.pitch = Math.atan2(heading.y, Math.hypot(heading.x, heading.z));
    const up = rotateVecInverse(quatFromEulerYXZ(this.yaw + Math.PI / 2, 0),
      rotateVec(this.body.transform.rotation, v3(0, 1, 0)));
    this.roll = Math.atan2(up.z, up.y);
    this.setHorizontalVelocity(v3(this.body.velocity.x, 0, this.body.velocity.z));
    this.verticalSpeed = this.body.velocity.y;
  }

  private updatePhysical(sim: Simulation, dt: number): boolean {
    this.afterPhysics(); this.senseWater(sim); this.updateWater(dt);
    const support = this.support(sim, dt);
    if (support.stable && Math.abs(this.pitch - support.pitch) < 0.15 && Math.abs(this.roll - support.roll) < 0.15 &&
        Math.abs(this.verticalSpeed) < 1.5 && length(this.body.angularVelocity) < 0.8) {
      this.body.kinematic = true; this.position.y = support.height + 0.02;
      this.pitch = support.pitch; this.roll = support.roll;
      this.grounded = true; this.verticalSpeed = 0;
      this.syncBody(); sim.physics.sync(this.body);
      return false;
    }
    if (this.hullIntegrity < 0.45) this.wrecked = true;
    this.grounded = false;
    const travelled = dot(sub(this.position, this.physicalPrevious), this.forward);
    if (this.wheels.length) this.wheelRotation = (this.wheelRotation + travelled / this.wheels[0].radius) % (2 * Math.PI);
    for (const wheel of this.wheels) wheel.pose = wheelPose(wheel, this.steeringAngle, this.wheelRotation);
    this.physicalPrevious = { ...this.position };
    this.deck?.update(sim, this.wrecked);
    return true;
  }

  private senseWater(sim: Simulation): void {
    const finiteWater = [...sim.world.bodies.values()].some(body => !body.destroyed && body.tags.has('water'));
    if (!finiteWater) { this.waterSurface = this.waterLevel; return; }
    const origin = v3(this.position.x, Math.max(this.position.y + 0.2, this.waterLevel + 0.2), this.position.z);
    const hit = sim.world.raycast(origin, v3(0, -1, 0), { maxDistance: origin.y - this.waterLevel + 0.2,
      filter: mat => mat === Mat.Water });
    this.waterSurface = hit ? hit.point.y : null;
  }

  private updateVertical(sim: Simulation, dt: number): void {
    if (!this.spec.aquatic) {
      const support = this.support(sim, dt);
      this.verticalSpeed = Math.max(-45, this.verticalSpeed + sim.world.gravity.y * dt);
      const next = this.position.y + this.verticalSpeed * dt;
      const resting = support.height + 0.02;
      if (support.stable && (next <= resting || this.position.y - resting <= 0.12)) {
        this.position.y = resting;
        this.pitch = support.pitch; this.roll = support.roll;
        this.verticalSpeed = 0; this.grounded = true;
      } else {
        this.grounded = false;
        if (sim.physics.rigidBodyDynamics) {
          this.syncBody(); this.physicalPrevious = { ...this.position };
          this.body.kinematic = false; this.body.velocityDirty = true;
          // Передний мост потерял опору: небольшой момент запускает
          // опрокидывание, затем вращение и контакты считает Rapier.
          if (support.contacts.length && support.contacts.length < 3) {
            const meanX = support.contacts.reduce((n, p) => n + p.x, 0) / support.contacts.length;
            const meanZ = support.contacts.reduce((n, p) => n + p.z, 0) / support.contacts.length;
            this.body.angularVelocity = rotateVec(quatFromEulerYXZ(this.yaw + Math.PI / 2, 0),
              v3(-meanZ * 0.6, 0, meanX * 0.6));
          }
          sim.physics.sync(this.body);
        } else this.position.y = next;
      }
      return;
    }
    const ignore = new Set<number>();
    for (const body of sim.world.bodies.values()) if (body.tags.has('vehicle')) ignore.add(body.id);
    const halfX = this.spec.size.x * this.voxelSize * 0.32;
    const halfZ = this.spec.size.z * this.voxelSize * 0.32;
    const samples = [v3(), v3(-halfX, 0, -halfZ), v3(-halfX, 0, halfZ), v3(halfX, 0, -halfZ), v3(halfX, 0, halfZ)];
    const heights: number[] = [];
    let centerGround: number | null = null;
    for (const [i, local] of samples.entries()) {
      const p = transformPoint({ position: this.position, rotation: this.orientation }, local);
      p.y += 0.3;
      const hit = sim.world.raycast(p, v3(0, -1, 0), {
        maxDistance: 0.6 + Math.max(0, -this.verticalSpeed * dt), ignore,
        filter: (mat, _shape, body) => !body.passive && mat !== Mat.Water && mat !== Mat.Paint,
      });
      // Луч, начавшийся внутри стены или колонны, не является верхней гранью опоры.
      if (!hit || hit.normal.y < 0.5) continue;
      heights.push(hit.point.y);
      if (i === 0) centerGround = hit.point.y;
    }
    heights.sort((a, b) => a - b);
    // Отдельный высокий угол не поднимает весь кузов как лифт.
    const ground = heights.length >= 3 ? heights[Math.floor(heights.length / 2)] : centerGround ?? -Infinity;
    const afloat = this.spec.aquatic && this.waterSurface !== null && this.position.y <= this.waterSurface + 0.1 &&
      ground < this.waterSurface - 0.05 && this.flooded < 1;
    if (afloat) {
      this.position.y = this.waterSurface! - this.flooded * SINK_DEPTH;
      this.verticalSpeed = 0;
      this.grounded = false;
      return;
    }
    this.verticalSpeed = Math.max(-45, this.verticalSpeed + sim.world.gravity.y * dt);
    const next = this.position.y + this.verticalSpeed * dt;
    const resting = ground + 0.02;
    // Подвеска выбирает небольшой стартовый зазор над покрытием; на краю без луча опоры машина падает.
    if (next <= resting || (this.verticalSpeed <= 0 && this.position.y - resting <= 0.12)) {
      this.position.y = resting;
      this.verticalSpeed = 0;
      this.grounded = true;
    } else {
      this.position.y = next;
      this.grounded = false;
    }
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

    if (!this.spec.amphibious && this.waterSurface !== null && this.position.y < this.waterSurface - DROWN_DEPTH) {
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
    if (!this.body.kinematic) return;
    this.body.transform.position = { ...this.position };
    this.body.transform.rotation = this.orientation;
    this.body.velocity = add(this.horizontalVelocity(), v3(0, this.verticalSpeed, 0));
    this.body.angularVelocity = v3(0, this.yawSpeed, 0);
    this.body.wake();
  }

  private probeBlocked(sim: Simulation, next: Vec3): boolean {
    // Положение на рампе проверяем после подъёма на опору, иначе колёса
    // сочли бы наклонную доску стеной. Носовой щуп остаётся для тарана.
    const support = vehicleSupport(sim, { position: next, rotation: this.orientation }, this.yaw,
      this.feet, 0);
    const position = { ...next };
    let rotation = this.orientation;
    if (!this.spec.aquatic && support.stable && next.y - support.height <= 0.14) {
      position.y = support.height + 0.02;
      rotation = vehicleOrientation(this.yaw, support.pitch, support.roll);
    }
    if (this.worldBlocked(sim, { position, rotation }, { position: this.position, rotation: this.orientation })) return true;
    // Щуп сидит прямо на бампере и намеренно маленький.
    // Коробка размером с машину «чувствовала» бы стену за три метра,
    // а таран при этом резал бы воксели в метре перед собой — машина
    // вставала бы, ничего не пробив.
    const half = (this.spec.size.x / 2) * this.voxelSize;
    // Проверяем препятствие со стороны фактического движения.
    // При заднем ходе щуп должен быть у заднего бампера, иначе стена
    // перед носом не даёт машине отъехать от неё.
    const r = PROBE_HALF;
    const ignore = new Set([this.body.id]);
    for (const body of sim.world.bodies.values()) {
      if (body.tags.has('vehicle')) ignore.add(body.id);
    }
    // Широкий отвал замечает также край контейнера или колонну сбоку от центра.
    const width = this.spec.size.z * this.voxelSize;
    const samples = Math.max(1, Math.ceil(width / (2 * r)));
    for (let i = 0; i < samples; i++) {
      const offset = samples === 1 ? 0 : -width / 2 + r + i * (width - 2 * r) / (samples - 1);
      const p = transformPoint({ position: next, rotation: this.orientation },
        v3((this.speed < 0 ? -1 : 1) * (half + PROBE_MARGIN), 0, offset));
      const surface = sim.world.raycast(add(p, v3(0, 0.5, 0)), v3(0, -1, 0), {
        maxDistance: 0.8, ignore, filter: (mat, _shape, body) => !body.passive && mat !== Mat.Water && mat !== Mat.Paint,
      });
      // Низкая наклонная доска под бампером — дорога к колёсам,
      // а не вертикальная стена, которую следует пробивать.
      const bottom = Math.max(p.y + 0.3, surface && surface.normal.y > 0.5 ? surface.point.y + 0.08 : -Infinity);
      if (scanIgnoring(sim, {
        min: v3(p.x - r, bottom, p.z - r),
        max: v3(p.x + r, p.y + this.spec.size.y * this.voxelSize, p.z + r),
      }, ignore)) return true;
    }
    return false;
  }

  /**
   * Таран: на скорости корпус прорезает воксели впереди. Чем быстрее,
   * тем больше дыра — именно так «пробить стену на скорости» и работает.
   */
  private punchThrough(sim: Simulation, dt: number): boolean {
    const speed = Math.abs(this.speed);
    // Кузов не заменяет ковш. Легковой удар берёт лишь слабые ограды;
    // кирпич, бетон, сталь и сама дорога не прорезаются на скорости.
    if (this.spec.blade || speed < this.spec.ramSpeed) return false;
    const direction = scale(this.forward, this.speed < 0 ? -1 : 1);
    const halfH = this.spec.size.y * this.voxelSize / 2;
    const halfW = this.spec.size.z * this.voxelSize / 2;
    const bumper = transformPoint({ position: this.position, rotation: this.orientation },
      v3((this.speed < 0 ? -1 : 1) * this.spec.size.x * this.voxelSize / 2, halfH, 0));
    const side = v3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const radius = Math.hypot(halfH, PROBE_HALF) + this.voxelSize * 0.5;
    const span = Math.max(0, halfW - radius);
    const res = carve(sim.world, {
      kind: 'capsule', a: add(bumper, scale(side, -span)), b: add(bumper, scale(side, span)), radius,
    }, {
      power: 0.25, damage: 0, instant: true, falloff: 'none', cause: 'ram',
      maxVoxels: 1200, ignoreBodies: this.toolIgnore(sim), filterVoxel: this.toolFilter(this.speed < 0 ? -1 : 1),
      physicalDebris: { velocity: add(scale(direction, speed * 0.15), v3(0, 0.7, 0)), maxFragments: 8 },
    });
    if (res.removed === 0) return false;
    const next = add(this.position, scale(this.forward, this.speed * dt));
    this.speed *= 0.35;
    return !this.probeBlocked(sim, next);
  }

  private toolIgnore(sim: Simulation): Set<number> {
    return new Set([...sim.world.bodies.values()].filter(b =>
      b.tags.has('vehicle') || b.tags.has('carved-debris') || b.tags.has('truck-load')).map(b => b.id));
  }

  private worldBlocked(sim: Simulation, pose: Transform, from?: Transform): boolean {
    const filter = (other: Body) =>
      !other.tags.has('vehicle') && !other.tags.has('truck-load') &&
      !(other.kind === 'dynamic' && other.tags.has('carved-debris'));
    return from ? bodyMovementBlocked(sim.world, this.body, from, pose, undefined, filter)
      : bodyOverlapsWorld(sim.world, this.body, pose, undefined, filter);
  }

  private toolFilter(direction = 1) {
    const pose = { position: { ...this.position }, rotation: this.orientation };
    const bumper = this.spec.size.x * this.voxelSize / 2;
    return (shape: VoxelShape, body: Body, x: number, y: number, z: number): boolean => {
      const local = inverseTransformPoint(pose, shape.voxelCenterWorld(x, y, z, body.transform));
      // Ни под шасси, ни ниже плоскости опоры инструмент не действует.
      if (local.y <= 0.15 || local.x * direction <= bumper + 0.01) return false;
      // A low horizontal step (quay boards/ramp) is a driving surface, not a wall.
      if (body.kind === 'static' && local.y < 0.5) {
        const above = Math.ceil((0.55 - local.y) / shape.voxelSize);
        if (shape.get(x, y + above, z) === Mat.Air) return false;
      }
      return true;
    };
  }

  /** The working edge follows the visible blade; the road remains protected. */
  private dig(sim: Simulation, dt: number): void {
    const blade = this.spec.blade;
    if (!blade || !this.bladeShape?.solidVoxels || dt <= 0) return;
    const pose = { position: this.position, rotation: this.orientation };
    const center = transformPoint(pose, v3(this.spec.size.x * this.voxelSize / 2 + blade.reach / 2,
      0.15 + this.bladeHeight + blade.halfHeight, 0));
    carve(sim.world, { kind: 'box', center,
      halfExtents: v3(blade.reach / 2, blade.halfHeight, blade.halfWidth), rotation: this.orientation }, {
      power: blade.power, damage: 0, instant: true, falloff: 'none', cause: 'bucket',
      maxVoxels: Math.max(1, Math.floor((this.spec.kind === 'bulldozer' ? 24_000 : 18_000) * dt)),
      ignoreBodies: this.toolIgnore(sim), filterVoxel: this.toolFilter(),
      physicalDebris: { velocity: add(scale(this.forward, Math.max(0, this.speed) * 0.1), v3(0, 0.6, 0)), maxFragments: 4 },
    });
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
