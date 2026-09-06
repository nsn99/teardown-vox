import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DestructionQueue,
  Simulation,
  SkyLight,
  carve,
  explode,
  stepStructure,
} from '@tvox/core';
import { meshShape } from '@tvox/render';
import { TOOLS, portLevel } from '@tvox/game';

/**
 * Перф-регрессия.
 *
 * Приёмка требует чисел, а не ощущений: сценарий один и тот же, бюджеты
 * записаны, профиль сохраняется файлом. Абсолютные миллисекунды тут
 * заведомо пессимистичны — под vitest каждый вызов импортированной
 * функции идёт через объект модуля, а на общем раннере CI всё ещё втрое
 * медленнее. Поэтому бюджеты заданы с запасом и служат ловушкой для
 * регрессий в разы, а не для дрожания в проценты. Настоящий кадр
 * собранной игры меряется отдельно, в браузерном прогоне.
 */

const CI = Boolean(process.env.CI);
const slack = CI ? 3 : 1;

/**
 * Бюджеты, мс. Это не идеал, а ловушка: числа выставлены примерно вдвое
 * выше измеренных, чтобы падать на регрессии в разы и не дрожать на
 * процентах. Самое дорогое здесь — меширование чанка: следующая цель
 * оптимизации именно оно.
 */
const BUDGET = {
  /** Кадр симуляции во время активного разрушения. */
  frame: 12 * slack,
  /** Перестройка меша одного чанка 32³. */
  remesh: 45 * slack,
  /** Структурный проход после удара. */
  structure: 55 * slack,
  /** Шаг огня на разгоревшемся очаге. */
  fire: 8 * slack,
  /** Разбор очереди отложенного разрушения за кадр. */
  destruction: 90 * slack,
  /** Пересчёт небесного света после удара. */
  skylight: 60 * slack,
};

const profile: Record<string, number> = {};

function median(times: number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

function scene(): Simulation {
  const sim = new Simulation();
  portLevel.build(sim);
  return sim;
}

/** Заряд максимальной ступени: то, чем игрок ломает склад по-настоящему. */
const TOP_CHARGE = TOOLS.explosive.tiers[TOOLS.explosive.tiers.length - 1];
/** Внутри складского пролёта, между колоннами. */
const BLAST_AT = { x: 14, y: 2.5, z: 22 };

describe('перф-бюджеты', () => {
  it('взрыв максимальной ступени: разрушение укладывается в бюджет', () => {
    const sim = scene();
    const queue = new DestructionQueue();

    const t0 = performance.now();
    const res = explode(sim.world, {
      center: BLAST_AT,
      radius: TOP_CHARGE.radius,
      power: TOP_CHARGE.power,
      cause: 'perf',
      maxVoxels: queue.budget,
    });
    const immediate = performance.now() - t0;
    profile['взрыв: первая порция, мс'] = round(immediate);
    profile['взрыв: снято вокселей'] = res.removed;

    expect(res.removed).toBeGreaterThan(0);
    expect(immediate).toBeLessThan(BUDGET.destruction);
  });

  it('кадр симуляции во время обвала укладывается в бюджет', () => {
    const sim = scene();
    explode(sim.world, {
      center: BLAST_AT,
      radius: TOP_CHARGE.radius,
      power: TOP_CHARGE.power,
      cause: 'perf',
    });

    const times: number[] = [];
    for (let i = 0; i < 90; i++) {
      const t = performance.now();
      sim.step(1 / 60);
      times.push(performance.now() - t);
    }
    const med = median(times);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    profile['кадр: медиана, мс'] = round(med);
    profile['кадр: среднее, мс'] = round(avg);
    profile['кадр: максимум, мс'] = round(Math.max(...times));

    expect(med).toBeLessThan(BUDGET.frame);
  });

  it('структурный проход после удара укладывается в бюджет', () => {
    const sim = scene();
    stepStructure(sim.world, {});
    const times: number[] = [];
    for (let i = 0; i < 8; i++) {
      carve(
        sim.world,
        { kind: 'sphere', center: { x: 8 + i * 0.8, y: 2.2, z: 14.1 }, radius: 0.7 },
        { power: 1, damage: 0, instant: true, falloff: 'quadratic', cause: 'perf' },
      );
      const t = performance.now();
      stepStructure(sim.world, {});
      times.push(performance.now() - t);
    }
    const med = median(times);
    profile['структура: медиана, мс'] = round(med);
    expect(med).toBeLessThan(BUDGET.structure);
  });

  it('ремеш одного чанка укладывается в бюджет', () => {
    const sim = scene();
    const level = [...sim.world.bodies.values()].find((b) => b.tags.has('level'))!;
    const shape = level.shapes.find((s) => s.name === 'warehouse')!;
    const region = shape.chunkBounds(shape.chunkIndexAt(20, 20, 20));

    const times: number[] = [];
    let quads = 0;
    for (let i = 0; i < 12; i++) {
      const t = performance.now();
      const mesh = meshShape(shape, { region, originAtRegion: true });
      times.push(performance.now() - t);
      quads = mesh.quads;
    }
    const med = median(times);
    profile['ремеш чанка: медиана, мс'] = round(med);
    profile['ремеш чанка: квадов'] = quads;
    expect(med).toBeLessThan(BUDGET.remesh);
  });

  it('ремеш чанка со светом укладывается в бюджет', () => {
    // Тот же чанк, но с полем небесного света: свет читается на каждую
    // видимую грань, и это самая горячая добавка к мешированию.
    const sim = scene();
    const level = [...sim.world.bodies.values()].find((b) => b.tags.has('level'))!;
    const shape = level.shapes.find((s) => s.name === 'warehouse')!;
    const region = shape.chunkBounds(shape.chunkIndexAt(20, 20, 20));
    const sky = new SkyLight(shape);

    const times: number[] = [];
    for (let i = 0; i < 12; i++) {
      const t = performance.now();
      meshShape(shape, { region, originAtRegion: true, sky });
      times.push(performance.now() - t);
    }
    const med = median(times);
    profile['ремеш со светом: медиана, мс'] = round(med);
    expect(med).toBeLessThan(BUDGET.remesh);
  });

  it('пересчёт небесного света после удара укладывается в бюджет', () => {
    const sim = scene();
    const level = [...sim.world.bodies.values()].find((b) => b.tags.has('level'))!;
    const shape = level.shapes.find((s) => s.name === 'warehouse')!;

    const t0 = performance.now();
    const sky = new SkyLight(shape);
    profile['свет: полный расчёт, мс'] = round(performance.now() - t0);

    const times: number[] = [];
    for (let i = 0; i < 6; i++) {
      const region = {
        x0: 60 + i * 8,
        y0: 70,
        z0: 60,
        x1: 92 + i * 8,
        y1: 80,
        z1: 92,
      };
      shape.fill(region, 0);
      const t = performance.now();
      sky.rebuild(region);
      times.push(performance.now() - t);
    }
    const med = median(times);
    profile['свет: пересчёт куска, мс'] = round(med);
    expect(med).toBeLessThan(BUDGET.skylight);
  });

  it('шаг огня укладывается в бюджет', () => {
    const sim = scene();
    // Поджигаем причал: там дерево, и очаг разрастается сам.
    sim.fire.igniteArea(sim.world, { x: 8, y: 0.6, z: 4 }, 2.5, 1);
    for (let i = 0; i < 30; i++) sim.fire.step(sim.world, 1 / 60);

    const times: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t = performance.now();
      sim.fire.step(sim.world, 1 / 60);
      times.push(performance.now() - t);
    }
    const med = median(times);
    profile['огонь: медиана, мс'] = round(med);
    profile['огонь: очагов'] = sim.fire.burningCount;
    expect(med).toBeLessThan(BUDGET.fire);
  });

  it('профиль сохраняется файлом', () => {
    profile['режим'] = CI ? 1 : 0;
    const payload = {
      when: new Date().toISOString(),
      ci: CI,
      budgets: BUDGET,
      measured: profile,
    };
    writeFileSync('perf.json', `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    // Файл имеет смысл только если в нём есть все замеры.
    expect(Object.keys(profile).length).toBeGreaterThanOrEqual(11);
  });
});

const round = (v: number): number => Math.round(v * 100) / 100;
