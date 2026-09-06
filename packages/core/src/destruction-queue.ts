import { Brush, CarveOptions, CarveResult, carve } from './destruction.js';
import { VoxelWorld } from './world.js';

export interface DestructionQueueOptions {
  /**
   * Сколько вокселей разрешено снять за один разбор очереди. Заряд
   * максимальной ступени в плотной кладке снимает сотни тысяч; без
   * потолка это кадр в четверть секунды.
   */
  voxelBudget?: number;
  /** Больше этого числа заданий в очереди не копим: старые вытесняются. */
  maxJobs?: number;
  /**
   * Потолок времени на разбор очереди, мс.
   *
   * Одного счётчика вокселей мало: кисть заряда верхней ступени накрывает
   * сотни тысяч клеток, из которых снимаются единицы, и вся цена — в
   * обходе, а не в удалении. Время ловит и это.
   */
  timeBudgetMs?: number;
}

interface Job {
  brush: Brush;
  opts: CarveOptions;
  /** Сколько вокселей уже снято этим заданием — для диагностики. */
  removed: number;
}

const DEFAULTS = {
  voxelBudget: 12000,
  maxJobs: 64,
  timeBudgetMs: 6,
} satisfies Required<DestructionQueueOptions>;

export interface FlushResult {
  /** Результаты по кускам, обработанным за этот разбор. */
  results: CarveResult[];
  removed: number;
  /** Заданий осталось в очереди. */
  pending: number;
}

/**
 * Очередь отложенного разрушения.
 *
 * Взрыв снимает воксели не одним куском, а порциями по бюджету за кадр.
 * Работает это только потому, что мгновенное разрушение идемпотентно:
 * уже снятый воксель — воздух, повторный проход его пропускает, а порог
 * «сила против прочности» зависит только от самого вокселя и расстояния
 * до центра. Поэтому сумма порций даёт ровно то же, что один вызов, —
 * на это есть тест.
 *
 * Накопительный режим (инструменты) в очередь не кладём: там урон
 * копится, и разбиение вызова меняло бы результат.
 */
export class DestructionQueue {
  private jobs: Job[] = [];
  private cfg: Required<DestructionQueueOptions>;

  constructor(opts: DestructionQueueOptions = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
  }

  get pending(): number {
    return this.jobs.length;
  }

  get budget(): number {
    return this.cfg.voxelBudget;
  }

  /** Поставить разрушение в очередь. Мгновенный режим включается сам. */
  enqueue(brush: Brush, opts: CarveOptions): void {
    if (this.jobs.length >= this.cfg.maxJobs) this.jobs.shift();
    this.jobs.push({ brush, opts: { ...opts, instant: true }, removed: 0 });
  }

  /** Разобрать очередь в пределах бюджета. */
  flush(world: VoxelWorld, budget = this.cfg.voxelBudget): FlushResult {
    const results: CarveResult[] = [];
    let left = budget;
    let removed = 0;
    const until = this.cfg.timeBudgetMs > 0 ? performance.now() + this.cfg.timeBudgetMs : Infinity;

    while (left > 0 && this.jobs.length > 0) {
      const job = this.jobs[0];
      const ask = left;
      const res = carve(world, job.brush, { ...job.opts, maxVoxels: ask });
      results.push(res);
      removed += res.removed;
      job.removed += res.removed;
      left -= res.removed;
      // Не упёрлись в потолок — значит кисть выбрана до конца.
      if (res.removed < ask) this.jobs.shift();
      // Время кончилось — остальное в следующий кадр.
      if (performance.now() > until) break;
    }

    return { results, removed, pending: this.jobs.length };
  }

  /** Дожать очередь до конца. Для тестов и для «досчитать перед итогом». */
  drain(world: VoxelWorld, maxRounds = 1000): FlushResult {
    const results: CarveResult[] = [];
    let removed = 0;
    for (let i = 0; i < maxRounds && this.jobs.length > 0; i++) {
      // Дожимаем без оглядки на время: это досчёт, а не кадр.
      const r = this.flush(world, this.cfg.voxelBudget * 8);
      results.push(...r.results);
      removed += r.removed;
    }
    return { results, removed, pending: this.jobs.length };
  }

  clear(): void {
    this.jobs.length = 0;
  }
}
