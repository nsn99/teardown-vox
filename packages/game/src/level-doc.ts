import {
  Body,
  Mat,
  Simulation,
  Transform,
  Vec3,
  VoxelShape,
  decodeRle,
  encodeRle,
  materialByName,
  quatFromEulerYXZ,
  v3,
} from '@tvox/core';
import {
  Daylight,
  EnvironmentDef,
  EscapeRoute,
  LevelSource,
  LightDef,
  RouteNeeds,
  SpawnPoint,
  TriggerDef,
  TriggerKind,
  VehicleSpawnDef,
} from './level.js';
import { ChaserKind, ChaserSpec } from './pursuit.js';
import { MissionConfig, TargetSpec } from './mission.js';
import { VehicleKind, VEHICLES } from './vehicles.js';

/**
 * Формат карты.
 *
 * Файл, а не код. Карта — данные: размеры в вокселях, координаты в метрах,
 * материалы по именам. Правится в текстовом редакторе, грузится на лету,
 * проверяется до сборки — сломанный файл обязан назвать поле, а не упасть
 * где-то в третьем чанке.
 *
 * Геометрия описана операциями, а не сплошным массивом вокселей: массив на
 * пять миллионов клеток никто руками не правит, а «залей коробку кирпичом»
 * и «протяни кабель по этим точкам» — правит. Для кусков, нарисованных
 * снаружи (импорт из .vox), есть операция с сырыми вокселями.
 */

export const LEVEL_FORMAT = 'tvox-level';
export const LEVEL_VERSION = 1;

/** Целочисленная коробка в вокселях: [x0, y0, z0, x1, y1, z1], верх исключён. */
export type BoxDoc = [number, number, number, number, number, number];
export type Vec3Doc = [number, number, number];

export type OpDoc =
  /** Залить коробку материалом. Пустой список коробки — вся форма. */
  | { op: 'fill'; box?: BoxDoc; mat: string }
  /** Коробка здания: стены, пол, крыша, внутри пусто. */
  | {
      op: 'hollow';
      box?: BoxDoc;
      wall: string;
      roof?: string;
      floor?: string;
      thickness?: number;
      roofThickness?: number;
    }
  /** Балочная клетка под перекрытием. */
  | {
      op: 'beams';
      y: number;
      height: number;
      spacingX: number;
      spacingZ: number;
      mat: string;
      width?: number;
      box?: BoxDoc;
    }
  /**
   * Повторить коробку с шагом по осям: сваи причала, колонны, окна.
   * Шаг больше области — ровно один ряд, это законный и частый случай.
   */
  | { op: 'grid'; box: BoxDoc; cell: Vec3Doc; step: Vec3Doc; mat: string }
  /** Ломаная линия толщиной в воксель — кабель сигнализации. */
  | { op: 'line'; points: Vec3Doc[]; mat: string }
  /** Сырые воксели: сюда попадает импорт из чужих форматов. */
  | { op: 'voxels'; at: Vec3Doc; size: Vec3Doc; rle: number[] };

export interface VolumeDoc {
  name: string;
  /** Размер в вокселях. */
  size: Vec3Doc;
  /** Положение в метрах, мировые координаты. */
  position: Vec3Doc;
  /** Форма стоит на земле (влияет на структурный анализ). */
  grounded?: boolean;
  /** Считать по форме напряжения. Грунту это не нужно. */
  structural?: boolean;
  ops: OpDoc[];
}

export interface PropDoc {
  /** Отдельное тело: вода, декорации. */
  name: string;
  kind?: 'static' | 'dynamic';
  tags?: string[];
  /** Тело не участвует в разрушении и структурном анализе. */
  passive?: boolean;
  volume: VolumeDoc;
}

/**
 * В файле все точки — тройки чисел, а не `{x, y, z}`: так короче, так
 * привычнее в текстовом редакторе и так документ выглядит одинаково
 * независимо от того, написан он руками или сохранён из игры.
 * Отсюда отдельные «файловые» типы: в них координаты — массивы.
 */
export type TriggerDoc = Omit<TriggerDef, 'center' | 'halfExtents'> & {
  center: Vec3Doc;
  halfExtents: Vec3Doc;
};
export type VehicleDoc = Omit<VehicleSpawnDef, 'position'> & { position: Vec3Doc };
export type TargetDoc = Omit<TargetSpec, 'position'> & { position: Vec3Doc };
export type ChaserDoc = Omit<ChaserSpec, 'from'> & { from: Vec3Doc };
export type LightDocEntry = Omit<LightDef, 'position' | 'target'> & {
  position: Vec3Doc;
  target?: Vec3Doc;
};
export interface EnvironmentDoc {
  daylight?: Daylight;
  lights?: LightDocEntry[];
}
export type MissionDoc = Omit<MissionConfig, 'targets' | 'extraction'> & {
  targets: TargetDoc[];
  extraction: { center: Vec3Doc; halfExtents: Vec3Doc };
};

export type RouteDoc = Omit<EscapeRoute, 'waypoints'> & { waypoints: Vec3Doc[] };

export interface LevelDoc {
  format: typeof LEVEL_FORMAT;
  version: number;
  id: string;
  name: string;
  brief: string;
  voxelSize: number;
  waterLevel: number;
  spawn: { position: Vec3Doc; yaw: number };
  volumes: VolumeDoc[];
  props?: PropDoc[];
  triggers: TriggerDoc[];
  vehicles: VehicleDoc[];
  mission: MissionDoc;
  /** Кто приходит по концу таймера. Пусто — берутся умолчания. */
  pursuit?: ChaserDoc[];
  /** Время суток и свет уровня. */
  environment?: EnvironmentDoc;
  /** Заявленные пути отхода. */
  routes?: RouteDoc[];
}

const point = (p: Vec3Doc): Vec3 => v3(p[0], p[1], p[2]);
const flat = (p: Vec3): Vec3Doc => [p.x, p.y, p.z];

/** Триггеры документа в игровые. */
export const triggersOf = (doc: LevelDoc): TriggerDef[] =>
  doc.triggers.map((t) => ({ ...t, center: point(t.center), halfExtents: point(t.halfExtents) }));

/** Техника документа в игровую. */
export const vehiclesOf = (doc: LevelDoc): VehicleSpawnDef[] =>
  doc.vehicles.map((v) => ({ ...v, position: point(v.position) }));

/** Миссия документа в игровую. */
export const missionOf = (doc: LevelDoc): MissionConfig => ({
  ...doc.mission,
  targets: doc.mission.targets.map((t) => ({ ...t, position: point(t.position) })),
  extraction: {
    center: point(doc.mission.extraction.center),
    halfExtents: point(doc.mission.extraction.halfExtents),
  },
});

/** Преследователи документа в игровых. */
export const pursuitOf = (doc: LevelDoc): ChaserSpec[] | undefined =>
  doc.pursuit?.map((c) => ({ ...c, from: point(c.from) }));

/** Маршруты документа в игровые. */
export const routesOf = (doc: LevelDoc): EscapeRoute[] | undefined =>
  doc.routes?.map((r) => ({ ...r, waypoints: r.waypoints.map(point) }));

/** Освещение документа в игровое. */
export const environmentOf = (doc: LevelDoc): EnvironmentDef | undefined =>
  doc.environment
    ? {
        daylight: doc.environment.daylight ?? 'dusk',
        lights: (doc.environment.lights ?? []).map((l): LightDef => {
          const { position, target, ...rest } = l;
          return {
            ...rest,
            position: point(position),
            ...(target ? { target: point(target) } : {}),
          };
        }),
      }
    : undefined;

// ---------------------------------------------------------------------------
// Разбор и проверка
// ---------------------------------------------------------------------------

/** Ошибка формата с путём до поля: «volumes[2].ops[7].mat: нет материала». */
export class LevelFormatError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'LevelFormatError';
  }
}

function fail(path: string, msg: string): never {
  throw new LevelFormatError(path, msg);
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, `ожидалось число, пришло ${show(v)}`);
  return v as number;
}

function int(v: unknown, path: string, min = -Infinity): number {
  const n = num(v, path);
  if (!Number.isInteger(n)) fail(path, `ожидалось целое, пришло ${n}`);
  if (n < min) fail(path, `ожидалось не меньше ${min}, пришло ${n}`);
  return n;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0) fail(path, `ожидалась непустая строка, пришло ${show(v)}`);
  return v as string;
}

function vec3(v: unknown, path: string): Vec3Doc {
  if (!Array.isArray(v) || v.length !== 3) fail(path, `ожидались три числа, пришло ${show(v)}`);
  const a = v as unknown[];
  return [num(a[0], `${path}[0]`), num(a[1], `${path}[1]`), num(a[2], `${path}[2]`)];
}

function box(v: unknown, path: string): BoxDoc {
  if (!Array.isArray(v) || v.length !== 6) fail(path, `ожидались шесть чисел, пришло ${show(v)}`);
  const a = v as unknown[];
  const b = [0, 1, 2, 3, 4, 5].map((i) => int(a[i], `${path}[${i}]`)) as BoxDoc;
  for (let i = 0; i < 3; i++) {
    if (b[i + 3] < b[i]) fail(path, `коробка вывернута по оси ${'xyz'[i]}: ${b[i]} > ${b[i + 3]}`);
  }
  return b;
}

function mat(v: unknown, path: string): Mat {
  const name = str(v, path);
  const found = materialByName(name);
  if (!found) fail(path, `нет материала «${name}»`);
  return found.id;
}

/** Имя материала с проверкой на месте: в документе остаётся строка. */
function matName(v: unknown, path: string): string {
  mat(v, path);
  return str(v, path);
}

function show(v: unknown): string {
  if (typeof v === 'string') return `«${v}»`;
  if (v === undefined) return 'ничего';
  return JSON.stringify(v) ?? String(v);
}

function parseOp(v: unknown, path: string): OpDoc {
  if (!isObj(v)) fail(path, `ожидался объект операции, пришло ${show(v)}`);
  const o = v as Record<string, unknown>;
  const kind = str(o.op, `${path}.op`);
  switch (kind) {
    case 'fill':
      return {
        op: 'fill',
        mat: matName(o.mat, `${path}.mat`),
        ...(o.box === undefined ? {} : { box: box(o.box, `${path}.box`) }),
      };
    case 'hollow':
      return {
        op: 'hollow',
        wall: matName(o.wall, `${path}.wall`),
        ...(o.roof === undefined ? {} : { roof: matName(o.roof, `${path}.roof`) }),
        ...(o.floor === undefined ? {} : { floor: matName(o.floor, `${path}.floor`) }),
        ...(o.thickness === undefined ? {} : { thickness: int(o.thickness, `${path}.thickness`, 1) }),
        ...(o.roofThickness === undefined
          ? {}
          : { roofThickness: int(o.roofThickness, `${path}.roofThickness`, 1) }),
        ...(o.box === undefined ? {} : { box: box(o.box, `${path}.box`) }),
      };
    case 'beams':
      return {
        op: 'beams',
        y: int(o.y, `${path}.y`, 0),
        height: int(o.height, `${path}.height`, 1),
        spacingX: int(o.spacingX, `${path}.spacingX`, 1),
        spacingZ: int(o.spacingZ, `${path}.spacingZ`, 1),
        mat: matName(o.mat, `${path}.mat`),
        ...(o.width === undefined ? {} : { width: int(o.width, `${path}.width`, 1) }),
        ...(o.box === undefined ? {} : { box: box(o.box, `${path}.box`) }),
      };
    case 'grid': {
      const cell = vec3(o.cell, `${path}.cell`).map((n, i) =>
        int(n, `${path}.cell[${i}]`, 1),
      ) as Vec3Doc;
      const step = vec3(o.step, `${path}.step`).map((n, i) =>
        int(n, `${path}.step[${i}]`, 1),
      ) as Vec3Doc;
      return {
        op: 'grid',
        box: box(o.box, `${path}.box`),
        cell,
        step,
        mat: matName(o.mat, `${path}.mat`),
      };
    }
    case 'line': {
      if (!Array.isArray(o.points) || o.points.length < 2) {
        fail(`${path}.points`, 'ломаной нужны хотя бы две точки');
      }
      const pts = (o.points as unknown[]).map((p, i) => vec3(p, `${path}.points[${i}]`));
      return { op: 'line', points: pts, mat: matName(o.mat, `${path}.mat`) };
    }
    case 'voxels': {
      const size = vec3(o.size, `${path}.size`).map((n, i) =>
        int(n, `${path}.size[${i}]`, 1),
      ) as Vec3Doc;
      if (!Array.isArray(o.rle) || o.rle.length % 2 !== 0) {
        fail(`${path}.rle`, 'ожидались пары [материал, длина]');
      }
      const rle = (o.rle as unknown[]).map((n, i) => int(n, `${path}.rle[${i}]`, 0));
      const total = rle.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0);
      const need = size[0] * size[1] * size[2];
      if (total !== need) fail(`${path}.rle`, `покрывает ${total} вокселей из ${need}`);
      return { op: 'voxels', at: vec3(o.at, `${path}.at`) as Vec3Doc, size, rle };
    }
    default:
      return fail(`${path}.op`, `неизвестная операция «${kind}»`);
  }
}

function parseVolume(v: unknown, path: string): VolumeDoc {
  if (!isObj(v)) fail(path, `ожидался объект объёма, пришло ${show(v)}`);
  const o = v as Record<string, unknown>;
  const size = vec3(o.size, `${path}.size`).map((n, i) =>
    int(n, `${path}.size[${i}]`, 1),
  ) as Vec3Doc;
  if (!Array.isArray(o.ops)) fail(`${path}.ops`, 'ожидался список операций');
  return {
    name: str(o.name, `${path}.name`),
    size,
    position: vec3(o.position, `${path}.position`),
    grounded: o.grounded === undefined ? true : Boolean(o.grounded),
    structural: o.structural === undefined ? true : Boolean(o.structural),
    ops: (o.ops as unknown[]).map((op, i) => parseOp(op, `${path}.ops[${i}]`)),
  };
}

function parseTrigger(v: unknown, path: string): TriggerDoc {
  if (!isObj(v)) fail(path, `ожидался объект триггера, пришло ${show(v)}`);
  const o = v as Record<string, unknown>;
  const kind = str(o.kind, `${path}.kind`);
  if (!TRIGGER_KINDS.has(kind)) {
    fail(`${path}.kind`, `неизвестный вид «${kind}», ожидался один из ${[...TRIGGER_KINDS].join(', ')}`);
  }
  return {
    id: str(o.id, `${path}.id`),
    kind: kind as TriggerKind,
    center: vec3(o.center, `${path}.center`),
    halfExtents: vec3(o.halfExtents, `${path}.halfExtents`),
    ...(o.once === undefined ? {} : { once: Boolean(o.once) }),
    ...(o.label === undefined ? {} : { label: str(o.label, `${path}.label`) }),
  };
}

function parseVehicle(v: unknown, path: string): VehicleDoc {
  if (!isObj(v)) fail(path, `ожидался объект техники, пришло ${show(v)}`);
  const o = v as Record<string, unknown>;
  const kind = str(o.kind, `${path}.kind`);
  if (!(kind in VEHICLES)) {
    fail(`${path}.kind`, `нет такой техники «${kind}», есть ${Object.keys(VEHICLES).join(', ')}`);
  }
  return {
    id: str(o.id, `${path}.id`),
    kind: kind as VehicleKind,
    position: vec3(o.position, `${path}.position`),
    ...(o.yaw === undefined ? {} : { yaw: num(o.yaw, `${path}.yaw`) }),
  };
}

function parseTarget(v: unknown, path: string): TargetDoc {
  if (!isObj(v)) fail(path, `ожидался объект цели, пришло ${show(v)}`);
  const o = v as Record<string, unknown>;
  const kind = str(o.kind, `${path}.kind`);
  if (!TARGET_KINDS.has(kind)) {
    fail(`${path}.kind`, `неизвестный вид цели «${kind}»`);
  }
  return {
    id: str(o.id, `${path}.id`),
    name: str(o.name, `${path}.name`),
    kind: kind as TargetSpec['kind'],
    wired: Boolean(o.wired),
    required: Boolean(o.required),
    value: num(o.value, `${path}.value`),
    position: vec3(o.position, `${path}.position`),
    ...(o.mass === undefined ? {} : { mass: num(o.mass, `${path}.mass`) }),
  };
}

function parseMission(v: unknown, path: string): MissionDoc {
  if (!isObj(v)) fail(path, `ожидался объект миссии, пришло ${show(v)}`);
  const o = v as Record<string, unknown>;
  const alarm = num(o.alarmSeconds, `${path}.alarmSeconds`);
  if (alarm <= 0) fail(`${path}.alarmSeconds`, `таймер должен быть положительным, пришло ${alarm}`);
  if (!Array.isArray(o.targets) || o.targets.length === 0) {
    fail(`${path}.targets`, 'у миссии должна быть хотя бы одна цель');
  }
  const targets = (o.targets as unknown[]).map((t, i) => parseTarget(t, `${path}.targets[${i}]`));
  if (!targets.some((t) => t.required)) {
    fail(`${path}.targets`, 'нужна хотя бы одна обязательная цель, иначе миссию нельзя выполнить');
  }
  const ids = new Set<string>();
  for (const t of targets) {
    if (ids.has(t.id)) fail(`${path}.targets`, `повторяется id цели «${t.id}»`);
    ids.add(t.id);
  }
  const ex = isObj(o.extraction) ? (o.extraction as Record<string, unknown>) : fail(`${path}.extraction`, 'нет зоны эвакуации');
  return {
    id: str(o.id, `${path}.id`),
    name: str(o.name, `${path}.name`),
    brief: str(o.brief, `${path}.brief`),
    alarmSeconds: alarm,
    targets,
    extraction: {
      center: vec3(ex.center, `${path}.extraction.center`),
      halfExtents: vec3(ex.halfExtents, `${path}.extraction.halfExtents`),
    },
    ...(o.maxCarried === undefined ? {} : { maxCarried: int(o.maxCarried, `${path}.maxCarried`, 1) }),
    ...(o.requirePlayerInZone === undefined
      ? {}
      : { requirePlayerInZone: Boolean(o.requirePlayerInZone) }),
  };
}

function parseChaser(v: unknown, path: string): ChaserDoc {
  if (!isObj(v)) fail(path, `ожидался объект преследователя, пришло ${show(v)}`);
  const o = v as Record<string, unknown>;
  const kind = str(o.kind, `${path}.kind`);
  if (kind !== 'helicopter' && kind !== 'boat') {
    fail(`${path}.kind`, `ожидался helicopter или boat, пришло «${kind}»`);
  }
  return {
    kind: kind as ChaserKind,
    from: vec3(o.from, `${path}.from`),
    hover: num(o.hover, `${path}.hover`),
    maxSpeed: num(o.maxSpeed, `${path}.maxSpeed`),
    lead: num(o.lead, `${path}.lead`),
    light: num(o.light, `${path}.light`),
    ...(o.aquatic === undefined ? {} : { aquatic: Boolean(o.aquatic) }),
  };
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function parseLight(v: unknown, path: string): LightDocEntry {
  if (!isObj(v)) fail(path, `ожидался объект источника света, пришло ${show(v)}`);
  const o = v as Record<string, unknown>;
  const kind = str(o.kind, `${path}.kind`);
  if (kind !== 'point' && kind !== 'spot') {
    fail(`${path}.kind`, `ожидался point или spot, пришло «${kind}»`);
  }
  const color = str(o.color, `${path}.color`);
  if (!HEX_COLOR.test(color)) {
    fail(`${path}.color`, `цвет пишется как #rrggbb, пришло «${color}»`);
  }
  return {
    kind,
    position: vec3(o.position, `${path}.position`),
    ...(o.target === undefined ? {} : { target: vec3(o.target, `${path}.target`) }),
    color,
    intensity: num(o.intensity, `${path}.intensity`),
    range: num(o.range, `${path}.range`),
    ...(o.angle === undefined ? {} : { angle: num(o.angle, `${path}.angle`) }),
    ...(o.shadow === undefined ? {} : { shadow: Boolean(o.shadow) }),
  };
}

function parseEnvironment(v: unknown, path: string): EnvironmentDoc {
  if (!isObj(v)) fail(path, `ожидался объект окружения, пришло ${show(v)}`);
  const o = v as Record<string, unknown>;
  if (o.daylight !== undefined && !DAYLIGHTS.has(String(o.daylight))) {
    fail(`${path}.daylight`, `ожидался day, dusk или night, пришло ${show(o.daylight)}`);
  }
  return {
    ...(o.daylight === undefined ? {} : { daylight: o.daylight as Daylight }),
    ...(Array.isArray(o.lights)
      ? { lights: (o.lights as unknown[]).map((l, i) => parseLight(l, `${path}.lights[${i}]`)) }
      : {}),
  };
}

const DAYLIGHTS: ReadonlySet<string> = new Set(['day', 'dusk', 'night']);

const TRIGGER_KINDS: ReadonlySet<string> = new Set([
  'alarm-cable',
  'extraction',
  'checkpoint',
  'hazard',
]);
const TARGET_KINDS: ReadonlySet<string> = new Set([
  'painting',
  'safe',
  'electronics',
  'documents',
  'cash',
]);

/**
 * Разобрать документ карты. Бросает LevelFormatError с путём до поля —
 * внешний редактор пишет мимо формата регулярно, и «Cannot read property
 * of undefined» тут не помощь никому.
 */
export function parseLevelDoc(input: unknown): LevelDoc {
  if (typeof input === 'string') return parseLevelDoc(JSON.parse(input));
  if (!isObj(input)) fail('карта', `ожидался объект, пришло ${show(input)}`);
  const o = input as Record<string, unknown>;
  if (o.format !== LEVEL_FORMAT) {
    fail('format', `ожидалось «${LEVEL_FORMAT}», пришло ${show(o.format)}`);
  }
  const version = int(o.version, 'version', 1);
  if (version > LEVEL_VERSION) {
    fail('version', `карта версии ${version}, а игра понимает до ${LEVEL_VERSION}`);
  }
  if (!Array.isArray(o.volumes) || o.volumes.length === 0) {
    fail('volumes', 'в карте нет ни одного объёма геометрии');
  }
  const voxelSize = num(o.voxelSize, 'voxelSize');
  if (voxelSize <= 0) fail('voxelSize', `размер вокселя должен быть положительным, пришло ${voxelSize}`);
  const spawnRaw = isObj(o.spawn) ? (o.spawn as Record<string, unknown>) : fail('spawn', 'нет точки старта');
  const sp = vec3(spawnRaw.position, 'spawn.position');

  return {
    format: LEVEL_FORMAT,
    version,
    id: str(o.id, 'id'),
    name: str(o.name, 'name'),
    brief: str(o.brief, 'brief'),
    voxelSize,
    waterLevel: num(o.waterLevel, 'waterLevel'),
    spawn: { position: sp, yaw: num(spawnRaw.yaw, 'spawn.yaw') },
    volumes: (o.volumes as unknown[]).map((v, i) => parseVolume(v, `volumes[${i}]`)),
    props: Array.isArray(o.props)
      ? (o.props as unknown[]).map((p, i) => parseProp(p, `props[${i}]`))
      : [],
    triggers: Array.isArray(o.triggers)
      ? (o.triggers as unknown[]).map((t, i) => parseTrigger(t, `triggers[${i}]`))
      : [],
    vehicles: Array.isArray(o.vehicles)
      ? (o.vehicles as unknown[]).map((v, i) => parseVehicle(v, `vehicles[${i}]`))
      : [],
    mission: parseMission(o.mission, 'mission'),
    ...(Array.isArray(o.pursuit)
      ? { pursuit: (o.pursuit as unknown[]).map((c, i) => parseChaser(c, `pursuit[${i}]`)) }
      : {}),
    ...(o.environment === undefined
      ? {}
      : { environment: parseEnvironment(o.environment, 'environment') }),
    ...(Array.isArray(o.routes)
      ? { routes: (o.routes as unknown[]).map((r, i) => parseRoute(r, `routes[${i}]`)) }
      : {}),
  };
}

const ROUTE_NEEDS: readonly RouteNeeds[] = ['foot', 'planks', 'vehicle', 'boat'];

function parseRoute(v: unknown, path: string): RouteDoc {
  if (!isObj(v)) fail(path, `ожидался объект маршрута, пришло ${show(v)}`);
  const o = v as Record<string, unknown>;
  const needs = str(o.needs, `${path}.needs`);
  if (!ROUTE_NEEDS.includes(needs as RouteNeeds)) {
    fail(`${path}.needs`, `ожидалось одно из ${ROUTE_NEEDS.join(', ')}, пришло «${needs}»`);
  }
  if (!Array.isArray(o.waypoints) || o.waypoints.length < 2) {
    fail(`${path}.waypoints`, `маршрут — это хотя бы две точки, пришло ${show(o.waypoints)}`);
  }
  return {
    id: str(o.id, `${path}.id`),
    name: str(o.name, `${path}.name`),
    needs: needs as RouteNeeds,
    waypoints: (o.waypoints as unknown[]).map((w, i) => vec3(w, `${path}.waypoints[${i}]`)),
    ...(o.collects === undefined
      ? {}
      : {
          collects: (() => {
            if (!Array.isArray(o.collects)) {
              fail(`${path}.collects`, `ожидался список имён ценностей, пришло ${show(o.collects)}`);
            }
            return (o.collects as unknown[]).map((c, i) => str(c, `${path}.collects[${i}]`));
          })(),
        }),
  };
}

function parseProp(v: unknown, path: string): PropDoc {
  if (!isObj(v)) fail(path, `ожидался объект предмета, пришло ${show(v)}`);
  const o = v as Record<string, unknown>;
  return {
    name: str(o.name, `${path}.name`),
    kind: o.kind === 'dynamic' ? 'dynamic' : 'static',
    tags: Array.isArray(o.tags) ? (o.tags as unknown[]).map((t, i) => str(t, `${path}.tags[${i}]`)) : [],
    passive: Boolean(o.passive),
    volume: parseVolume(o.volume, `${path}.volume`),
  };
}

// ---------------------------------------------------------------------------
// Сборка геометрии
// ---------------------------------------------------------------------------

const identity = (): Transform => ({
  position: v3(),
  rotation: { x: 0, y: 0, z: 0, w: 1 },
});

/** Собрать форму по описанию объёма. */
export function buildVolume(doc: VolumeDoc, voxelSize: number): VoxelShape {
  const [sx, sy, sz] = doc.size;
  const shape = new VoxelShape({
    sx,
    sy,
    sz,
    voxelSize,
    grounded: doc.grounded ?? true,
    name: doc.name,
  });
  shape.transform = {
    ...identity(),
    position: v3(doc.position[0], doc.position[1], doc.position[2]),
  };
  shape.structural = doc.structural ?? true;
  doc.ops.forEach((op, i) => applyOp(shape, op, `объём «${doc.name}».ops[${i}]`));
  return shape;
}

function region(shape: VoxelShape, b?: BoxDoc) {
  return b
    ? { x0: b[0], y0: b[1], z0: b[2], x1: b[3], y1: b[4], z1: b[5] }
    : { x0: 0, y0: 0, z0: 0, x1: shape.sx, y1: shape.sy, z1: shape.sz };
}

function applyOp(shape: VoxelShape, op: OpDoc, path: string): void {
  switch (op.op) {
    case 'fill':
      shape.fill(region(shape, op.box), mat(op.mat, `${path}.mat`));
      return;
    case 'hollow': {
      const r = region(shape, op.box);
      const t = op.thickness ?? 3;
      const rt = op.roofThickness ?? t;
      const wall = mat(op.wall, `${path}.wall`);
      const roof = op.roof ? mat(op.roof, `${path}.roof`) : wall;
      const floor = op.floor ? mat(op.floor, `${path}.floor`) : wall;
      shape.fill(r, wall);
      shape.fill(
        {
          x0: r.x0 + t,
          y0: r.y0 + t,
          z0: r.z0 + t,
          x1: r.x1 - t,
          y1: r.y1 - rt,
          z1: r.z1 - t,
        },
        Mat.Air,
      );
      shape.fill({ ...r, y1: r.y0 + t }, floor);
      shape.fill({ ...r, y0: r.y1 - rt }, roof);
      return;
    }
    case 'beams': {
      const r = region(shape, op.box);
      const m = mat(op.mat, `${path}.mat`);
      const w = op.width ?? 3;
      for (let x = r.x0 + op.spacingX; x < r.x1 - w; x += op.spacingX) {
        shape.fill({ ...r, x0: x, x1: x + w, y0: op.y, y1: op.y + op.height }, m);
      }
      for (let z = r.z0 + op.spacingZ; z < r.z1 - w; z += op.spacingZ) {
        shape.fill({ ...r, z0: z, z1: z + w, y0: op.y, y1: op.y + op.height }, m);
      }
      return;
    }
    case 'grid': {
      const [x0, y0, z0, x1, y1, z1] = op.box;
      const m = mat(op.mat, `${path}.mat`);
      const [cx, cy, cz] = op.cell;
      const [dx, dy, dz] = op.step;
      // Коробка задаёт, где ячейки НАЧИНАЮТСЯ, а не где кончаются: свая у
      // самого края причала остаётся полноразмерной сваей, а не обрезком.
      // По границам формы обрежет сам fill.
      for (let y = y0; y < y1; y += dy) {
        for (let z = z0; z < z1; z += dz) {
          for (let x = x0; x < x1; x += dx) {
            shape.fill({ x0: x, y0: y, z0: z, x1: x + cx, y1: y + cy, z1: z + cz }, m);
          }
        }
      }
      return;
    }
    case 'line': {
      drawLine(shape, op.points, mat(op.mat, `${path}.mat`));
      return;
    }
    case 'voxels': {
      const [ax, ay, az] = op.at;
      const [sx, sy, sz] = op.size;
      const buf = new Uint8Array(sx * sy * sz);
      decodeRle(op.rle, buf);
      for (let y = 0; y < sy; y++) {
        for (let z = 0; z < sz; z++) {
          for (let x = 0; x < sx; x++) {
            const m = buf[x + sx * (z + sz * y)];
            if (m === Mat.Air) continue;
            shape.set(ax + x, ay + y, az + z, m);
          }
        }
      }
      return;
    }
  }
}

/**
 * Ломаная по осям, толщиной в воксель. Ровно то же, чем в «Порту» проложен
 * кабель сигнализации: сначала выравниваем x, потом y, потом z.
 */
function drawLine(shape: VoxelShape, pts: Vec3Doc[], m: number): void {
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0, z0] = pts[i - 1];
    const [x1, y1, z1] = pts[i];
    const dx = Math.sign(x1 - x0);
    const dy = Math.sign(y1 - y0);
    const dz = Math.sign(z1 - z0);
    let x = x0;
    let y = y0;
    let z = z0;
    let guard = 0;
    for (;;) {
      shape.set(x, y, z, m);
      if ((x === x1 && y === y1 && z === z1) || guard++ > LINE_GUARD) break;
      if (x !== x1) x += dx;
      else if (y !== y1) y += dy;
      else z += dz;
    }
  }
}

/** Потолок длины ломаной: страховка от кабеля на миллион вокселей. */
const LINE_GUARD = 20000;

/** Цель — небольшое тело из «ценного» материала, которое можно унести. */
function buildTargetBody(spec: TargetSpec, voxelSize: number): Body {
  const size = spec.kind === 'safe' ? 0.8 : 0.4;
  const n = Math.max(2, Math.round(size / voxelSize));
  const s = new VoxelShape({
    sx: n,
    sy: n,
    sz: n,
    voxelSize,
    grounded: false,
    name: `target:${spec.id}`,
  });
  s.fill({}, Mat.Loot);
  s.transform = {
    ...identity(),
    position: v3((-n / 2) * voxelSize, 0, (-n / 2) * voxelSize),
  };
  return new Body({
    kind: 'dynamic',
    shapes: [s],
    name: spec.name,
    tags: ['target', `target:${spec.id}`, spec.required ? 'required' : 'valuable'],
    transform: { position: { ...spec.position }, rotation: quatFromEulerYXZ(0.4, 0) },
  });
}

/**
 * Карта из документа.
 *
 * Возвращает обычный LevelSource: игре всё равно, откуда взялась карта —
 * из файла, из редактора или из кода.
 */
export function levelFromDoc(input: LevelDoc | unknown): LevelSource & { doc: LevelDoc } {
  // Проверяем всегда, даже если на вход пришёл уже разобранный документ:
  // «этот-то точно валидный» — как раз тот случай, когда карта падает
  // у игрока, а не в тесте.
  const doc = parseLevelDoc(input);
  const spawn: SpawnPoint = { position: point(doc.spawn.position), yaw: doc.spawn.yaw };
  const mission = missionOf(doc);

  return {
    id: doc.id,
    name: doc.name,
    brief: doc.brief,
    voxelSize: doc.voxelSize,
    waterLevel: doc.waterLevel,
    spawn,
    triggers: triggersOf(doc),
    vehicles: vehiclesOf(doc),
    mission,
    ...(doc.pursuit ? { pursuit: pursuitOf(doc)! } : {}),
    ...(doc.environment ? { environment: environmentOf(doc)! } : {}),
    ...(doc.routes ? { routes: routesOf(doc)! } : {}),
    doc,

    build(sim: Simulation): Body[] {
      const level = new Body({
        kind: 'static',
        shapes: doc.volumes.map((v) => buildVolume(v, doc.voxelSize)),
        name: doc.id,
        tags: ['level'],
      });
      sim.world.addBody(level);
      const out: Body[] = [level];

      for (const prop of doc.props ?? []) {
        const body = new Body({
          kind: prop.kind ?? 'static',
          shapes: [buildVolume(prop.volume, doc.voxelSize)],
          name: prop.name,
          tags: prop.tags ?? [],
          passive: prop.passive ?? false,
        });
        sim.world.addBody(body);
        out.push(body);
      }

      for (const spec of mission.targets) {
        const b = buildTargetBody(spec, doc.voxelSize);
        sim.world.addBody(b);
        sim.physics.sync(b);
        out.push(b);
      }

      // Карта строится «как задумано»: если что-то в ней не держится, это
      // баг геометрии, а не сюрприз игроку. Заодно прогреваем структурный
      // анализ на загрузке — иначе первый удар оплатит полный проход.
      for (const s of level.shapes) s.clearStructureDirty();
      sim.primeStructure();
      return out;
    },
  };
}


// ---------------------------------------------------------------------------
// Снимок обратно в документ
// ---------------------------------------------------------------------------

/**
 * Слепок построенной карты в документ с сырыми вокселями.
 *
 * Это выход для редактора: слепил в игре — сохранил файл. Операции при этом
 * теряются (в вокселях уже не видно, где была «коробка здания»), зато
 * геометрия совпадает воксель в воксель, и на это есть тест.
 */
export function docFromLevel(level: LevelSource, sim: Simulation): LevelDoc {
  const bodies = [...sim.world.bodies.values()];
  const levelBody = bodies.find((b) => b.tags.has('level'));
  if (!levelBody) throw new Error('В мире нет тела с тегом level — нечего сохранять');

  const volumes = levelBody.shapes.map((s) => snapshotVolume(s));
  const props: PropDoc[] = bodies
    .filter((b) => b !== levelBody && !b.tags.has('target'))
    .flatMap((b) =>
      b.shapes.map((s) => ({
        name: b.shapes.length > 1 ? `${b.name}:${s.name}` : b.name,
        kind: b.kind,
        tags: [...b.tags],
        passive: b.passive,
        volume: snapshotVolume(s),
      })),
    );

  return {
    format: LEVEL_FORMAT,
    version: LEVEL_VERSION,
    id: level.id,
    name: level.name,
    brief: level.brief,
    voxelSize: level.voxelSize,
    waterLevel: level.waterLevel,
    spawn: {
      position: [level.spawn.position.x, level.spawn.position.y, level.spawn.position.z],
      yaw: level.spawn.yaw,
    },
    volumes,
    props,
    triggers: level.triggers.map((t) => ({
      ...t,
      center: flat(t.center),
      halfExtents: flat(t.halfExtents),
    })),
    vehicles: level.vehicles.map((v) => ({ ...v, position: flat(v.position) })),
    mission: {
      ...level.mission,
      targets: level.mission.targets.map((t) => ({ ...t, position: flat(t.position) })),
      extraction: {
        center: flat(level.mission.extraction.center),
        halfExtents: flat(level.mission.extraction.halfExtents),
      },
    },
    ...(level.pursuit ? { pursuit: level.pursuit.map((c) => ({ ...c, from: flat(c.from) })) } : {}),
    ...(level.routes
      ? { routes: level.routes.map((r) => ({ ...r, waypoints: r.waypoints.map(flat) })) }
      : {}),
    ...(level.environment
      ? {
          environment: {
            daylight: level.environment.daylight,
            lights: level.environment.lights.map((l): LightDocEntry => {
              const { position, target, ...rest } = l;
              return {
                ...rest,
                position: flat(position),
                ...(target ? { target: flat(target) } : {}),
              };
            }),
          },
        }
      : {}),
  };
}

function snapshotVolume(s: VoxelShape): VolumeDoc {
  return {
    name: s.name,
    size: [s.sx, s.sy, s.sz],
    position: [s.transform.position.x, s.transform.position.y, s.transform.position.z],
    grounded: s.grounded,
    structural: s.structural,
    ops: [
      {
        op: 'voxels',
        at: [0, 0, 0],
        size: [s.sx, s.sy, s.sz],
        rle: encodeRle(s.data),
      },
    ],
  };
}
