import {
  Body,
  Mat,
  Simulation,
  VoxelShape,
  quatFromEulerYXZ,
  v3,
} from '@tvox/core';
import { LevelSource, TriggerDef, VehicleSpawnDef } from '../level.js';
import { MissionConfig, TargetSpec } from '../mission.js';

export const VOXEL = 0.1;
/** Метры → воксели. */
const M = (m: number) => Math.round(m / VOXEL);

/** Уровень воды в гавани, м. Причал и набережная — на нуле. */
export const WATER_LEVEL = -0.4;
const SEABED = -1.8;

const GROUND_SX = M(48);
const GROUND_SY = M(3);
const GROUND_SZ = M(36);
/** Верх грунта совпадает с нулём мира. */
const GROUND_Y = -3;

const HARBOUR_Z = M(10);

interface BuildBox {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

const box = (
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): BuildBox => ({ x0, y0, z0, x1, y1, z1 });

function fill(shape: VoxelShape, b: BuildBox, mat: Mat): void {
  shape.fill(b, mat);
}

/**
 * Коробка здания: стены, пол, крыша. Внутри пусто.
 * Толщина стен в вокселях задаётся отдельно, чтобы кувалда пробивала
 * их за разумное число ударов, а не за один.
 */
function hollowBuilding(
  shape: VoxelShape,
  wallMat: Mat,
  roofMat: Mat,
  floorMat: Mat,
  thickness = 3,
  roofThickness = thickness,
): void {
  const { sx, sy, sz } = shape;
  fill(shape, box(0, 0, 0, sx, sy, sz), wallMat);
  fill(
    shape,
    box(thickness, thickness, thickness, sx - thickness, sy - roofThickness, sz - thickness),
    Mat.Air,
  );
  fill(shape, box(0, 0, 0, sx, thickness, sz), floorMat);
  fill(shape, box(0, sy - roofThickness, 0, sx, sy, sz), roofMat);
}

/**
 * Балочная клетка под перекрытием. Без неё плоская плита пролётом
 * в двадцать метров ломается от собственного веса — и это правильно:
 * настоящие крыши держатся на балках, а перерезанная балка роняет
 * ровно тот пролёт, который держала.
 */
function roofBeams(
  shape: VoxelShape,
  y0: number,
  height: number,
  spacingX: number,
  spacingZ: number,
  mat: Mat,
  width = 3,
): void {
  const { sx, sz } = shape;
  for (let x = spacingX; x < sx - width; x += spacingX) {
    fill(shape, box(x, y0, 0, x + width, y0 + height, sz), mat);
  }
  for (let z = spacingZ; z < sz - width; z += spacingZ) {
    fill(shape, box(0, y0, z, sx, y0 + height, z + width), mat);
  }
}

function cutOpening(shape: VoxelShape, b: BuildBox): void {
  fill(shape, b, Mat.Air);
}

function makeShape(
  sx: number,
  sy: number,
  sz: number,
  pos: { x: number; y: number; z: number },
  name: string,
  grounded = true,
): VoxelShape {
  const s = new VoxelShape({ sx, sy, sz, voxelSize: VOXEL, grounded, name });
  s.transform = { position: v3(pos.x, pos.y, pos.z), rotation: { x: 0, y: 0, z: 0, w: 1 } };
  return s;
}

// ---------------------------------------------------------------------------
// Части уровня
// ---------------------------------------------------------------------------

function buildGround(): VoxelShape {
  const s = makeShape(GROUND_SX, GROUND_SY, GROUND_SZ, { x: 0, y: GROUND_Y, z: 0 }, 'ground');
  // Нижний слой — неразрушимый фундамент: карта не проваливается сама в себя.
  fill(s, box(0, 0, 0, GROUND_SX, M(0.3), GROUND_SZ), Mat.Foundation);
  fill(s, box(0, M(0.3), 0, GROUND_SX, GROUND_SY - M(0.3), GROUND_SZ), Mat.Dirt);
  // Бетонная набережная сверху.
  fill(s, box(0, GROUND_SY - M(0.3), 0, GROUND_SX, GROUND_SY, GROUND_SZ), Mat.Concrete);
  // Акватория: вынимаем грунт до дна гавани.
  fill(s, box(0, M(3 + SEABED), 0, GROUND_SX, GROUND_SY, HARBOUR_Z), Mat.Air);
  return s;
}

function buildWater(): Body {
  const depth = M(WATER_LEVEL - SEABED);
  const s = makeShape(GROUND_SX, depth, HARBOUR_Z, { x: 0, y: SEABED, z: 0 }, 'water', false);
  fill(s, box(0, 0, 0, GROUND_SX, depth, HARBOUR_Z), Mat.Water);
  return new Body({
    kind: 'static',
    shapes: [s],
    name: 'harbour',
    tags: ['water'],
    passive: true,
  });
}

/** Главный склад: кирпич, стальные ворота, бетонные колонны внутри. */
function buildWarehouse(): VoxelShape {
  const sx = M(20);
  const sy = M(8);
  const sz = M(16);
  const s = makeShape(sx, sy, sz, { x: 6, y: 0, z: 14 }, 'warehouse');
  // Настил крыши тонкий: двадцать сантиметров сплошной стали над залом
  // 20×16 м весили бы четыреста тонн и складывали здание сами собой.
  hollowBuilding(s, Mat.Brick, Mat.Metal, Mat.Concrete, 3, 1);
  roofBeams(s, sy - M(0.6), M(0.5), M(4), M(4), Mat.HeavyMetal, 3);

  // Ворота из стали — кувалдой не взять, нужна лампа или заряд.
  fill(s, box(M(8), 0, 0, M(12), M(4), 3), Mat.Metal);
  // Окна под крышей.
  for (let x = M(2); x < sx - M(2); x += M(4)) {
    fill(s, box(x, M(5.5), 0, x + M(2), M(7), 3), Mat.Glass);
    fill(s, box(x, M(5.5), sz - 3, x + M(2), M(7), sz), Mat.Glass);
  }
  // Несущие колонны под балками: подпилишь — сядет крыша над пролётом.
  for (const cx of [M(4), M(8), M(12), M(16)]) {
    for (const cz of [M(4), M(8), M(12)]) {
      fill(s, box(cx - 2, 3, cz - 2, cx + 2, sy - M(0.6), cz + 2), Mat.Concrete);
    }
  }
  // Внутренняя кладовая с сейфом.
  fill(s, box(M(14), 3, M(10), M(19), M(5), M(15)), Mat.Concrete);
  fill(s, box(M(14) + 3, 3, M(10) + 3, M(19) - 1, M(5) - 2, M(15) - 1), Mat.Air);
  cutOpening(s, box(M(14), 3, M(12), M(14) + 3, M(4.5), M(13.5)));
  return s;
}

/** Офис: много стекла, документы внутри. */
function buildOffice(): VoxelShape {
  const sx = M(10);
  const sy = M(6);
  const sz = M(10);
  const s = makeShape(sx, sy, sz, { x: 30, y: 0, z: 14 }, 'office');
  hollowBuilding(s, Mat.Concrete, Mat.Concrete, Mat.Concrete, 2, 2);
  // Витражи по всему первому этажу.
  fill(s, box(M(1), M(1), 0, sx - M(1), M(2.8), 2), Mat.Glass);
  fill(s, box(M(1), M(1), sz - 2, sx - M(1), M(2.8), sz), Mat.Glass);
  fill(s, box(0, M(1), M(1), 2, M(2.8), sz - M(1)), Mat.Glass);
  // Перекрытие второго этажа.
  fill(s, box(2, M(3), 2, sx - 2, M(3) + 2, sz - 2), Mat.Concrete);
  cutOpening(s, box(M(7), M(3), M(7), M(9), M(3) + 2, M(9)));
  // Центральная колонна на всю высоту — иначе перекрытия провисают.
  fill(s, box(M(4.6), 2, M(4.6), M(5.4), sy - 2, M(5.4)), Mat.Concrete);
  // Дверь и бетонная перемычка над ней: витраж не должен нести стену.
  cutOpening(s, box(M(4.2), 0, 0, M(5.8), M(2.2), 2));
  // Перемычка стальная: бетонная такого пролёта не держит, а сталь держит —
  // и её можно перерезать лампой, чтобы уронить стену над входом.
  fill(s, box(M(3.8), M(2.2), 0, M(6.2), M(3.2), 2), Mat.Metal);
  return s;
}

/**
 * Портовый кран: центральная башня с аутригерами, кабина сверху, короткая стрела.
 * Схема с четырьмя угловыми ногами и кабиной-мостом между ними выглядит
 * эффектнее, но шестиметровый пролёт без фермы честная физика не держит.
 */
function buildCrane(): VoxelShape {
  const sx = M(8);
  const sy = M(14);
  const sz = M(6);
  const s = makeShape(sx, sy, sz, { x: 28, y: 0, z: 4 }, 'crane');

  // Основание с аутригерами.
  fill(s, box(0, 0, 0, sx, M(0.8), sz), Mat.HeavyMetal);
  fill(s, box(M(1), M(0.8), M(1), M(1) + M(3), M(1.4), M(1) + M(3)), Mat.HeavyMetal);

  // Башня 3×3 м.
  const tx0 = M(1);
  const tz0 = M(1.5);
  fill(s, box(tx0, 0, tz0, tx0 + M(3), M(11), tz0 + M(3)), Mat.HeavyMetal);
  // Внутри шахта — есть куда лезть и что подрывать.
  fill(s, box(tx0 + 3, M(1.4), tz0 + 3, tx0 + M(3) - 3, M(11) - 3, tz0 + M(3) - 3), Mat.Air);

  // Кабина с метровым свесом. Пол кабины — из тяжёлой стали:
  // именно он работает консолью и держит всё остальное.
  fill(s, box(0, M(11), 0, M(5), M(11.3), sz), Mat.HeavyMetal);
  fill(s, box(0, M(11.3), 0, M(5), M(13.6), sz), Mat.Metal);
  fill(s, box(2, M(11.3), 2, M(5) - 2, M(13.2), sz - 2), Mat.Air);
  fill(s, box(2, M(11.6), 0, M(5) - 2, M(13), 2), Mat.Glass);

  // Короткая стрела в сторону воды. Длиннее — и она отламывается
  // под собственным весом, что физика честно и показывает.
  fill(s, box(M(3.5), M(9.5), M(2.4), M(7), M(10.1), M(3.6)), Mat.HeavyMetal);
  return s;
}

/** Причал на сваях над водой. */
function buildPier(): VoxelShape {
  const sx = M(14);
  const sy = M(2.2);
  const sz = M(9);
  const s = makeShape(sx, sy, sz, { x: 4, y: SEABED, z: 0.5 }, 'pier');
  for (let x = 2; x < sx - 2; x += M(1.5)) {
    for (let z = 2; z < sz - 2; z += M(1.5)) {
      fill(s, box(x, 0, z, x + 3, sy - 2, z + 3), Mat.Wood);
    }
  }
  fill(s, box(0, sy - 2, 0, sx, sy, sz), Mat.Plank);
  return s;
}

/** Штабель контейнеров. */
function buildContainers(): VoxelShape {
  const sx = M(18);
  const sy = M(5.2);
  const sz = M(3);
  const s = makeShape(sx, sy, sz, { x: 4, y: 0, z: 32 }, 'containers');
  const cw = M(6);
  const ch = M(2.6);
  for (let i = 0; i < 3; i++) {
    fill(s, box(i * cw, 0, 0, (i + 1) * cw - 2, ch, sz), Mat.Metal);
    fill(s, box(i * cw + 2, 2, 2, (i + 1) * cw - 4, ch - 2, sz - 2), Mat.Air);
  }
  // Второй ярус — только два контейнера, чтобы силуэт читался.
  for (let i = 0; i < 2; i++) {
    fill(s, box(i * cw, ch, 0, (i + 1) * cw - 2, ch * 2, sz), Mat.Metal);
    fill(s, box(i * cw + 2, ch + 2, 2, (i + 1) * cw - 4, ch * 2 - 2, sz - 2), Mat.Air);
  }
  return s;
}

/** Забор по периметру: он же граница «внутри объекта». */
function buildFence(): VoxelShape {
  const sx = GROUND_SX;
  const sy = M(2.5);
  const sz = M(26);
  const s = makeShape(sx, sy, sz, { x: 0, y: 0, z: 10 }, 'fence');
  fill(s, box(0, 0, sz - 2, sx, sy, sz), Mat.Metal);
  fill(s, box(0, 0, 0, 2, sy, sz), Mat.Metal);
  fill(s, box(sx - 2, 0, 0, sx, sy, sz), Mat.Metal);
  // Ворота на выезд.
  cutOpening(s, box(M(42), 0, sz - 2, M(47), sy, sz));
  return s;
}

/** Цель — небольшое тело из «ценного» материала, которое можно унести. */
function buildTargetBody(spec: TargetSpec, size: number): Body {
  const n = Math.max(2, Math.round(size / VOXEL));
  const s = new VoxelShape({
    sx: n,
    sy: n,
    sz: n,
    voxelSize: VOXEL,
    grounded: false,
    name: `target:${spec.id}`,
  });
  s.fill({}, Mat.Loot);
  s.transform = {
    position: v3((-n / 2) * VOXEL, 0, (-n / 2) * VOXEL),
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };
  return new Body({
    kind: 'dynamic',
    shapes: [s],
    name: spec.name,
    tags: ['target', `target:${spec.id}`, spec.required ? 'required' : 'valuable'],
    transform: { position: { ...spec.position }, rotation: quatFromEulerYXZ(0.4, 0) },
  });
}

// ---------------------------------------------------------------------------
// Цели, триггеры, техника
// ---------------------------------------------------------------------------

export const PORT_TARGETS: TargetSpec[] = [
  {
    id: 'safe',
    name: 'Сейф',
    kind: 'safe',
    wired: true,
    required: true,
    value: 42000,
    position: v3(6 + 16.5, 0.4, 14 + 12.5),
    mass: 180,
  },
  {
    id: 'docs',
    name: 'Папка с документами',
    kind: 'documents',
    wired: true,
    required: true,
    value: 26000,
    position: v3(30 + 5, 3.4, 14 + 5),
    mass: 6,
  },
  {
    id: 'painting',
    name: 'Картина',
    kind: 'painting',
    wired: false,
    required: false,
    value: 14000,
    position: v3(30 + 8, 0.6, 14 + 8),
    mass: 12,
  },
  {
    id: 'electronics',
    name: 'Ящик электроники',
    kind: 'electronics',
    wired: false,
    required: false,
    value: 9000,
    position: v3(4 + 3, 0.4, 32 + 1.5),
    mass: 40,
  },
  {
    id: 'cash',
    name: 'Инкассаторская сумка',
    kind: 'cash',
    wired: false,
    required: false,
    value: 17000,
    position: v3(28 + 3, 11.4, 4 + 3),
    mass: 25,
  },
];

export const PORT_EXTRACTION = {
  center: v3(45, 1.5, 33),
  halfExtents: v3(3, 2.5, 3),
};

export const PORT_TRIGGERS: TriggerDef[] = [
  {
    id: 'alarm-cable-warehouse',
    kind: 'alarm-cable',
    center: v3(6 + 16.5, 1, 14 + 12.5),
    halfExtents: v3(2.5, 2, 2.5),
    once: true,
    label: 'Кабель сигнализации, кладовая',
  },
  {
    id: 'alarm-cable-office',
    kind: 'alarm-cable',
    center: v3(30 + 5, 4, 14 + 5),
    halfExtents: v3(2.5, 1.5, 2.5),
    once: true,
    label: 'Кабель сигнализации, второй этаж',
  },
  {
    id: 'extraction',
    kind: 'extraction',
    center: PORT_EXTRACTION.center,
    halfExtents: PORT_EXTRACTION.halfExtents,
    label: 'Зона эвакуации',
  },
];

export const PORT_VEHICLES: VehicleSpawnDef[] = [
  { id: 'van', kind: 'pickup', position: v3(44, 0.1, 28), yaw: Math.PI },
  { id: 'car', kind: 'car', position: v3(38, 0.1, 30), yaw: Math.PI },
  { id: 'boat', kind: 'boat', position: v3(10, WATER_LEVEL, 4), yaw: Math.PI / 2 },
  { id: 'dozer', kind: 'bulldozer', position: v3(24, 0.1, 32), yaw: 0 },
  { id: 'digger', kind: 'excavator', position: v3(20, 0.1, 12), yaw: Math.PI / 2 },
];

export const PORT_MISSION: MissionConfig = {
  id: 'port',
  name: 'Порт: ночная смена',
  brief:
    'Сейф в кладовой склада и документы в офисе. Оба на кабеле. ' +
    'Как только снимешь первый — шестьдесят секунд до вертолёта. ' +
    'Маршрут отхода готовь заранее.',
  alarmSeconds: 60,
  targets: PORT_TARGETS,
  extraction: PORT_EXTRACTION,
  maxCarried: 1,
  requirePlayerInZone: true,
};

/**
 * Стартовая карта M: индустриальная зона, порт.
 * Без сложных многоуровневых подвалов — реиграбельность идёт от вариантов
 * маршрута и времени, а не от лабиринта.
 */
export const portLevel: LevelSource = {
  id: 'port',
  name: 'Порт',
  brief: PORT_MISSION.brief,
  voxelSize: VOXEL,
  waterLevel: WATER_LEVEL,
  spawn: { position: v3(45, 0.05, 33), yaw: Math.PI },
  triggers: PORT_TRIGGERS,
  vehicles: PORT_VEHICLES,
  mission: PORT_MISSION,

  build(sim: Simulation): Body[] {
    const level = new Body({
      kind: 'static',
      shapes: [
        buildGround(),
        buildWarehouse(),
        buildOffice(),
        buildCrane(),
        buildPier(),
        buildContainers(),
        buildFence(),
      ],
      name: 'port',
      tags: ['level'],
    });
    sim.world.addBody(level);

    const water = buildWater();
    sim.world.addBody(water);

    const targets = PORT_TARGETS.map((spec) => {
      const b = buildTargetBody(spec, spec.kind === 'safe' ? 0.8 : 0.4);
      sim.world.addBody(b);
      sim.physics.sync(b);
      return b;
    });

    // Уровень строится «как задумано»: если что-то в нём не держится,
    // это баг геометрии, а не сюрприз для игрока.
    for (const s of level.shapes) s.clearStructureDirty();
    return [level, water, ...targets];
  },
};
