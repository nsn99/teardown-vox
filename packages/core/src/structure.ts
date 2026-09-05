import { Vec3, add, rotateVec, v3 } from './math.js';
import { Mat, carriesLoad, material, voxelMass } from './materials.js';
import { VoxelShape } from './voxel-shape.js';
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

export interface StressField {
  /** Нагрузка на воксель, Н. */
  load: Float32Array;
  /** Изгибающий момент в вокселе, Н·м. */
  moment: Float32Array;
  /** Индексы вокселей, не выдержавших нагрузку. */
  failures: number[];
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
export function computeStress(shape: VoxelShape, opts: StructureOptions = {}): StressField {
  const cfg = { ...DEFAULTS, ...opts };
  const { sx, sy, sz } = shape;
  const n = shape.data.length;
  const load = new Float32Array(n);
  const moment = new Float32Array(n);
  const failures: number[] = [];
  const s = shape.voxelSize;
  const area = s * s;
  const g = cfg.gravity * cfg.loadScale;

  // Собственный вес.
  for (let i = 0; i < n; i++) {
    const mat = shape.data[i];
    if (mat === Mat.Air || !carriesLoad(mat)) continue;
    load[i] = voxelMass(mat, s) * g;
  }

  const layerIdx: number[] = [];
  const dist = new Int32Array(sx * sz);
  const comp = new Int32Array(sx * sz);
  const supported = new Uint8Array(sx * sz);
  const queue = new Int32Array(sx * sz);

  for (let y = sy - 1; y >= 0; y--) {
    // --- Фаза 1: кто в этом слое опирается на что-то снизу ---
    dist.fill(-1);
    comp.fill(-1);
    supported.fill(0);
    layerIdx.length = 0;
    let head = 0;
    let tail = 0;

    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const i = shape.idx(x, y, z);
        const mat = shape.data[i];
        if (mat === Mat.Air || !carriesLoad(mat)) continue;
        const cell = z * sx + x;
        layerIdx.push(cell);
        if (y === 0 || hasSupportBelow(shape, x, y, z)) {
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
        if (nx < 0 || nz < 0 || nx >= sx || nz >= sz) continue;
        const ncell = nz * sx + nx;
        if (dist[ncell] >= 0) continue;
        const j = shape.idx(nx, y, nz);
        const mat = shape.data[j];
        if (mat === Mat.Air || !carriesLoad(mat)) continue;
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
      if (comp[start] >= 0) continue;
      const id = compCount++;
      head = 0;
      tail = 0;
      queue[tail++] = start;
      comp[start] = id;
      let roots = 0;
      let hangLoad = 0;
      let hangCount = 0;
      let distSum = 0;
      let neck = 0;
      const members: number[] = [];

      while (head < tail) {
        const cell = queue[head++];
        members.push(cell);
        const cx = cell % sx;
        const cz = (cell - cx) / sx;
        if (supported[cell]) {
          roots++;
        } else {
          const i = shape.idx(cx, y, cz);
          hangLoad += load[i];
          hangCount++;
          distSum += Math.max(1, dist[cell]);
          if (dist[cell] === 1) neck++;
        }
        for (let k = 0; k < 4; k++) {
          const nx = cx + LATERAL[k][0];
          const nz = cz + LATERAL[k][1];
          if (nx < 0 || nz < 0 || nx >= sx || nz >= sz) continue;
          const ncell = nz * sx + nx;
          if (comp[ncell] >= 0) continue;
          const j = shape.idx(nx, y, nz);
          const mat = shape.data[j];
          if (mat === Mat.Air || !carriesLoad(mat)) continue;
          comp[ncell] = id;
          queue[tail++] = ncell;
        }
      }

      // Ни одной опоры — держать нечему, этим займётся связность.
      if (roots === 0 || hangCount === 0) continue;

      const share = hangLoad / roots;
      const lever = (distSum / hangCount) * s;
      // Изгиб ломает не опору, а корневое сечение самой консоли —
      // балка отламывается у стены, а не выламывает кусок стены.
      // Корень — это висящие клетки на расстоянии 1 от опоры.
      const neckShare = neck > 0 ? hangLoad / neck : 0;

      for (const cell of members) {
        const cx = cell % sx;
        const cz = (cell - cx) / sx;
        const i = shape.idx(cx, y, cz);
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
        const i = shape.idx(cx, y, cz);
        const below = collectSupportersBelow(shape, cx, y, cz);
        if (below.length === 0) continue;
        const share = load[i] / below.length;
        for (const b of below) load[b] += share;
      }
    }
  }

  // --- Проверка предельных состояний ---
  for (let i = 0; i < n; i++) {
    const mat = shape.data[i];
    if (mat === Mat.Air || !carriesLoad(mat)) continue;
    const def = material(mat);
    if (def.indestructible) continue;
    const stress = load[i] / area;
    if (stress > def.maxStress || moment[i] > def.maxMoment) failures.push(i);
  }

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
    tags: [...sourceBody.tags].filter((t) => t !== 'level'),
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

    if (cfg.stress) {
      const { failures } = computeStress(shape, cfg);
      for (const i of failures) shape.setAt(i, Mat.Air);
      result.stressFailures += failures.length;
    }

    const anchored = computeAnchored(shape);
    const loose = findLooseComponents(shape, anchored);
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

  for (const body of [...world.bodies.values()]) {
    if (body.destroyed || body.passive) continue;
    // Динамические обломки в Teardown уже жёсткие: их не пересчитываем.
    if (body.kind !== 'static') continue;
    const dirty = body.shapes.some((s) => s.dirtyStructure.x1 >= s.dirtyStructure.x0);
    if (!dirty) continue;

    const res = solveBodyStructure(body, opts);
    for (const s of body.shapes) s.clearStructureDirty();

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
