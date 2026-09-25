import { Mat, VoxelShape, encodeRle, materialByColor, materialByName, v3 } from '@tvox/core';
import { LEVEL_FORMAT, LEVEL_VERSION, LevelDoc, VolumeDoc } from './level-doc.js';

/**
 * Чтение MagicaVoxel (.vox).
 *
 * Зачем: рисовать здание списком коробок в JSON можно, но скучно, а .vox —
 * это то, в чём воксельные модели рисуют на самом деле. Формат читается
 * только на чтение и только то, что нам нужно: размеры, воксели, палитра.
 * Сцены, анимация и материалы MagicaVoxel игнорируются осознанно — у нас
 * своя таблица материалов, и она физическая, а не художественная.
 *
 * Структура файла: заголовок «VOX » + версия, дальше дерево чанков
 * `[id:4][размер содержимого:4][размер детей:4][содержимое][дети]`.
 * Нужные чанки: SIZE (габариты модели), XYZI (воксели), RGBA (палитра).
 */

export class VoxFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoxFormatError';
  }
}

export interface VoxModel {
  /** Габариты в осях MagicaVoxel: x вправо, y вперёд, z вверх. */
  size: { x: number; y: number; z: number };
  /** Плоский список по четыре байта: x, y, z, индекс палитры. */
  voxels: Uint8Array;
}

export interface VoxFile {
  version: number;
  models: VoxModel[];
  /** RGBA по 256 цветов, если чанк был в файле. */
  palette: Uint8Array | null;
}

const MAGIC = 0x564f5820; // 'VOX '

/** Число вокселей в модели. */
export const voxCount = (m: VoxModel): number => m.voxels.length >> 2;

export function readVox(input: ArrayBufferLike | ArrayBufferView): VoxFile {
  const bytes = ArrayBuffer.isView(input)
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8) throw new VoxFormatError('Файл короче заголовка .vox');
  if (view.getUint32(0, false) !== MAGIC) {
    throw new VoxFormatError('Это не .vox: нет подписи «VOX »');
  }
  const version = view.getUint32(4, true);

  const models: VoxModel[] = [];
  let palette: Uint8Array | null = null;
  let pendingSize: VoxModel['size'] | null = null;

  /** Обход дерева чанков. Дети идут сразу за содержимым родителя. */
  const walk = (start: number, end: number): void => {
    let p = start;
    while (p + 12 <= end) {
      const id = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
      const contentSize = view.getUint32(p + 4, true);
      const childrenSize = view.getUint32(p + 8, true);
      const content = p + 12;
      const children = content + contentSize;
      const next = children + childrenSize;
      if (next > end || content + contentSize > end) {
        throw new VoxFormatError(`Чанк ${id} вылезает за границы файла`);
      }

      switch (id) {
        case 'SIZE': {
          if (contentSize < 12) throw new VoxFormatError('Чанк SIZE короче двенадцати байт');
          pendingSize = {
            x: view.getUint32(content, true),
            y: view.getUint32(content + 4, true),
            z: view.getUint32(content + 8, true),
          };
          break;
        }
        case 'XYZI': {
          if (contentSize < 4) throw new VoxFormatError('Чанк XYZI короче четырёх байт');
          const n = view.getUint32(content, true);
          const need = 4 + n * 4;
          if (contentSize < need) {
            throw new VoxFormatError(`XYZI обещает ${n} вокселей, а места хватает не на всех`);
          }
          if (!pendingSize) throw new VoxFormatError('XYZI пришёл раньше SIZE');
          models.push({
            size: pendingSize,
            voxels: bytes.slice(content + 4, content + 4 + n * 4),
          });
          pendingSize = null;
          break;
        }
        case 'RGBA': {
          if (contentSize < 256 * 4) throw new VoxFormatError('Палитра RGBA короче 256 цветов');
          palette = bytes.slice(content, content + 256 * 4);
          break;
        }
        default:
          break;
      }

      if (childrenSize > 0) walk(children, next);
      p = next;
    }
  };

  walk(8, bytes.length);
  if (models.length === 0) throw new VoxFormatError('В файле нет ни одной модели');
  return { version, models, palette };
}

export interface VoxImportOptions {
  voxelSize?: number;
  name?: string;
  /**
   * Индекс палитры → имя материала. Перекрывает подбор по цвету.
   * Ровно то, чем художник объясняет игре, что серое здесь — бетон,
   * а не металл: по цвету это неразличимо, а по физике — принципиально.
   */
  palette?: Record<string | number, string>;
  /** Чем заполнять, если ни палитры, ни соответствия нет. */
  defaultMaterial?: Mat;
  grounded?: boolean;
  /** Мировое положение формы, м. */
  position?: { x: number; y: number; z: number };
}

/**
 * Таблица «индекс палитры → материал» для одной модели.
 *
 * Порядок разрешения: явное соответствие из опций → ближайший материал по
 * цвету из чанка RGBA → материал по умолчанию. Последнее нужно потому, что
 * файл с палитрой по умолчанию чанк RGBA не пишет вообще: в нём есть
 * индексы и нет цветов, и угадывать тут нечего.
 */
export function voxMaterialTable(file: VoxFile, opts: VoxImportOptions = {}): Uint8Array {
  const table = new Uint8Array(256);
  const fallback = opts.defaultMaterial ?? Mat.Concrete;
  for (let i = 0; i < 256; i++) {
    const named = opts.palette?.[i] ?? opts.palette?.[String(i)];
    if (named !== undefined) {
      const m = materialByName(named);
      if (!m) throw new VoxFormatError(`В соответствии палитры нет материала «${named}»`);
      table[i] = m.id;
      continue;
    }
    if (file.palette) {
      // Индекс i в XYZI указывает на цвет i-1: нулевой индекс — пустота.
      const at = (i - 1) * 4;
      const a = file.palette[at + 3];
      table[i] = a === 0
        ? fallback
        : materialByColor(file.palette[at], file.palette[at + 1], file.palette[at + 2]).id;
      continue;
    }
    table[i] = fallback;
  }
  table[0] = Mat.Air;
  return table;
}

/**
 * Модель .vox в форму движка.
 *
 * MagicaVoxel — Z вверх, у нас — Y. Пересадка осей здесь, а не «потом
 * повернём в редакторе»: модель, приехавшая лежащей на боку, — классическая
 * потеря часа на пустом месте.
 */
export function voxToShape(file: VoxFile, modelIndex = 0, opts: VoxImportOptions = {}): VoxelShape {
  const model = file.models[modelIndex];
  if (!model) {
    throw new VoxFormatError(`В файле ${file.models.length} моделей, запрошена ${modelIndex}`);
  }
  const table = voxMaterialTable(file, opts);
  const shape = new VoxelShape({
    sx: model.size.x,
    sy: model.size.z,
    sz: model.size.y,
    voxelSize: opts.voxelSize ?? 0.1,
    grounded: opts.grounded ?? true,
    name: opts.name ?? `vox${modelIndex}`,
  });
  if (opts.position) {
    shape.transform = {
      position: v3(opts.position.x, opts.position.y, opts.position.z),
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    };
  }

  const v = model.voxels;
  for (let i = 0; i < v.length; i += 4) {
    const m = table[v[i + 3]];
    if (m === Mat.Air) continue;
    shape.set(v[i], v[i + 2], v[i + 1], m);
    if (file.palette) {
      const at = (v[i + 3] - 1) * 4;
      const rgb = (file.palette[at] << 16) | (file.palette[at + 1] << 8) | file.palette[at + 2];
      shape.paint.set(shape.idx(v[i], v[i + 2], v[i + 1]), 0x1000000 + rgb);
    }
  }
  return shape;
}

/**
 * Модель .vox в объём документа карты.
 *
 * Это и есть мост между рисованием и форматом: нарисовал в MagicaVoxel —
 * положил в карту как обычный объём, дальше он живёт по общим правилам,
 * ломается и горит.
 */
export function voxToVolume(
  file: VoxFile,
  modelIndex = 0,
  opts: VoxImportOptions = {},
): VolumeDoc {
  const shape = voxToShape(file, modelIndex, opts);
  const pos = opts.position ?? { x: 0, y: 0, z: 0 };
  return {
    name: shape.name,
    size: [shape.sx, shape.sy, shape.sz],
    position: [pos.x, pos.y, pos.z],
    grounded: shape.grounded,
    structural: true,
    ops: [
      {
        op: 'voxels',
        at: [0, 0, 0],
        size: [shape.sx, shape.sy, shape.sz],
        rle: encodeRle(shape.data),
        paint: [...shape.paint],
      },
    ],
  };
}

/**
 * Готовая песочница вокруг импортированной модели.
 *
 * Смысл прост: нарисовал здание в MagicaVoxel — бросил файл в окно игры —
 * ходишь вокруг него и ломаешь. Без этого импорт остаётся строчкой в
 * документации, а не инструментом.
 */
export function voxSandboxDoc(
  file: VoxFile,
  modelIndex = 0,
  opts: VoxImportOptions = {},
): LevelDoc {
  const voxelSize = opts.voxelSize ?? 0.1;
  const model = file.models[modelIndex];
  if (!model) {
    throw new VoxFormatError(`В файле ${file.models.length} моделей, запрошена ${modelIndex}`);
  }
  // Площадка с запасом вокруг модели: есть где встать и куда отойти.
  const pad = Math.round(8 / voxelSize);
  const gx = model.size.x + pad * 2;
  const gz = model.size.y + pad * 2;
  const gy = Math.max(4, Math.round(1 / voxelSize));
  const at = { x: pad * voxelSize, y: 0, z: pad * voxelSize };
  const volume = voxToVolume(file, modelIndex, { ...opts, voxelSize, position: at });

  const cornerX = (pad / 2) * voxelSize;
  const cornerZ = (pad / 2) * voxelSize;

  return {
    format: LEVEL_FORMAT,
    version: LEVEL_VERSION,
    id: `vox-${modelIndex}`,
    name: opts.name ?? 'Импорт',
    brief: 'Импортированная модель. Ломать, смотреть, мерить.',
    voxelSize,
    // Воды нет: ставить уровень моря по чужой модели — гадание.
    waterLevel: -1000,
    spawn: { position: [cornerX, 0.05, cornerZ], yaw: -Math.PI * 0.75 },
    volumes: [
      {
        name: 'площадка',
        size: [gx, gy, gz],
        position: [0, -gy * voxelSize, 0],
        grounded: true,
        structural: false,
        ops: [
          { op: 'fill', mat: 'foundation' },
          { op: 'fill', box: [0, gy - 2, 0, gx, gy, gz], mat: 'concrete' },
        ],
      },
      volume,
    ],
    triggers: [],
    vehicles: [],
    mission: {
      id: `vox-${modelIndex}`,
      name: opts.name ?? 'Импорт',
      brief: 'Забрать ящик и уйти к точке старта.',
      alarmSeconds: 120,
      extraction: { center: [cornerX, 1, cornerZ], halfExtents: [2, 2, 2] },
      targets: [
        {
          id: 'crate',
          name: 'Ящик',
          kind: 'electronics',
          wired: false,
          required: true,
          value: 1000,
          position: [gx * voxelSize * 0.5, 0.4, cornerZ],
        },
      ],
    },
  };
}
