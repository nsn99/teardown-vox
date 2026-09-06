import { Vec3, v3 } from './math.js';
import { VoxelWorld, WorldOptions } from './world.js';
import { PhysicsBackend, SimplePhysics, SimplePhysicsOptions } from './physics.js';
import { FireOptions, FireSystem } from './fire.js';
import { SmokeField, SmokeOptions } from './smoke.js';
import {
  StructureOptions,
  StructureResult,
  computeAnchored,
  computeStress,
  findLooseComponents,
  stepStructure,
} from './structure.js';
import { DestructionQueue, DestructionQueueOptions } from './destruction-queue.js';
import { DebrisCapOptions, capDebris } from './debris.js';

export interface SimulationOptions {
  world?: WorldOptions;
  physics?: SimplePhysicsOptions;
  fire?: FireOptions;
  smoke?: SmokeOptions;
  structure?: StructureOptions;
  /** Шаг физики, с. Фиксированный — иначе разрушения недетерминированы. */
  fixedStep?: number;
  /** Больше этого числа шагов за кадр не догоняем: лучше замедлиться, чем зависнуть. */
  maxStepsPerFrame?: number;
  /** Структурный анализ реже физики: он дорогой, а обвал не обязан быть мгновенным. */
  structureEveryNSteps?: number;
  /**
   * Сколько миллисекунд кадра готовы отдать структурному анализу в
   * среднем. Проход неделим, поэтому дорогой проход не режется, а
   * отодвигает следующий: двадцать миллисекунд раз в десять шагов — это
   * два миллисекунды на кадр, и обвал опаздывает на десятую долю секунды,
   * чего никто не замечает.
   */
  structureBudgetMs?: number;
  /**
   * Готовый бэкенд или фабрика по миру. Фабрика удобнее: мир создаётся
   * внутри симуляции, а бэкенду он нужен на конструирование.
   */
  backend?: PhysicsBackend | ((world: VoxelWorld) => PhysicsBackend);
  /** Бюджет отложенного разрушения. */
  destruction?: DestructionQueueOptions;
  /** Потолок числа живых обломков. */
  debris?: DebrisCapOptions;
}

export interface SimStepStats {
  steps: number;
  structure: StructureResult | null;
  burning: number;
  bodies: number;
  /** Вокселей снято отложенным разрушением за этот кадр. */
  carved: number;
  /** Заданий разрушения осталось в очереди. */
  carveQueue: number;
  /** Обломков вморожено в статическую геометрию. */
  frozen: number;
}

/**
 * Сборка ядра: мир + физика + огонь + структурная целостность,
 * на фиксированном шаге. Всё, что снаружи (рендер, ввод, миссия),
 * дёргает только step() и читает мир.
 */
export class Simulation {
  readonly world: VoxelWorld;
  readonly fire: FireSystem;
  /**
   * Дым. Не украшение: он гасит видимость и уводит прицел, поэтому живёт
   * в симуляции рядом с огнём, а не в частицах приложения.
   */
  readonly smoke: SmokeField;
  readonly fixedStep: number;
  /** Очередь отложенного разрушения: большой взрыв растекается по кадрам. */
  readonly destruction: DestructionQueue;
  /** Где игрок. От неё считается, какие обломки не жалко заморозить. */
  focus: Vec3 = v3();

  private backend: PhysicsBackend;

  private accumulator = 0;
  private stepIndex = 0;
  private structureOpts: StructureOptions;
  private maxSteps: number;
  private structureEvery: number;
  private structureBudgetMs: number;
  /** Шаг, раньше которого следующий структурный проход не начинаем. */
  private structureNextStep = 0;
  /** Длительность последнего структурного прохода, мс. */
  lastStructureMs = 0;
  private debrisOpts: DebrisCapOptions;

  constructor(opts: SimulationOptions = {}) {
    this.world = new VoxelWorld(opts.world);
    this.backend =
      typeof opts.backend === 'function'
        ? opts.backend(this.world)
        : (opts.backend ?? new SimplePhysics(this.world, opts.physics));
    this.fire = new FireSystem(opts.fire);
    this.smoke = new SmokeField(opts.smoke);
    this.fixedStep = opts.fixedStep ?? 1 / 60;
    this.maxSteps = opts.maxStepsPerFrame ?? 5;
    this.structureEvery = opts.structureEveryNSteps ?? 2;
    this.structureBudgetMs = opts.structureBudgetMs ?? 2;
    this.structureOpts = opts.structure ?? {};
    this.destruction = new DestructionQueue(opts.destruction);
    this.debrisOpts = opts.debris ?? {};

    // Дым родится там же, где рождается разрушение: подписка вместо
    // ручных вызовов из десяти мест, где что-то ломается.
    this.world.events.on('voxels:removed', (e) => {
      if (e.count > 0) this.smoke.emitFromDestruction(e.center, e.count);
    });
    this.world.events.on('fire:ignited', (e) => this.smoke.emit(e.point, 0.25));
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
    // Разрушение — первым делом и ровно на бюджет кадра: физика должна
    // считать уже по новой геометрии, а не по вчерашней.
    const carved = this.destruction.flush(this.world).removed;

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
      this.smoke.step(this.fixedStep);

      if (this.stepIndex % this.structureEvery === 0 && this.stepIndex >= this.structureNextStep) {
        const t0 = performance.now();
        const res = stepStructure(this.world, this.structureOpts);
        this.lastStructureMs = performance.now() - t0;
        structure = mergeStructure(structure, res);
        for (const f of res.fragments) this.backend.sync(f.body);

        // Дорогой проход отодвигает следующий ровно настолько, чтобы
        // средняя цена кадра осталась в бюджете.
        const skip =
          this.structureBudgetMs > 0
            ? Math.max(1, Math.ceil(this.lastStructureMs / this.structureBudgetMs))
            : 1;
        this.structureNextStep = this.stepIndex + skip;
      }
    }

    // Накопитель не должен расти без предела: иначе после лага
    // симуляция будет вечно догонять и кадры превратятся в слайд-шоу.
    if (this.accumulator > this.fixedStep * this.maxSteps) {
      this.accumulator = this.fixedStep * this.maxSteps;
    }

    const cap = capDebris(this.world, { ...this.debrisOpts, focus: this.focus });
    for (const b of cap.bodies) this.backend.sync(b);

    return {
      steps,
      structure,
      burning,
      bodies: this.world.bodies.size,
      carved,
      carveQueue: this.destruction.pending,
      frozen: cap.frozen,
    };
  }

  /** Немедленно посчитать структурную целостность (после взрыва). */
  settle(): StructureResult {
    const res = stepStructure(this.world, this.structureOpts);
    for (const f of res.fragments) this.backend.sync(f.body);
    return res;
  }

  /**
   * Прогреть структурный анализ по всей статике: полный проход по каждой
   * форме, без правок геометрии.
   *
   * Без прогрева первый же удар по карте оплачивает полный проход по всем
   * формам разом — на «Порту» это почти три секунды прямо в кадре. Здесь
   * та же работа делается на загрузке, где секунда никого не удивляет, и
   * дальше живёт только инкрементальный путь.
   *
   * Ничего не разрушает: найденные превышения возвращаются числом. Уровень,
   * у которого их не ноль, спроектирован неправильно — на это есть тест.
   */
  primeStructure(): { shapes: number; failures: number; loose: number } {
    let shapes = 0;
    let failures = 0;
    let loose = 0;
    for (const body of this.world.bodies.values()) {
      if (body.destroyed || body.passive || body.kind !== 'static') continue;
      for (const shape of body.shapes) {
        if (shape.solidVoxels === 0 || !shape.structural) continue;
        shapes++;
        failures += computeStress(shape, this.structureOpts).failures.length;
        loose += findLooseComponents(shape, computeAnchored(shape)).length;
        shape.structureScanned = true;
        shape.clearStructureDirty();
        shape.takeStructureChanges();
      }
    }
    return { shapes, failures, loose };
  }

  /** Досчитать всё отложенное разрушение здесь и сейчас (итог миссии, тесты). */
  finishDestruction(): number {
    return this.destruction.drain(this.world).removed;
  }

  reset(): void {
    this.destruction.clear();
    for (const b of [...this.world.bodies.values()]) this.world.removeBody(b);
    this.world.collectGarbage();
    this.fire.reset();
    this.smoke.clear();
    this.accumulator = 0;
    this.stepIndex = 0;
    this.structureNextStep = 0;
    this.lastStructureMs = 0;
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
