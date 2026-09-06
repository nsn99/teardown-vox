import {
  Aabb,
  Transform,
  Vec3,
  aabbEmpty,
  aabbExpand,
  inverseTransformPoint,
  transformIdentity,
  transformPoint,
  v3,
} from './math.js';
import { Mat, isSolid, material, voxelMass } from './materials.js';

export interface VoxelShapeOptions {
  sx: number;
  sy: number;
  sz: number;
  /** Размер вокселя в метрах. Teardown работает на 0.1 — держим то же. */
  voxelSize?: number;
  transform?: Transform;
  /**
   * Если true, нижний слой (y=0) считается прижатым к земле и служит
   * якорем структурной целостности.
   */
  grounded?: boolean;
  name?: string;
}

/** Прямоугольная область вокселей в локальных индексах, полуоткрытая по max. */
export interface VoxelRegion {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

export const emptyRegion = (): VoxelRegion => ({
  x0: Infinity,
  y0: Infinity,
  z0: Infinity,
  x1: -Infinity,
  y1: -Infinity,
  z1: -Infinity,
});

export const regionIsEmpty = (r: VoxelRegion): boolean => r.x1 < r.x0;

export function regionExpand(r: VoxelRegion, x: number, y: number, z: number): void {
  if (x < r.x0) r.x0 = x;
  if (y < r.y0) r.y0 = y;
  if (z < r.z0) r.z0 = z;
  if (x + 1 > r.x1) r.x1 = x + 1;
  if (y + 1 > r.y1) r.y1 = y + 1;
  if (z + 1 > r.z1) r.z1 = z + 1;
}

export function regionUnion(a: VoxelRegion, b: VoxelRegion): VoxelRegion {
  if (regionIsEmpty(b)) return a;
  if (regionIsEmpty(a)) return { ...b };
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    z0: Math.min(a.z0, b.z0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
    z1: Math.max(a.z1, b.z1),
  };
}

/**
 * Ребро чанка в вокселях. Тот же 32, что и в рендере: если бы числа
 * разошлись, один удар пачкал бы полтора чанка сетки рендера.
 */
export const CHUNK_SIZE = 32;

/**
 * Потолок списка изменённых вокселей. Дальше инкрементальный проход
 * дороже полного, и список перестаёт расти — вместо него поднимается
 * флаг переполнения.
 */
export const CHANGE_LIMIT = 8192;

let nextShapeId = 1;
/** Только для тестов: сброс счётчика, чтобы id были предсказуемы. */
export function __resetShapeIds(): void {
  nextShapeId = 1;
}

/**
 * Воксельная форма — прямоугольная сетка материалов с собственным
 * трансформом относительно тела. Мир состоит из множества таких форм,
 * а не из одной гигантской сетки: так и флад-филл дешевле, и обломок
 * отделяется в новое тело без копирования всей карты.
 */
export class VoxelShape {
  readonly id: number;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly voxelSize: number;
  readonly data: Uint8Array;
  /** Накопленный урон на воксель. Сбрасывается при смене материала. */
  readonly damage: Uint16Array;
  transform: Transform;
  grounded: boolean;
  name: string;

  /**
   * Метки баллончика: индекс вокселя → индекс цвета. Живёт отдельно от
   * материалов, чтобы разметка маршрута не меняла ни физику, ни прочность.
   */
  readonly paint = new Map<number, number>();

  /** Грязная область с последней перестройки меша. */
  dirtyMesh: VoxelRegion = emptyRegion();
  /** Грязная область с последнего расчёта структурной целостности. */
  dirtyStructure: VoxelRegion = emptyRegion();

  /**
   * Грязные чанки — то же самое, но без склейки в один AABB. Два удара по
   * противоположным углам склада дают два чанка, а не прямоугольник во всю
   * форму, и рендер перестраивает ровно задетое.
   */
  readonly dirtyMeshChunks = new Set<number>();
  readonly dirtyStructureChunks = new Set<number>();
  readonly dirtyColliderChunks = new Set<number>();

  /** Размер сетки чанков. */
  readonly chunksX: number;
  readonly chunksY: number;
  readonly chunksZ: number;

  /**
   * Полный структурный проход по форме уже был. Пока false, инкрементальный
   * анализ не имеет права работать: он ищет только то, что оторвалось от
   * изменений, а в свежезагруженной карте может висеть что угодно.
   */
  structureScanned = false;

  /**
   * Форма участвует в структурном анализе. Грунт — не участвует: он весь
   * на якоре, консолей в нём нет, а считать по нему напряжения — это пять
   * миллионов клеток на ровном месте.
   */
  structural = true;

  private solidCount = 0;
  /** Непустых вокселей в каждом слое y — чтобы пропускать пустые слои. */
  private layerSolid: Uint32Array;
  /**
   * Непустых вокселей в каждой строке (y,z). В полой коробке склада
   * пустых строк большинство, и структурный проход их просто перешагивает.
   */
  private rowSolid: Uint32Array;
  private changedVoxels: number[] = [];
  private changedOverflow = false;

  constructor(opts: VoxelShapeOptions) {
    const { sx, sy, sz } = opts;
    if (!Number.isInteger(sx) || !Number.isInteger(sy) || !Number.isInteger(sz)) {
      throw new RangeError('Размеры формы должны быть целыми');
    }
    if (sx <= 0 || sy <= 0 || sz <= 0) {
      throw new RangeError('Размеры формы должны быть положительными');
    }
    this.id = nextShapeId++;
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
    this.voxelSize = opts.voxelSize ?? 0.1;
    this.data = new Uint8Array(sx * sy * sz);
    this.damage = new Uint16Array(sx * sy * sz);
    this.transform = opts.transform ?? transformIdentity();
    this.grounded = opts.grounded ?? false;
    this.name = opts.name ?? `shape${this.id}`;
    this.chunksX = Math.ceil(sx / CHUNK_SIZE);
    this.chunksY = Math.ceil(sy / CHUNK_SIZE);
    this.chunksZ = Math.ceil(sz / CHUNK_SIZE);
    this.layerSolid = new Uint32Array(sy);
    this.rowSolid = new Uint32Array(sy * sz);
  }

  /** Всего чанков в форме — верхняя граница длины списка грязных. */
  get chunkCount(): number {
    return this.chunksX * this.chunksY * this.chunksZ;
  }

  /** Линейный индекс чанка, в котором лежит воксель. */
  chunkIndexAt(x: number, y: number, z: number): number {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    return (cy * this.chunksZ + cz) * this.chunksX + cx;
  }

  /** Границы чанка в индексах вокселей, обрезанные по форме. */
  chunkBounds(chunk: number): VoxelRegion {
    const cx = chunk % this.chunksX;
    const t = (chunk - cx) / this.chunksX;
    const cz = t % this.chunksZ;
    const cy = (t - cz) / this.chunksZ;
    return {
      x0: cx * CHUNK_SIZE,
      y0: cy * CHUNK_SIZE,
      z0: cz * CHUNK_SIZE,
      x1: Math.min(this.sx, (cx + 1) * CHUNK_SIZE),
      y1: Math.min(this.sy, (cy + 1) * CHUNK_SIZE),
      z1: Math.min(this.sz, (cz + 1) * CHUNK_SIZE),
    };
  }

  /** Непустых вокселей в слое y. */
  solidInLayer(y: number): number {
    return y >= 0 && y < this.sy ? this.layerSolid[y] : 0;
  }

  /** Непустых вокселей в строке (y,z). */
  solidInRow(y: number, z: number): number {
    if (y < 0 || y >= this.sy || z < 0 || z >= this.sz) return 0;
    return this.rowSolid[y * this.sz + z];
  }

  get volume(): number {
    return this.sx * this.sy * this.sz;
  }

  /** Количество непустых вокселей. Поддерживается инкрементально. */
  get solidVoxels(): number {
    return this.solidCount;
  }

  idx(x: number, y: number, z: number): number {
    return (y * this.sz + z) * this.sx + x;
  }

  /** Обратное к idx: раскладывает линейный индекс на координаты. */
  coords(index: number, out: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }) {
    out.x = index % this.sx;
    const t = (index - out.x) / this.sx;
    out.z = t % this.sz;
    out.y = (t - out.z) / this.sz;
    return out;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }

  /** Материал в позиции. Вне границ — воздух. */
  get(x: number, y: number, z: number): number {
    if (!this.inBounds(x, y, z)) return Mat.Air;
    return this.data[this.idx(x, y, z)];
  }

  /** Ставит материал. Возвращает true, если значение изменилось. */
  set(x: number, y: number, z: number, mat: number): boolean {
    if (!this.inBounds(x, y, z)) return false;
    const i = this.idx(x, y, z);
    const prev = this.data[i];
    if (prev === mat) return false;
    if (isSolid(prev)) {
      this.solidCount--;
      this.layerSolid[y]--;
      this.rowSolid[y * this.sz + z]--;
    }
    if (isSolid(mat)) {
      this.solidCount++;
      this.layerSolid[y]++;
      this.rowSolid[y * this.sz + z]++;
    }
    this.data[i] = mat;
    this.damage[i] = 0;
    if (mat === Mat.Air) this.paint.delete(i);
    this.touch(i, x, y, z);
    return true;
  }

  setAt(index: number, mat: number): boolean {
    const prev = this.data[index];
    if (prev === mat) return false;
    const c = this.coords(index);
    if (isSolid(prev)) {
      this.solidCount--;
      this.layerSolid[c.y]--;
      this.rowSolid[c.y * this.sz + c.z]--;
    }
    if (isSolid(mat)) {
      this.solidCount++;
      this.layerSolid[c.y]++;
      this.rowSolid[c.y * this.sz + c.z]++;
    }
    this.data[index] = mat;
    this.damage[index] = 0;
    if (mat === Mat.Air) this.paint.delete(index);
    this.touch(index, c.x, c.y, c.z);
    return true;
  }

  markDirty(x: number, y: number, z: number): void {
    if (!this.inBounds(x, y, z)) return;
    this.touch(this.idx(x, y, z), x, y, z);
  }

  /** Пометить грязным только меш — материал не менялся (краска). */
  markMeshDirty(x: number, y: number, z: number): void {
    if (!this.inBounds(x, y, z)) return;
    regionExpand(this.dirtyMesh, x, y, z);
    this.dirtyMeshChunks.add(this.chunkIndexAt(x, y, z));
  }

  private touch(index: number, x: number, y: number, z: number): void {
    regionExpand(this.dirtyMesh, x, y, z);
    regionExpand(this.dirtyStructure, x, y, z);
    const chunk = this.chunkIndexAt(x, y, z);
    this.dirtyMeshChunks.add(chunk);
    this.dirtyStructureChunks.add(chunk);
    this.dirtyColliderChunks.add(chunk);
    // Список изменений — вход инкрементального структурного анализа.
    // Переполнился — значит изменений столько, что полный проход дешевле.
    if (this.changedVoxels.length >= CHANGE_LIMIT) this.changedOverflow = true;
    else this.changedVoxels.push(index);
  }

  /**
   * Забрать изменения с прошлого структурного прохода и начать копить заново.
   * overflow=true — изменений было больше потолка, инкрементальному анализу
   * доверять нельзя.
   */
  takeStructureChanges(): { indices: number[]; overflow: boolean } {
    const indices = this.changedVoxels;
    const overflow = this.changedOverflow;
    this.changedVoxels = [];
    this.changedOverflow = false;
    return { indices, overflow };
  }

  /** Есть ли что пересчитывать структурно. */
  get structureDirty(): boolean {
    return this.dirtyStructureChunks.size > 0;
  }

  clearMeshDirty(): void {
    this.dirtyMesh = emptyRegion();
    this.dirtyMeshChunks.clear();
  }

  clearStructureDirty(): void {
    this.dirtyStructure = emptyRegion();
    this.dirtyStructureChunks.clear();
  }

  /** Снять пометку с чанков, коллайдеры которых уже пересобраны. */
  consumeColliderChunks(chunks: Iterable<number>): void {
    for (const c of chunks) this.dirtyColliderChunks.delete(c);
  }

  /**
   * Снять пометку с чанков, которые структурный проход уже закрыл.
   * Остальные останутся грязными и достанутся следующему проходу.
   */
  consumeStructureChunks(chunks: Iterable<number>): void {
    for (const c of chunks) this.dirtyStructureChunks.delete(c);
    if (this.dirtyStructureChunks.size === 0) this.dirtyStructure = emptyRegion();
  }

  fill(region: Partial<VoxelRegion>, mat: number): number {
    const x0 = Math.max(0, region.x0 ?? 0);
    const y0 = Math.max(0, region.y0 ?? 0);
    const z0 = Math.max(0, region.z0 ?? 0);
    const x1 = Math.min(this.sx, region.x1 ?? this.sx);
    const y1 = Math.min(this.sy, region.y1 ?? this.sy);
    const z1 = Math.min(this.sz, region.z1 ?? this.sz);
    let changed = 0;
    for (let y = y0; y < y1; y++) {
      for (let z = z0; z < z1; z++) {
        for (let x = x0; x < x1; x++) {
          if (this.set(x, y, z, mat)) changed++;
        }
      }
    }
    return changed;
  }

  /** Пересчитать solidCount с нуля — после прямой записи в data. */
  recountSolid(): number {
    let n = 0;
    this.layerSolid.fill(0);
    this.rowSolid.fill(0);
    const c = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < this.data.length; i++) {
      if (this.data[i] === Mat.Air) continue;
      n++;
      this.coords(i, c);
      this.layerSolid[c.y]++;
      this.rowSolid[c.y * this.sz + c.z]++;
    }
    this.solidCount = n;
    return n;
  }

  /** Центр вокселя в локальных координатах формы (метры). */
  voxelCenterLocal(x: number, y: number, z: number): Vec3 {
    const s = this.voxelSize;
    return v3((x + 0.5) * s, (y + 0.5) * s, (z + 0.5) * s);
  }

  /** Центр вокселя в мировых координатах, с учётом трансформа тела. */
  voxelCenterWorld(x: number, y: number, z: number, bodyTransform?: Transform): Vec3 {
    const local = this.voxelCenterLocal(x, y, z);
    const p = transformPoint(this.transform, local);
    return bodyTransform ? transformPoint(bodyTransform, p) : p;
  }

  /** Мировая точка → индексы вокселя (floor). Может выйти за границы. */
  worldToVoxel(p: Vec3, bodyTransform?: Transform): Vec3 {
    const inBody = bodyTransform ? inverseTransformPoint(bodyTransform, p) : p;
    const local = inverseTransformPoint(this.transform, inBody);
    const s = this.voxelSize;
    return v3(Math.floor(local.x / s), Math.floor(local.y / s), Math.floor(local.z / s));
  }

  /** AABB формы в локальном пространстве тела. */
  localAabb(): Aabb {
    const s = this.voxelSize;
    const box = aabbEmpty();
    const corners: Vec3[] = [];
    for (let i = 0; i < 8; i++) {
      corners.push(
        v3(
          (i & 1 ? this.sx : 0) * s,
          (i & 2 ? this.sy : 0) * s,
          (i & 4 ? this.sz : 0) * s,
        ),
      );
    }
    for (const c of corners) aabbExpand(box, transformPoint(this.transform, c));
    return box;
  }

  /** Суммарная масса формы, кг. */
  mass(): number {
    let m = 0;
    for (let i = 0; i < this.data.length; i++) {
      const id = this.data[i];
      if (id !== Mat.Air) m += voxelMass(id, this.voxelSize);
    }
    return m;
  }

  /** Центр масс в локальных координатах формы (метры). */
  centerOfMass(): Vec3 {
    let mx = 0;
    let my = 0;
    let mz = 0;
    let total = 0;
    const c = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < this.data.length; i++) {
      const id = this.data[i];
      if (id === Mat.Air) continue;
      const m = voxelMass(id, this.voxelSize);
      this.coords(i, c);
      mx += (c.x + 0.5) * this.voxelSize * m;
      my += (c.y + 0.5) * this.voxelSize * m;
      mz += (c.z + 0.5) * this.voxelSize * m;
      total += m;
    }
    if (total === 0) return v3();
    return v3(mx / total, my / total, mz / total);
  }

  /** Плотный AABB по непустым вокселям (в индексах). Пустая форма → null. */
  solidBounds(): VoxelRegion | null {
    const r = emptyRegion();
    const c = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < this.data.length; i++) {
      if (this.data[i] === Mat.Air) continue;
      this.coords(i, c);
      regionExpand(r, c.x, c.y, c.z);
    }
    return regionIsEmpty(r) ? null : r;
  }

  clone(): VoxelShape {
    const s = new VoxelShape({
      sx: this.sx,
      sy: this.sy,
      sz: this.sz,
      voxelSize: this.voxelSize,
      transform: {
        position: { ...this.transform.position },
        rotation: { ...this.transform.rotation },
      },
      grounded: this.grounded,
      name: this.name,
    });
    s.data.set(this.data);
    s.damage.set(this.damage);
    for (const [k, v] of this.paint) s.paint.set(k, v);
    s.recountSolid();
    return s;
  }

  toJSON(): SerializedShape {
    return {
      sx: this.sx,
      sy: this.sy,
      sz: this.sz,
      voxelSize: this.voxelSize,
      transform: this.transform,
      grounded: this.grounded,
      name: this.name,
      rle: encodeRle(this.data),
    };
  }

  static fromJSON(json: SerializedShape): VoxelShape {
    const s = new VoxelShape({
      sx: json.sx,
      sy: json.sy,
      sz: json.sz,
      voxelSize: json.voxelSize,
      transform: json.transform,
      grounded: json.grounded,
      name: json.name,
    });
    decodeRle(json.rle, s.data);
    s.recountSolid();
    return s;
  }
}

export interface SerializedShape {
  sx: number;
  sy: number;
  sz: number;
  voxelSize: number;
  transform: Transform;
  grounded: boolean;
  name: string;
  /** [материал, длина, материал, длина, ...] */
  rle: number[];
}

/** RLE — воксельные карты почти всегда состоят из длинных однородных пробегов. */
export function encodeRle(data: Uint8Array): number[] {
  const out: number[] = [];
  if (data.length === 0) return out;
  let cur = data[0];
  let run = 1;
  for (let i = 1; i < data.length; i++) {
    if (data[i] === cur) {
      run++;
    } else {
      out.push(cur, run);
      cur = data[i];
      run = 1;
    }
  }
  out.push(cur, run);
  return out;
}

export function decodeRle(rle: number[], out: Uint8Array): Uint8Array {
  let p = 0;
  for (let i = 0; i < rle.length; i += 2) {
    const mat = rle[i];
    const run = rle[i + 1];
    if (p + run > out.length) {
      throw new RangeError('RLE длиннее целевого буфера');
    }
    out.fill(mat, p, p + run);
    p += run;
  }
  if (p !== out.length) {
    throw new RangeError(`RLE покрыл ${p} из ${out.length} вокселей`);
  }
  return out;
}

export { material };
