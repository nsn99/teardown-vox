import { Vec3, add, rotateVec, v3 } from './math.js';
import { MATERIALS, Mat, carriesLoad, material, voxelMass } from './materials.js';
import { CHUNK_SIZE, VoxelShape } from './voxel-shape.js';
import { Body } from './body.js';
import { VoxelWorld } from './world.js';

export interface StructureOptions {
  gravity?: number;
  /** Обломок мельче этого — пыль: удаляется, тело не создаётся. */
  minFragmentVoxels?: number;
  /** Больше этого числа обломков за шаг не отделяем — остальное в следующий кадр. */
  maxFragmentsPerStep?: number;
  /**
   * Глобальный множитель нагрузки. 1 — «инженерный» баланс из таблицы
   * материалов; выше — здания рушатся охотнее.
   */
  loadScale?: number;
  /** Считать напряжения (дорого). Для чисто связностной проверки — false. */
  stress?: boolean;
  /**
   * Считать связность инкрементально — от изменившихся вокселей, а не по
   * всей форме. Результат тот же; выключается для сверки в тестах.
   */
  incremental?: boolean;
  /** Предел обхода при инкрементальном поиске якоря. Выше — полный проход. */
  incrementalVisitLimit?: number;
  /**
   * Потолок времени на проход, мс. Кончился — оставшиеся тела и чанки
   * ждут следующего прохода. Ноль означает «без потолка».
   */
  timeBudgetMs?: number;
}

export interface FragmentInfo {
  body: Body;
  voxels: number;
  mass: number;
  center: Vec3;
}

export interface StructureResult {
  fragments: FragmentInfo[];
  /** Вокселей ушло в обломки. */
  detachedVoxels: number;
  /** Вокселей рассыпалось в пыль (слишком мелкие островки). */
  dustVoxels: number;
  /** Вокселей разрушено превышением напряжения/момента. */
  stressFailures: number;
}

const DEFAULTS = {
  gravity: 9.81,
  minFragmentVoxels: 4,
  maxFragmentsPerStep: 64,
  loadScale: 1,
  stress: true,
  incremental: true,
  incrementalVisitLimit: 20000,
  timeBudgetMs: 6,
} satisfies Required<StructureOptions>;

/**
 * Признак якоря: воксель либо сам из якорного материала (фундамент, скала,
 * грунт), либо лежит в нижнем слое формы, помеченной как стоящая на земле.
 */
export function isAnchorVoxel(shape: VoxelShape, x: number, y: number, z: number): boolean {
  const mat = shape.data[shape.idx(x, y, z)];
  if (mat === Mat.Air) return false;
  if (material(mat).anchor) return true;
  return shape.grounded && y === 0;
}

/**
 * Флад-филл связности от якорей. Возвращает битовую маску «держится за землю».
 * 6-связность: диагональный контакт углом не считается опорой — так
 * подпиленная колонна действительно отпускает крышу.
 */
export function computeAnchored(shape: VoxelShape): Uint8Array {
  const n = shape.data.length;
  const anchored = new Uint8Array(n);
  const stack: number[] = [];
  const { sx, sy, sz } = shape;

  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        if (isAnchorVoxel(shape, x, y, z)) {
          const i = shape.idx(x, y, z);
          if (!anchored[i]) {
            anchored[i] = 1;
            stack.push(i);
          }
        }
      }
    }
  }

  const c = { x: 0, y: 0, z: 0 };
  while (stack.length > 0) {
    const i = stack.pop()!;
    shape.coords(i, c);
    for (let k = 0; k < 6; k++) {
      const nx = c.x + NEIGHBORS[k][0];
      const ny = c.y + NEIGHBORS[k][1];
      const nz = c.z + NEIGHBORS[k][2];
      if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
      const j = shape.idx(nx, ny, nz);
      if (anchored[j]) continue;
      if (shape.data[j] === Mat.Air) continue;
      anchored[j] = 1;
      stack.push(j);
    }
  }
  return anchored;
}

const NEIGHBORS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** Связные компоненты среди неякорных вокселей. Каждая — будущий обломок. */
export function findLooseComponents(shape: VoxelShape, anchored: Uint8Array): number[][] {
  const n = shape.data.length;
  const seen = new Uint8Array(n);
  const components: number[][] = [];
  const c = { x: 0, y: 0, z: 0 };
  const { sx, sy, sz } = shape;

  for (let start = 0; start < n; start++) {
    if (seen[start] || anchored[start] || shape.data[start] === Mat.Air) continue;
    const comp: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const i = stack.pop()!;
      comp.push(i);
      shape.coords(i, c);
      for (let k = 0; k < 6; k++) {
        const nx = c.x + NEIGHBORS[k][0];
        const ny = c.y + NEIGHBORS[k][1];
        const nz = c.z + NEIGHBORS[k][2];
        if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
        const j = shape.idx(nx, ny, nz);
        if (seen[j] || anchored[j] || shape.data[j] === Mat.Air) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    components.push(comp);
  }
  return components;
}

/**
 * Инкрементальная связность: обход только от изменившихся вокселей.
 *
 * Удаление вокселя способно оторвать от земли лишь то, что было с ним
 * рядом, — поэтому вместо флуда по всей форме идём от соседей изменённых
 * клеток по связному куску, пока не упрёмся в якорь. Нашли якорь — весь
 * кусок держится, и обходить его до конца незачем: связность транзитивна.
 * Обошли кусок целиком и якоря нет — вот и обломок.
 *
 * Возвращает null, если обход вышел за лимит: тогда полный проход дешевле.
 */
export function looseComponentsIncremental(
  shape: VoxelShape,
  changed: readonly number[],
  visitLimit: number = DEFAULTS.incrementalVisitLimit,
): number[][] | null {
  const { sx, sy, sz } = shape;
  const data = shape.data;
  const resolved = new Set<number>();
  const out: number[][] = [];
  const c = { x: 0, y: 0, z: 0 };
  let budget = visitLimit;

  // Стартовые точки: сама изменённая клетка, если она твёрдая (поставили
  // доску — она может висеть в воздухе), иначе её твёрдые соседи.
  const seeds: number[] = [];
  for (const idx of changed) {
    if (idx < 0 || idx >= data.length) continue;
    if (data[idx] !== Mat.Air) {
      seeds.push(idx);
      continue;
    }
    shape.coords(idx, c);
    for (let k = 0; k < 6; k++) {
      const nx = c.x + NEIGHBORS[k][0];
      const ny = c.y + NEIGHBORS[k][1];
      const nz = c.z + NEIGHBORS[k][2];
      if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
      const j = shape.idx(nx, ny, nz);
      if (data[j] !== Mat.Air) seeds.push(j);
    }
  }

  for (const seed of seeds) {
    if (resolved.has(seed) || data[seed] === Mat.Air) continue;

    const comp: number[] = [];
    const seen = new Set<number>([seed]);
    const stack = [seed];
    let anchored = false;

    while (stack.length > 0) {
      if (--budget < 0) return null;
      const i = stack.pop()!;
      shape.coords(i, c);
      if (isAnchorVoxel(shape, c.x, c.y, c.z)) {
        anchored = true;
        break;
      }
      comp.push(i);
      for (let k = 0; k < 6; k++) {
        const nx = c.x + NEIGHBORS[k][0];
        const ny = c.y + NEIGHBORS[k][1];
        const nz = c.z + NEIGHBORS[k][2];
        if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
        const j = shape.idx(nx, ny, nz);
        if (data[j] === Mat.Air || seen.has(j)) continue;
        seen.add(j);
        stack.push(j);
      }
    }

    if (anchored) {
      // Всё пройденное висит на найденном якоре — перепроверять нечего.
      for (const i of seen) resolved.add(i);
    } else {
      for (const i of comp) resolved.add(i);
      if (comp.length > 0) out.push(comp);
    }
  }

  return out;
}

export interface StressField {
  /** Нагрузка на воксель, Н. */
  load: Float32Array;
  /** Изгибающий момент в вокселе, Н·м. */
  moment: Float32Array;
  /** Индексы вокселей, не выдержавших нагрузку. */
  failures: number[];
}

/**
 * Пересчитываемый кусок формы: столбцы по x и z целиком по высоте до слоя
 * yTop включительно. Нагрузка течёт вниз, поэтому выше yTop ничего не
 * меняется, а вбок расходится недалеко — отсюда и запас по краям.
 */
export interface StressRegion {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Верхний пересчитываемый слой, включительно. */
  yTop: number;
}

interface StressCache {
  load: Float32Array;
  moment: Float32Array;
  /** Полный проход по форме уже был: частичный имеет смысл только поверх. */
  full: boolean;
}

// Поля нагрузок живут вместе с формой: частичный пересчёт обновляет кусок,
// остальное остаётся с прошлого полного прохода. Заодно исчезает по
// двадцать мегабайт аллокаций на каждый удар по складу.
const stressCache = new WeakMap<VoxelShape, StressCache>();

/** Был ли по форме полный проход — без него частичному не на что опереться. */
export function stressCacheReady(shape: VoxelShape): boolean {
  return stressCache.get(shape)?.full === true;
}

/** Только для тестов: забыть накопленные поля нагрузок. */
export function __clearStressCache(shape: VoxelShape): void {
  stressCache.delete(shape);
}

/**
 * Расчёт нагрузок сверху вниз.
 *
 * Модель из двух частей:
 *  1. Вертикальная передача: воксель отдаёт свой вес и всё, что накопил,
 *     опорам снизу (прямо под собой, а если там пусто — по диагоналям).
 *  2. Латеральная передача для консолей: воксель без опоры снизу гонит
 *     нагрузку вбок по слою в сторону ближайшей опоры, и на каждом шаге
 *     копится изгибающий момент (нагрузка × плечо). Именно поэтому
 *     деревянный балкон длиной в метр отламывается, а стальная ферма — нет.
 *
 * Разрушение наступает по превышению либо сжатия load/площадь > maxStress,
 * либо момента moment > maxMoment.
 */
export function computeStress(
  shape: VoxelShape,
  opts: StructureOptions = {},
  region?: StressRegion,
): StressField {
  const cfg = { ...DEFAULTS, ...opts };
  const { sx, sy, sz } = shape;
  const n = shape.data.length;
  const data = shape.data;
  const s = shape.voxelSize;
  const area = s * s;
  const voxelVolume = s * s * s;
  const g = cfg.gravity * cfg.loadScale;

  let cache = stressCache.get(shape);
  if (!cache || cache.load.length !== n) {
    cache = { load: new Float32Array(n), moment: new Float32Array(n), full: false };
    stressCache.set(shape, cache);
  }
  // Частичный проход имеет смысл только поверх полного: иначе снаружи
  // куска лежит не «старое верное», а просто ноль.
  const partial = region !== undefined && cache.full;
  const load = cache.load;
  const moment = cache.moment;
  const failures: number[] = [];

  const x0 = partial ? Math.max(0, region!.x0) : 0;
  const x1 = partial ? Math.min(sx, region!.x1) : sx;
  const z0 = partial ? Math.max(0, region!.z0) : 0;
  const z1 = partial ? Math.min(sz, region!.z1) : sz;
  const yTop = partial ? Math.max(0, Math.min(sy - 1, region!.yTop)) : sy - 1;
  if (x1 <= x0 || z1 <= z0) return { load, moment, failures };

  const layerStride = sz * sx;
  const below4 = new Int32Array(4);
  const layerIdx: number[] = [];
  const dist = new Int32Array(sx * sz);
  const comp = new Int32Array(sx * sz);
  const supported = new Uint8Array(sx * sz);
  const queue = new Int32Array(sx * sz);
  // Вместо трёх fill() на каждый слой — штамп поколения. На складе в
  // восемьдесят слоёв это заметная доля всей работы функции.
  const distStamp = new Int32Array(sx * sz);
  const compStamp = new Int32Array(sx * sz);

  // --- Сброс пересчитываемого куска в собственный вес ---
  // Пустые строки перешагиваем: в полой коробке склада их большинство,
  // а воздух всё равно никто не читает — все потребители сначала
  // смотрят на материал.
  for (let y = 0; y <= yTop; y++) {
    if (shape.solidInLayer(y) === 0) continue;
    for (let z = z0; z < z1; z++) {
      if (shape.solidInRow(y, z) === 0) continue;
      const rowBase = (y * sz + z) * sx;
      for (let x = x0; x < x1; x++) {
        const i = rowBase + x;
        const mat = data[i];
        if (MAT_LOAD_BEARING[mat] === 0) continue;
        load[i] = MAT_DENSITY[mat] * voxelVolume * g;
        moment[i] = 0;
      }
    }
  }

  // --- Затравка сверху ---
  // Слой над куском не менялся, но его нагрузку надо занести внутрь:
  // без этого крыша перестала бы давить на то, что мы пересчитываем.
  if (partial && yTop + 1 < sy) {
    const y = yTop + 1;
    for (let z = z0; z < z1; z++) {
      if (shape.solidInRow(y, z) === 0) continue;
      const rowBase = (y * sz + z) * sx;
      for (let x = x0; x < x1; x++) {
        const i = rowBase + x;
        const mat = data[i];
        if (MAT_LOAD_BEARING[mat] === 0) continue;
        if (!supportedAt(data, sx, sz, layerStride, x, y, z, i)) continue;
        const cnt = supportersBelow(data, sx, sz, layerStride, x, z, i, below4);
        if (cnt === 0) continue;
        const share = load[i] / cnt;
        for (let k = 0; k < cnt; k++) {
          const b = below4[k];
          // Наружу куска не пишем: там значения верны с прошлого полного
          // прохода, и добавка к ним была бы двойным счётом.
          if (inSlab(b, sx, sz, x0, x1, z0, z1)) load[b] += share;
        }
      }
    }
  }

  for (let y = yTop; y >= 0; y--) {
    // Пустой слой считать нечего — а в воксельной карте их большинство.
    if (shape.solidInLayer(y) === 0) continue;

    const gen = y + 1;
    // --- Фаза 1: кто в этом слое опирается на что-то снизу ---
    layerIdx.length = 0;
    let head = 0;
    let tail = 0;

    for (let z = z0; z < z1; z++) {
      if (shape.solidInRow(y, z) === 0) continue;
      // Индексы считаем сдвигом от базы строки: idx() на каждую клетку
      // слоя — это лишний умножитель на миллионы итераций.
      const rowBase = (y * sz + z) * sx;
      const cellBase = z * sx;
      for (let x = x0; x < x1; x++) {
        const i = rowBase + x;
        const mat = data[i];
        if (MAT_LOAD_BEARING[mat] === 0) continue;
        const cell = cellBase + x;
        layerIdx.push(cell);
        distStamp[cell] = gen;
        dist[cell] = -1;
        supported[cell] = 0;

        const sup = supportedAt(data, sx, sz, layerStride, x, y, z, i);
        if (sup) {
          supported[cell] = 1;
          dist[cell] = 0;
          queue[tail++] = cell;
        }
      }
    }

    // --- Фаза 2: расстояние по слою до ближайшей опоры ---
    while (head < tail) {
      const cell = queue[head++];
      const cx = cell % sx;
      const cz = (cell - cx) / sx;
      const d = dist[cell];
      for (let k = 0; k < 4; k++) {
        const nx = cx + LATERAL[k][0];
        const nz = cz + LATERAL[k][1];
        if (nx < x0 || nz < z0 || nx >= x1 || nz >= z1) continue;
        const ncell = nz * sx + nx;
        if (MAT_LOAD_BEARING[data[(y * sz + nz) * sx + nx]] === 0) continue;
        if (distStamp[ncell] === gen && dist[ncell] >= 0) continue;
        distStamp[ncell] = gen;
        dist[ncell] = d + 1;
        queue[tail++] = ncell;
      }
    }

    // --- Фаза 3: связные куски слоя и честное распределение по опорам ---
    //
    // Наивный вариант — гнать нагрузку по дереву BFS от дальней клетки к
    // ближней — на плите даёт воронку: половина крыши стекается в один
    // воксель у стены, и здание разваливается от собственного веса.
    // Плита так себя не ведёт: висящая часть опирается на ВСЕ опоры
    // своего куска сразу, а плечо считается средним по висящей площади.
    let compCount = 0;
    for (const start of layerIdx) {
      if (compStamp[start] === gen) continue;
      const id = compCount++;
      head = 0;
      tail = 0;
      queue[tail++] = start;
      compStamp[start] = gen;
      comp[start] = id;
      let roots = 0;
      let hangLoad = 0;
      let hangCount = 0;
      let distSum = 0;
      let neck = 0;
      let cutByEdge = false;
      const members: number[] = [];

      while (head < tail) {
        const cell = queue[head++];
        members.push(cell);
        const cx = cell % sx;
        const cz = (cell - cx) / sx;
        if (partial && !cutByEdge) {
          // Кусок продолжается за границей пересчитываемой области —
          // значит его настоящие опоры мы не видим.
          const ci = (y * sz + cz) * sx + cx;
          if (
            (cx === x0 && x0 > 0 && loadBearing(data[ci - 1])) ||
            (cx === x1 - 1 && x1 < sx && loadBearing(data[ci + 1])) ||
            (cz === z0 && z0 > 0 && loadBearing(data[ci - sx])) ||
            (cz === z1 - 1 && z1 < sz && loadBearing(data[ci + sx]))
          ) {
            cutByEdge = true;
          }
        }
        if (supported[cell]) {
          roots++;
        } else {
          const i = (y * sz + cz) * sx + cx;
          hangLoad += load[i];
          hangCount++;
          distSum += Math.max(1, dist[cell]);
          if (dist[cell] === 1) neck++;
        }
        for (let k = 0; k < 4; k++) {
          const nx = cx + LATERAL[k][0];
          const nz = cz + LATERAL[k][1];
          if (nx < x0 || nz < z0 || nx >= x1 || nz >= z1) continue;
          const ncell = nz * sx + nx;
          if (compStamp[ncell] === gen) continue;
          if (MAT_LOAD_BEARING[data[(y * sz + nz) * sx + nx]] === 0) continue;
          compStamp[ncell] = gen;
          comp[ncell] = id;
          queue[tail++] = ncell;
        }
      }

      // Ни одной опоры — держать нечему, этим займётся связность.
      if (roots === 0 || hangCount === 0) continue;
      // Обрезанный кусок не перераспределяем вовсе. Свалить его вес на
      // те опоры, что попали в область, — верный способ выдумать обвал:
      // на деле висящая часть держится и на опорах снаружи. Недобор
      // безопасен, перебор — нет.
      if (cutByEdge) continue;

      const share = hangLoad / roots;
      const lever = (distSum / hangCount) * s;
      // Изгиб ломает не опору, а корневое сечение самой консоли —
      // балка отламывается у стены, а не выламывает кусок стены.
      // Корень — это висящие клетки на расстоянии 1 от опоры.
      const neckShare = neck > 0 ? hangLoad / neck : 0;

      for (const cell of members) {
        const cx = cell % sx;
        const cz = (cell - cx) / sx;
        const i = (y * sz + cz) * sx + cx;
        if (supported[cell]) {
          load[i] += share;
          if (neck === 0) moment[i] += share * lever;
        } else {
          if (dist[cell] === 1) moment[i] += neckShare * lever;
          // Нагрузка ушла на опоры, дважды её считать нельзя.
          load[i] = 0;
        }
      }
    }

    // --- Фаза 4: опёртые передают нагрузку вниз ---
    if (y > 0) {
      for (const cell of layerIdx) {
        if (!supported[cell]) continue;
        const cx = cell % sx;
        const cz = (cell - cx) / sx;
        const i = (y * sz + cz) * sx + cx;
        const cnt = supportersBelow(data, sx, sz, layerStride, cx, cz, i, below4);
        if (cnt === 0) continue;
        const share = load[i] / cnt;
        for (let k = 0; k < cnt; k++) {
          const b = below4[k];
          if (!partial || inSlab(b, sx, sz, x0, x1, z0, z1)) load[b] += share;
        }
      }
    }
  }

  // --- Проверка предельных состояний ---
  for (let y = 0; y <= yTop; y++) {
    if (shape.solidInLayer(y) === 0) continue;
    for (let z = z0; z < z1; z++) {
      if (shape.solidInRow(y, z) === 0) continue;
      const rowBase = (y * sz + z) * sx;
      for (let x = x0; x < x1; x++) {
        const i = rowBase + x;
        const mat = data[i];
        if (MAT_LOAD_BEARING[mat] === 0 || MAT_INDESTRUCTIBLE[mat] === 1) continue;
        if (load[i] / area > MAT_MAX_STRESS[mat] || moment[i] > MAT_MAX_MOMENT[mat]) {
          failures.push(i);
        }
      }
    }
  }

  if (!partial) cache.full = true;
  return { load, moment, failures };
}

const LATERAL: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function hasSupportBelow(shape: VoxelShape, x: number, y: number, z: number): boolean {
  if (y === 0) return true;
  return collectSupportersBelow(shape, x, y, z).length > 0;
}

/**
 * Свойства материалов, разложенные по типизированным массивам.
 *
 * В горячем цикле важен не столько сам поиск, сколько то, что обращение к
 * импортированной функции — это загрузка свойства из объекта модуля на
 * каждый воксель. На двух с половиной миллионах клеток разница выходит
 * в порядок, поэтому таблицы строятся один раз при загрузке.
 */
const MAT_COUNT = MATERIALS.length;
const MAT_LOAD_BEARING = new Uint8Array(MAT_COUNT);
const MAT_INDESTRUCTIBLE = new Uint8Array(MAT_COUNT);
const MAT_MAX_STRESS = new Float64Array(MAT_COUNT);
const MAT_MAX_MOMENT = new Float64Array(MAT_COUNT);
const MAT_DENSITY = new Float64Array(MAT_COUNT);
for (let id = 0; id < MAT_COUNT; id++) {
  const def = MATERIALS[id];
  MAT_LOAD_BEARING[id] = id !== Mat.Air && carriesLoad(id) ? 1 : 0;
  MAT_INDESTRUCTIBLE[id] = def.indestructible ? 1 : 0;
  MAT_MAX_STRESS[id] = def.maxStress;
  MAT_MAX_MOMENT[id] = def.maxMoment;
  MAT_DENSITY[id] = def.density;
}

const loadBearing = (mat: number): boolean => MAT_LOAD_BEARING[mat] === 1;

/**
 * Опирается ли клетка на что-то в слое ниже: прямо под собой или по
 * диагонали. Функция модульная, а не замыкание внутри computeStress:
 * замыкание утаскивает локальные переменные горячего цикла в контекст,
 * и цикл тормозит впятеро — это было видно в профиле.
 */
function supportedAt(
  data: Uint8Array,
  sx: number,
  sz: number,
  layerStride: number,
  x: number,
  y: number,
  z: number,
  index: number,
): boolean {
  if (y === 0) return true;
  const belowBase = index - layerStride;
  if (loadBearing(data[belowBase])) return true;
  if (x > 0 && loadBearing(data[belowBase - 1])) return true;
  if (x + 1 < sx && loadBearing(data[belowBase + 1])) return true;
  if (z > 0 && loadBearing(data[belowBase - sx])) return true;
  if (z + 1 < sz && loadBearing(data[belowBase + sx])) return true;
  return false;
}

/** Внутри ли клетка пересчитываемого куска — по столбцу x/z. */
function inSlab(
  index: number,
  sx: number,
  sz: number,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
): boolean {
  const x = index % sx;
  const z = ((index - x) / sx) % sz;
  return x >= x0 && x < x1 && z >= z0 && z < z1;
}

/**
 * То же, что collectSupportersBelow, но пишет в готовый буфер и работает
 * с сырыми индексами: в фазе 4 эта функция зовётся на каждый опёртый
 * воксель, и массив на каждый вызов там был заметен в профиле.
 */
function supportersBelow(
  data: Uint8Array,
  sx: number,
  sz: number,
  layerStride: number,
  x: number,
  z: number,
  index: number,
  out: Int32Array,
): number {
  const belowBase = index - layerStride;
  const direct = data[belowBase];
  if (loadBearing(direct)) {
    out[0] = belowBase;
    return 1;
  }
  let n = 0;
  if (x > 0 && loadBearing(data[belowBase - 1])) out[n++] = belowBase - 1;
  if (x + 1 < sx && loadBearing(data[belowBase + 1])) out[n++] = belowBase + 1;
  if (z > 0 && loadBearing(data[belowBase - sx])) out[n++] = belowBase - sx;
  if (z + 1 < sz && loadBearing(data[belowBase + sx])) out[n++] = belowBase + sx;
  return n;
}

/** Опоры под вокселем: сначала прямо под ним, иначе четыре диагонали. */
function collectSupportersBelow(shape: VoxelShape, x: number, y: number, z: number): number[] {
  if (y === 0) return [];
  const direct = shape.idx(x, y - 1, z);
  const dm = shape.data[direct];
  if (dm !== Mat.Air && carriesLoad(dm)) return [direct];
  const out: number[] = [];
  for (const [dx, dz] of LATERAL) {
    const nx = x + dx;
    const nz = z + dz;
    if (nx < 0 || nz < 0 || nx >= shape.sx || nz >= shape.sz) continue;
    const j = shape.idx(nx, y - 1, nz);
    const m = shape.data[j];
    if (m !== Mat.Air && carriesLoad(m)) out.push(j);
  }
  return out;
}

/**
 * Мельче этого объёма форму считаем целиком: частичный проход по кубику
 * 32³ не окупает возни с границами.
 */
const PARTIAL_STRESS_MIN_VOLUME = 1 << 19;
/**
 * Запас вокруг задетых чанков. Нагрузка с повисшего куска расходится по
 * слою до ближайших опор, и почти всегда они рядом; а кусок, который
 * границу всё-таки задел, не перераспределяется вовсе — см. cutByEdge.
 * Поэтому запас держим скромным: он входит в сторону области квадратом.
 */
const PARTIAL_STRESS_MARGIN = CHUNK_SIZE / 4;
/** Разросся кусок больше этой доли формы — частичный проход не выгоден. */
const PARTIAL_STRESS_MAX_FRACTION = 0.4;
/**
 * Потолок стороны куска в вокселях. Без него два далёких чанка дают
 * кусок во всю ширину склада: по площади он ещё проходит, а считается
 * как половина формы.
 */
const PARTIAL_STRESS_MAX_SPAN = 3 * CHUNK_SIZE;

export interface PartialStressPlan {
  region: StressRegion;
  /** Чанки, которые этот проход закрывает. */
  chunks: number[];
}

/**
 * Кусок для частичного пересчёта напряжений по грязным чанкам формы.
 *
 * Чанки берутся не все сразу: кусок растёт, пока укладывается в потолок,
 * и на этом проход останавливается. Остальные чанки остаются грязными и
 * достанутся следующему проходу — так один большой взрыв растекается по
 * нескольким кадрам вместо одного провала на четверть секунды.
 *
 * undefined — считать всю форму целиком.
 */
export function partialStressPlan(shape: VoxelShape): PartialStressPlan | undefined {
  if (shape.volume < PARTIAL_STRESS_MIN_VOLUME) return undefined;
  if (!stressCacheReady(shape)) return undefined;
  const dirty = shape.dirtyStructureChunks;
  if (dirty.size === 0) return undefined;

  const budget = shape.sx * shape.sz * PARTIAL_STRESS_MAX_FRACTION;
  const taken: number[] = [];
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  let yMax = -Infinity;

  for (const c of dirty) {
    const b = shape.chunkBounds(c);
    const nx0 = Math.min(x0, b.x0);
    const nz0 = Math.min(z0, b.z0);
    const nx1 = Math.max(x1, b.x1);
    const nz1 = Math.max(z1, b.z1);
    const spanX =
      Math.min(shape.sx, nx1 + PARTIAL_STRESS_MARGIN) - Math.max(0, nx0 - PARTIAL_STRESS_MARGIN);
    const spanZ =
      Math.min(shape.sz, nz1 + PARTIAL_STRESS_MARGIN) - Math.max(0, nz0 - PARTIAL_STRESS_MARGIN);
    // Первый чанк берём всегда: иначе проход не сдвинется с места.
    if (
      taken.length > 0 &&
      (spanX * spanZ > budget ||
        spanX > PARTIAL_STRESS_MAX_SPAN ||
        spanZ > PARTIAL_STRESS_MAX_SPAN)
    ) {
      continue;
    }
    x0 = nx0;
    z0 = nz0;
    x1 = nx1;
    z1 = nz1;
    if (b.y1 > yMax) yMax = b.y1;
    taken.push(c);
  }

  const rx0 = Math.max(0, x0 - PARTIAL_STRESS_MARGIN);
  const rx1 = Math.min(shape.sx, x1 + PARTIAL_STRESS_MARGIN);
  const rz0 = Math.max(0, z0 - PARTIAL_STRESS_MARGIN);
  const rz1 = Math.min(shape.sz, z1 + PARTIAL_STRESS_MARGIN);
  if ((rx1 - rx0) * (rz1 - rz0) > budget) return undefined;

  // Верхний слой — на один выше задетого: клетка над дырой теряет опору,
  // и её нагрузка тоже перераспределяется. Выше уже ничего не меняется,
  // нагрузка течёт вниз.
  return {
    region: { x0: rx0, x1: rx1, z0: rz0, z1: rz1, yTop: Math.min(shape.sy - 1, yMax) },
    chunks: taken,
  };
}

/**
 * Вырезает компоненту из формы в отдельное динамическое тело.
 * Новая форма получает трансформ так, чтобы обломок остался ровно там,
 * где был, — визуально ничего не «прыгает» в кадре отделения.
 */
export function extractFragment(
  sourceBody: Body,
  sourceShape: VoxelShape,
  voxels: number[],
): { body: Body; mass: number; center: Vec3 } {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const c = { x: 0, y: 0, z: 0 };
  for (const i of voxels) {
    sourceShape.coords(i, c);
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.z < minZ) minZ = c.z;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
    if (c.z > maxZ) maxZ = c.z;
  }

  const s = sourceShape.voxelSize;
  const offset = v3(minX * s, minY * s, minZ * s);
  const fragShape = new VoxelShape({
    sx: maxX - minX + 1,
    sy: maxY - minY + 1,
    sz: maxZ - minZ + 1,
    voxelSize: s,
    transform: {
      position: add(
        sourceShape.transform.position,
        rotateVec(sourceShape.transform.rotation, offset),
      ),
      rotation: { ...sourceShape.transform.rotation },
    },
    grounded: false,
    name: `${sourceShape.name}:frag`,
  });

  for (const i of voxels) {
    sourceShape.coords(i, c);
    const mat = sourceShape.data[i];
    fragShape.set(c.x - minX, c.y - minY, c.z - minZ, mat);
    const paintColor = sourceShape.paint.get(i);
    if (paintColor !== undefined) {
      fragShape.paint.set(fragShape.idx(c.x - minX, c.y - minY, c.z - minZ), paintColor);
    }
    sourceShape.setAt(i, Mat.Air);
  }

  const body = new Body({
    kind: 'dynamic',
    transform: {
      position: { ...sourceBody.transform.position },
      rotation: { ...sourceBody.transform.rotation },
    },
    shapes: [fragShape],
    name: `${sourceBody.name}:frag`,
    // Метка обломка нужна потолку числа активных тел: замораживать
    // разрешено только то, что отвалилось, а не технику и не цели.
    tags: [...sourceBody.tags].filter((t) => t !== 'level').concat('debris'),
  });
  body.velocity = { ...sourceBody.velocity };
  body.angularVelocity = { ...sourceBody.angularVelocity };

  const com = fragShape.centerOfMass();
  const worldCenter = add(
    body.transform.position,
    rotateVec(
      body.transform.rotation,
      add(fragShape.transform.position, rotateVec(fragShape.transform.rotation, com)),
    ),
  );

  return { body, mass: fragShape.mass(), center: worldCenter };
}

/**
 * Полный проход структурной целостности по телу.
 * Возвращает отделившиеся обломки; вызывающий добавляет их в мир.
 */
export function solveBodyStructure(
  body: Body,
  opts: StructureOptions = {},
): StructureResult {
  const cfg = { ...DEFAULTS, ...opts };
  const result: StructureResult = {
    fragments: [],
    detachedVoxels: 0,
    dustVoxels: 0,
    stressFailures: 0,
  };

  for (const shape of body.shapes) {
    if (shape.solidVoxels === 0) continue;
    if (!shape.structural) {
      shape.clearStructureDirty();
      shape.takeStructureChanges();
      continue;
    }
    // Чистую форму пересчитывать незачем: её данные не менялись, а прошлый
    // проход уже сказал, что она стоит. Без этой проверки удар по складу
    // тянул за собой полный пересчёт грунта — пять миллионов клеток на
    // каждый чих.
    if (!shape.structureDirty) continue;

    if (cfg.stress) {
      const plan = cfg.incremental ? partialStressPlan(shape) : undefined;
      const { failures } = computeStress(shape, cfg, plan?.region);
      // Разбор грязи до правок: то, что разрушат сами напряжения, должно
      // попасть в следующий проход, а не потеряться вместе с чанками.
      if (plan) shape.consumeStructureChunks(plan.chunks);
      else shape.clearStructureDirty();
      for (const i of failures) shape.setAt(i, Mat.Air);
      result.stressFailures += failures.length;
    } else {
      shape.clearStructureDirty();
    }

    // Изменения снимаем после напряжений: то, что раскрошилось от них,
    // тоже могло что-то оторвать.
    const changes = shape.takeStructureChanges();

    // Инкрементальный проход имеет право работать только поверх формы,
    // которую хоть раз просмотрели целиком: он ищет оторвавшееся от
    // изменений, а в только что загруженной карте висеть может что угодно.
    let loose: number[][] | null = null;
    if (cfg.incremental && shape.structureScanned && !changes.overflow) {
      loose = looseComponentsIncremental(shape, changes.indices, cfg.incrementalVisitLimit);
    }
    if (loose === null) {
      const anchored = computeAnchored(shape);
      loose = findLooseComponents(shape, anchored);
      shape.structureScanned = true;
    }
    if (loose.length === 0) continue;

    // Крупные обломки — вперёд: они интереснее визуально.
    loose.sort((a, b) => b.length - a.length);

    let spawned = 0;
    for (const comp of loose) {
      if (comp.length < cfg.minFragmentVoxels || spawned >= cfg.maxFragmentsPerStep) {
        for (const i of comp) shape.setAt(i, Mat.Air);
        result.dustVoxels += comp.length;
        continue;
      }
      const frag = extractFragment(body, shape, comp);
      result.fragments.push({
        body: frag.body,
        voxels: comp.length,
        mass: frag.mass,
        center: frag.center,
      });
      result.detachedVoxels += comp.length;
      spawned++;
    }
  }

  shapeCleanup(body);
  return result;
}

function shapeCleanup(body: Body): void {
  body.shapes = body.shapes.filter((s) => s.solidVoxels > 0);
  body.collidersDirty = true;
}

/**
 * Прогоняет структурный анализ по всем телам мира, у которых накопилась
 * грязная область. Обломки сразу добавляются в мир, и, если после отделения
 * они сами распались, следующий шаг доберёт остаток.
 */
export function stepStructure(
  world: VoxelWorld,
  opts: StructureOptions = {},
): StructureResult {
  const total: StructureResult = {
    fragments: [],
    detachedVoxels: 0,
    dustVoxels: 0,
    stressFailures: 0,
  };

  const cfg = { ...DEFAULTS, ...opts };
  const started = cfg.timeBudgetMs > 0 ? performance.now() : 0;

  for (const body of [...world.bodies.values()]) {
    if (body.destroyed || body.passive) continue;
    // Динамические обломки в Teardown уже жёсткие: их не пересчитываем.
    if (body.kind !== 'static') continue;
    const dirty = body.shapes.some((s) => s.structureDirty);
    if (!dirty) continue;
    // Кончилось время — остальные тела досчитаем в следующем проходе.
    // Их чанки остаются грязными, ничего не теряется.
    if (cfg.timeBudgetMs > 0 && performance.now() - started > cfg.timeBudgetMs) break;

    const res = solveBodyStructure(body, opts);

    for (const f of res.fragments) {
      world.addBody(f.body);
      total.fragments.push(f);
    }
    total.detachedVoxels += res.detachedVoxels;
    total.dustVoxels += res.dustVoxels;
    total.stressFailures += res.stressFailures;

    if (res.fragments.length > 0) {
      world.events.emit('body:split', {
        source: body,
        fragments: res.fragments.map((f) => f.body),
        reason: res.stressFailures > 0 ? 'stress' : 'disconnected',
      });
    }
  }

  world.collectGarbage();
  return total;
}
