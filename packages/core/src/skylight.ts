import { Mat, isSolid } from './materials.js';
import { VoxelRegion, VoxelShape } from './voxel-shape.js';

/**
 * Свет от неба.
 *
 * Прямое солнце рисует карта теней на видеокарте, а вот «внутри темнее,
 * чем снаружи» она не знает: тень от крыши размазывается по всему залу
 * одинаково, и склад изнутри выглядит как склад снаружи. Поэтому
 * освещённость от неба считается по вокселям: колонка сверху вниз плюс
 * боковое растекание с затуханием.
 *
 * Ровно та же схема, что во всех воксельных играх, и по той же причине:
 * она пересчитывается локально. Пробил дыру в крыше — пересчиталась
 * колонка под дырой и её окрестность, а не весь уровень. Свет падает
 * внутрь в том же кадре, в котором исчезла кладка, и это единственное,
 * что делает разрушение читаемым изнутри.
 */

/** Максимальный уровень: небо. */
export const SKY_MAX = 15;

/**
 * Насколько далеко свет заходит вбок под козырёк.
 * Пятнадцать вокселей — полтора метра при десятисантиметровом вокселе:
 * достаточно, чтобы дверной проём осветил пол у входа, и мало, чтобы
 * через него засветился весь зал.
 */
const FALLOFF = 1;

export interface SkyLightOptions {
  /**
   * Материалы, которые свет проходит насквозь без потерь.
   * Стекло — да, иначе застеклённый офис внутри чёрный.
   */
  transparent?: ReadonlySet<number>;
}

const DEFAULT_TRANSPARENT: ReadonlySet<number> = new Set([Mat.Glass, Mat.Water]);

/** Свет проходит сквозь воксель, не теряя уровня. */
const passes = (mat: number, transparent: ReadonlySet<number>): boolean =>
  !isSolid(mat) || transparent.has(mat);

/**
 * Поле небесного света одной формы.
 *
 * Хранится байт на воксель. Для твёрдых вокселей значение — это свет,
 * который до них добрался бы, будь они воздухом: мешеру нужен свет со
 * стороны грани, а не внутри камня.
 */
export class SkyLight {
  readonly levels: Uint8Array;
  private transparent: ReadonlySet<number>;
  /** Очереди по уровням: растекание идёт от ярких к тусклым. */
  private buckets: number[][] = [];

  constructor(
    readonly shape: VoxelShape,
    opts: SkyLightOptions = {},
  ) {
    this.levels = new Uint8Array(shape.volume);
    this.transparent = opts.transparent ?? DEFAULT_TRANSPARENT;
    for (let i = 0; i <= SKY_MAX; i++) this.buckets.push([]);
    this.bake();
  }

  /** Уровень света в точке. Вне формы — открытое небо. */
  at(x: number, y: number, z: number): number {
    if (!this.shape.inBounds(x, y, z)) return SKY_MAX;
    return this.levels[this.shape.idx(x, y, z)];
  }

  /** Уровень 0..1 — то, чем модулируется рассеянный свет в шейдере. */
  factor(x: number, y: number, z: number): number {
    return this.at(x, y, z) / SKY_MAX;
  }

  /** Полный расчёт по всей форме. */
  bake(): void {
    this.levels.fill(0);
    this.seed(0, this.shape.sx, 0, this.shape.sz);
    this.spread();
  }

  /**
   * Пересчёт по коробке.
   *
   * Колонки считаются от самого верха формы: свет приходит сверху, и
   * знать, что творится над коробкой, обязательно. Растекание идёт с
   * запасом по краям — иначе на границе пересчитанной области остаётся
   * шов из старых значений.
   *
   * А вот вверх запас нужен маленький. Свет идёт сверху вниз: пробоина в
   * стене на высоте метра не меняет освещённость под крышей, и трогать
   * там нечего. Поэтому пересчитывается всё, что ниже изменений, плюс
   * пятнадцать вокселей над ними — ровно столько, сколько свет способен
   * пролезть вверх боковым растеканием.
   */
  rebuild(region: VoxelRegion): void {
    const m = SKY_MAX;
    const x0 = Math.max(0, region.x0 - m);
    const x1 = Math.min(this.shape.sx, region.x1 + m);
    const z0 = Math.max(0, region.z0 - m);
    const z1 = Math.min(this.shape.sz, region.z1 + m);
    const yTop = Math.min(this.shape.sy, region.y1 + m);

    // Обнуляем полосу до самого низа: свет из дыры в крыше падает
    // колонкой до пола, и «подправить на месте» его нельзя.
    for (let y = 0; y < yTop; y++) {
      for (let z = z0; z < z1; z++) {
        const row = (y * this.shape.sz + z) * this.shape.sx;
        this.levels.fill(0, row + x0, row + x1);
      }
    }

    this.seed(x0, x1, z0, z1, yTop);
    // Свет с краёв полосы затекает обратно внутрь: ставим их в очередь.
    this.seedBorder(x0, x1, z0, z1, yTop);
    this.spread();
  }

  /**
   * Источники света в полосе: колонки сверху и открытые грани формы.
   *
   * Одних колонок мало. Форма — не бесконечный мир, а коробка посреди
   * улицы: дыра в её боковой стенке смотрит наружу, где такое же небо.
   * Без этого застеклённый офис внутри чёрный, а через ворота склада не
   * видно ничего.
   */
  private seed(x0: number, x1: number, z0: number, z1: number, yTop = this.shape.sy): void {
    this.columns(x0, x1, z0, z1, yTop);

    const { sx, sz, data } = this.shape;
    const open = (x: number, y: number, z: number): void => {
      const i = (y * sz + z) * sx + x;
      if (this.levels[i] === SKY_MAX) return;
      if (!passes(data[i], this.transparent)) return;
      this.levels[i] = SKY_MAX;
      this.buckets[SKY_MAX].push(i);
    };

    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) open(x, 0, z);
    }
    for (let y = 0; y < yTop; y++) {
      for (let z = z0; z < z1; z++) {
        if (x0 === 0) open(0, y, z);
        if (x1 === sx) open(sx - 1, y, z);
      }
      for (let x = x0; x < x1; x++) {
        if (z0 === 0) open(x, y, 0);
        if (z1 === sz) open(x, y, sz - 1);
      }
    }
  }

  /** Колонки сверху вниз: небо светит, пока не упрётся в непрозрачное. */
  private columns(x0: number, x1: number, z0: number, z1: number, yTop: number): void {
    const { sx, sy, sz, data } = this.shape;
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        let level = SKY_MAX;
        for (let y = sy - 1; y >= 0; y--) {
          const i = (y * sz + z) * sx + x;
          if (level > 0 && !passes(data[i], this.transparent)) level = 0;
          if (level === 0) break;
          // Выше пересчитываемой полосы значения и так верные: свет туда
          // приходит из тех же колонок и не зависит от того, что внизу.
          if (y >= yTop) continue;
          this.levels[i] = level;
          if (level === SKY_MAX) this.buckets[level].push(i);
        }
      }
    }
  }

  /** Поставить в очередь всё, что уже светится по краям полосы. */
  private seedBorder(x0: number, x1: number, z0: number, z1: number, yTop: number): void {
    const { sx, sz } = this.shape;
    const push = (x: number, y: number, z: number): void => {
      if (x < 0 || z < 0 || x >= sx || z >= sz) return;
      const i = (y * sz + z) * sx + x;
      const l = this.levels[i];
      if (l > 1) this.buckets[l].push(i);
    };
    for (let y = 0; y < yTop; y++) {
      for (let z = z0 - 1; z <= z1; z++) {
        push(x0 - 1, y, z);
        push(x1, y, z);
      }
      for (let x = x0; x < x1; x++) {
        push(x, y, z0 - 1);
        push(x, y, z1);
      }
    }
    // Крышка полосы: свет сверху обязан затечь вниз, в обнулённое.
    if (yTop < this.shape.sy) {
      for (let z = z0; z < z1; z++) {
        for (let x = x0; x < x1; x++) push(x, yTop, z);
      }
    }
  }

  /**
   * Боковое растекание: от ярких клеток к соседним, теряя единицу на шаг.
   * Очереди по уровням вместо приоритетной: уровней всего шестнадцать,
   * и обход от яркого к тусклому даёт каждой клетке итоговое значение
   * с первого раза.
   */
  private spread(): void {
    const { sx, sy, sz, data } = this.shape;
    for (let level = SKY_MAX; level > 1; level--) {
      const queue = this.buckets[level];
      for (let q = 0; q < queue.length; q++) {
        const i = queue[q];
        // Значение могло вырасти, пока клетка ждала: тогда её обработает
        // очередь повыше, а эта запись — устаревшая.
        if (this.levels[i] !== level) continue;

        const x = i % sx;
        const t = (i - x) / sx;
        const z = t % sz;
        const y = (t - z) / sz;
        const next = level - FALLOFF;

        for (let k = 0; k < 6; k++) {
          const nx = x + NEIGHBOURS[k][0];
          const ny = y + NEIGHBOURS[k][1];
          const nz = z + NEIGHBOURS[k][2];
          if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
          const j = (ny * sz + nz) * sx + nx;
          if (this.levels[j] >= next) continue;
          if (!passes(data[j], this.transparent)) continue;
          this.levels[j] = next;
          if (next > 1) this.buckets[next].push(j);
        }
      }
      queue.length = 0;
    }
    for (const b of this.buckets) b.length = 0;
  }
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * Небесный свет всех форм мира.
 *
 * Держится отдельно от формы намеренно: это данные рендера, и ядру,
 * которое считает физику на сервере, они не нужны ни байтом.
 */
/** До этого объёма форму дешевле пересчитать целиком, чем полосой. */
export const FULL_REBAKE_VOLUME = 1 << 21;

export class SkyLightField {
  private fields = new WeakMap<VoxelShape, SkyLight>();
  private opts: SkyLightOptions;

  constructor(opts: SkyLightOptions = {}) {
    this.opts = opts;
  }

  /** Поле формы. Считается при первом обращении. */
  of(shape: VoxelShape): SkyLight {
    let field = this.fields.get(shape);
    if (!field) {
      field = new SkyLight(shape, this.opts);
      this.fields.set(shape, field);
    }
    return field;
  }

  /**
   * Пересчёт куска формы после разрушения.
   *
   * Мелкую форму дешевле пересчитать целиком: пересчёт полосы всё равно
   * тянет за собой всю высоту (свет из дыры в крыше падает до пола) плюс
   * запас по краям, и на форме в миллион вокселей это уже не экономия,
   * а лишний код в кадре.
   */
  rebuild(shape: VoxelShape, region: VoxelRegion): void {
    const field = this.fields.get(shape);
    // Формы, которую ещё ни разу не считали, и пересчитывать нечего:
    // первый же запрос посчитает её целиком и по свежим данным.
    if (!field) return;
    if (shape.volume <= FULL_REBAKE_VOLUME) field.bake();
    else field.rebuild(region);
  }

  forget(shape: VoxelShape): void {
    this.fields.delete(shape);
  }
}
