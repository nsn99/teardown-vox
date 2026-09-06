import { VoxelWorld, WorldOptions } from './world.js';
import { PhysicsBackend, SimplePhysics, SimplePhysicsOptions } from './physics.js';
import { FireOptions, FireSystem } from './fire.js';
import { StructureOptions, StructureResult, stepStructure } from './structure.js';

export interface SimulationOptions {
  world?: WorldOptions;
  physics?: SimplePhysicsOptions;
  fire?: FireOptions;
  structure?: StructureOptions;
  /** Шаг физики, с. Фиксированный — иначе разрушения недетерминированы. */
  fixedStep?: number;
  /** Больше этого числа шагов за кадр не догоняем: лучше замедлиться, чем зависнуть. */
  maxStepsPerFrame?: number;
  /** Структурный анализ реже физики: он дорогой, а обвал не обязан быть мгновенным. */
  structureEveryNSteps?: number;
  /**
   * Готовый бэкенд или фабрика по миру. Фабрика удобнее: мир создаётся
   * внутри симуляции, а бэкенду он нужен на конструирование.
   */
  backend?: PhysicsBackend | ((world: VoxelWorld) => PhysicsBackend);
}

export interface SimStepStats {
  steps: number;
  structure: StructureResult | null;
  burning: number;
  bodies: number;
}

/**
 * Сборка ядра: мир + физика + огонь + структурная целостность,
 * на фиксированном шаге. Всё, что снаружи (рендер, ввод, миссия),
 * дёргает только step() и читает мир.
 */
export class Simulation {
  readonly world: VoxelWorld;
  readonly fire: FireSystem;
  readonly fixedStep: number;

  private backend: PhysicsBackend;

  private accumulator = 0;
  private stepIndex = 0;
  private structureOpts: StructureOptions;
  private maxSteps: number;
  private structureEvery: number;

  constructor(opts: SimulationOptions = {}) {
    this.world = new VoxelWorld(opts.world);
    this.backend =
      typeof opts.backend === 'function'
        ? opts.backend(this.world)
        : (opts.backend ?? new SimplePhysics(this.world, opts.physics));
    this.fire = new FireSystem(opts.fire);
    this.fixedStep = opts.fixedStep ?? 1 / 60;
    this.maxSteps = opts.maxStepsPerFrame ?? 5;
    this.structureEvery = opts.structureEveryNSteps ?? 2;
    this.structureOpts = opts.structure ?? {};
  }

  get physics(): PhysicsBackend {
    return this.backend;
  }

  /**
   * Подменить физический бэкенд. Rapier инициализируется асинхронно
   * (WASM), поэтому игра стартует на headless-дублёре и переключается,
   * как только модуль загрузился.
   */
  setPhysics(backend: PhysicsBackend, disposeOld = true): void {
    if (backend === this.backend) return;
    if (disposeOld) this.backend.dispose();
    this.backend = backend;
    for (const body of this.world.bodies.values()) {
      if (!body.destroyed) backend.sync(body);
    }
  }

  /** Продвинуть симуляцию на dt секунд реального времени. */
  step(dt: number): SimStepStats {
    this.accumulator += dt;
    let steps = 0;
    let structure: StructureResult | null = null;
    let burning = 0;

    // Допуск: без него накопленная ошибка double съедает каждый N-й шаг
    // (0.05 - 4×0.01 даёт 0.00999…, и пятый шаг молча теряется).
    const threshold = this.fixedStep - 1e-9;
    while (this.accumulator >= threshold && steps < this.maxSteps) {
      this.accumulator -= this.fixedStep;
      steps++;
      this.stepIndex++;

      this.backend.step(this.fixedStep);
      burning = this.fire.step(this.world, this.fixedStep).burning;

      if (this.stepIndex % this.structureEvery === 0) {
        const res = stepStructure(this.world, this.structureOpts);
        structure = mergeStructure(structure, res);
        for (const f of res.fragments) this.backend.sync(f.body);
      }
    }

    // Накопитель не должен расти без предела: иначе после лага
    // симуляция будет вечно догонять и кадры превратятся в слайд-шоу.
    if (this.accumulator > this.fixedStep * this.maxSteps) {
      this.accumulator = this.fixedStep * this.maxSteps;
    }

    return { steps, structure, burning, bodies: this.world.bodies.size };
  }

  /** Немедленно посчитать структурную целостность (после взрыва). */
  settle(): StructureResult {
    const res = stepStructure(this.world, this.structureOpts);
    for (const f of res.fragments) this.backend.sync(f.body);
    return res;
  }

  reset(): void {
    for (const b of [...this.world.bodies.values()]) this.world.removeBody(b);
    this.world.collectGarbage();
    this.fire.reset();
    this.accumulator = 0;
    this.stepIndex = 0;
    this.world.time = 0;
  }

  dispose(): void {
    this.backend.dispose();
  }
}

function mergeStructure(
  a: StructureResult | null,
  b: StructureResult,
): StructureResult {
  if (!a) return b;
  return {
    fragments: [...a.fragments, ...b.fragments],
    detachedVoxels: a.detachedVoxels + b.detachedVoxels,
    dustVoxels: a.dustVoxels + b.dustVoxels,
    stressFailures: a.stressFailures + b.stressFailures,
  };
}
