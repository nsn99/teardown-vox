import { Vec3, clamp, v3 } from './math.js';

/**
 * Дым.
 *
 * Частицы в кадре — это картинка: они красивые и ни на что не влияют.
 * Дым, который мешает целиться, обязан быть данными, а не спрайтами,
 * иначе «мешает» — вопрос веры. Поэтому здесь редкая сетка плотности:
 * метровые ячейки, подъём вверх, снос ветром, распад со временем.
 *
 * Метр на ячейку выбран не от лени. Дым — не воксель: у него нет ни
 * граней, ни формы, его видно облаком. Считать его по десятисантиметровой
 * сетке значило бы платить в тысячу раз больше за разницу, которой на
 * экране не видно.
 */

export interface SmokeOptions {
  /** Ребро ячейки, м. */
  cell?: number;
  /** Во сколько раз плотность падает за секунду. */
  decay?: number;
  /** Скорость подъёма, м/с. */
  rise?: number;
  /** Постоянный ветер, м/с. */
  wind?: Vec3;
  /** Плотность, ниже которой ячейка выбрасывается. */
  cutoff?: number;
  /** Больше этого числа ячеек не держим: дальние и слабые вытесняются. */
  maxCells?: number;
}

const DEFAULTS = {
  cell: 1,
  decay: 0.55,
  rise: 1.1,
  cutoff: 0.02,
  maxCells: 4096,
} satisfies Omit<Required<SmokeOptions>, 'wind'>;

interface Cell {
  /** Координаты ячейки в сетке. */
  x: number;
  y: number;
  z: number;
  density: number;
  /** Накопленный дробный подъём: ячейка всплывает не каждый кадр. */
  lift: number;
  driftX: number;
  driftZ: number;
}

/** Ключ ячейки. Сдвиг — чтобы отрицательные не сталкивались с положительными. */
const key = (x: number, y: number, z: number): number =>
  ((x + 2048) * 4096 + (y + 2048)) * 4096 + (z + 2048);

export class SmokeField {
  private cells = new Map<number, Cell>();
  private cfg: Required<SmokeOptions>;

  constructor(opts: SmokeOptions = {}) {
    this.cfg = { ...DEFAULTS, wind: v3(0.35, 0, 0.15), ...opts };
  }

  get size(): number {
    return this.cells.size;
  }

  get cellSize(): number {
    return this.cfg.cell;
  }

  clear(): void {
    this.cells.clear();
  }

  /** Добавить дыма в точку. Плотность копится, но выше единицы не растёт. */
  emit(at: Vec3, amount: number): void {
    if (amount <= 0) return;
    const c = this.cfg.cell;
    const x = Math.floor(at.x / c);
    const y = Math.floor(at.y / c);
    const z = Math.floor(at.z / c);
    const k = key(x, y, z);
    const cell = this.cells.get(k);
    if (cell) {
      cell.density = clamp(cell.density + amount, 0, 1);
      return;
    }
    if (this.cells.size >= this.cfg.maxCells) this.evict();
    this.cells.set(k, {
      x,
      y,
      z,
      density: clamp(amount, 0, 1),
      lift: 0,
      driftX: 0,
      driftZ: 0,
    });
  }

  /**
   * Дым от разрушения: чем больше снято вокселей, тем гуще облако.
   * Логарифм, а не пропорция: между «сотней» и «тысячей» вокселей глаз
   * разницы почти не видит, а между «одним» и «сотней» — видит всю.
   */
  emitFromDestruction(at: Vec3, voxels: number): void {
    if (voxels <= 0) return;
    this.emit(at, clamp(0.12 + Math.log10(1 + voxels) * 0.28, 0, 1));
  }

  /** Плотность в точке, 0..1. */
  densityAt(p: Vec3): number {
    const c = this.cfg.cell;
    const cell = this.cells.get(
      key(Math.floor(p.x / c), Math.floor(p.y / c), Math.floor(p.z / c)),
    );
    return cell ? cell.density : 0;
  }

  /**
   * Непрозрачность вдоль отрезка, 0..1.
   *
   * Считается по закону Бугера: каждая ячейка гасит долю оставшегося
   * света, а не вычитается из него. Иначе три полупрозрачных облака
   * подряд давали бы полную темноту, а в жизни дают три четверти.
   */
  opacityAlong(from: Vec3, to: Vec3, step = this.cfg.cell * 0.5): number {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6 || this.cells.size === 0) return 0;

    const n = Math.min(256, Math.max(1, Math.ceil(len / step)));
    const dt = len / n;
    let transmit = 1;
    const p = v3();
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      p.x = from.x + dx * t;
      p.y = from.y + dy * t;
      p.z = from.z + dz * t;
      const d = this.densityAt(p);
      if (d <= 0) continue;
      transmit *= Math.exp(-d * dt * ABSORB);
      if (transmit < 0.01) return 1;
    }
    return 1 - transmit;
  }

  /**
   * Шаг: дым всплывает, сносится ветром и редеет.
   *
   * Всплытие — целыми ячейками по накопленному дробному сдвигу. Держать
   * дробные координаты у сетки бессмысленно, а прыжок на ячейку раз в
   * секунду глаз читает как подъём.
   */
  step(dt: number): void {
    if (this.cells.size === 0) return;
    const { decay, rise, wind, cutoff, cell } = this.cfg;
    const fade = Math.exp(-decay * dt);
    const moved: Cell[] = [];

    for (const [k, c] of this.cells) {
      c.density *= fade;
      if (c.density < cutoff) {
        this.cells.delete(k);
        continue;
      }
      c.lift += (rise * dt) / cell;
      c.driftX += (wind.x * dt) / cell;
      c.driftZ += (wind.z * dt) / cell;
      const up = Math.floor(c.lift);
      const dx = Math.floor(c.driftX);
      const dz = Math.floor(c.driftZ);
      if (up === 0 && dx === 0 && dz === 0) continue;

      c.lift -= up;
      c.driftX -= dx;
      c.driftZ -= dz;
      this.cells.delete(k);
      c.x += dx;
      c.y += up;
      c.z += dz;
      moved.push(c);
    }

    // Переехавшие ячейки кладём после обхода: иначе они попадались бы на
    // том же шаге второй раз и уносились вверх втрое быстрее.
    for (const c of moved) {
      const k = key(c.x, c.y, c.z);
      const there = this.cells.get(k);
      if (there) {
        there.density = clamp(there.density + c.density * 0.5, 0, 1);
      } else {
        this.cells.set(k, c);
      }
    }
  }

  /** Облака для рендера: центр ячейки в мире и её плотность. */
  *clouds(): Generator<{ position: Vec3; density: number }> {
    const c = this.cfg.cell;
    for (const cell of this.cells.values()) {
      yield {
        position: v3((cell.x + 0.5) * c, (cell.y + 0.5) * c, (cell.z + 0.5) * c),
        density: cell.density,
      };
    }
  }

  /** Выбросить самую слабую ячейку — потолок держится жёстко. */
  private evict(): void {
    let weakest = -1;
    let min = Infinity;
    for (const [k, c] of this.cells) {
      if (c.density < min) {
        min = c.density;
        weakest = k;
      }
    }
    if (weakest >= 0) this.cells.delete(weakest);
  }
}

/**
 * Во сколько раз ослабляется свет на метре пути в плотном дыму.
 * Подобрано так, чтобы три метра густого дыма закрывали цель почти
 * полностью, а метр редкого — почти не мешал.
 */
const ABSORB = 1.6;
