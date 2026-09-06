import { describe, expect, it } from 'vitest';
import {
  Body,
  Simulation,
  StructureOptions,
  carve,
  stepStructure,
} from '@tvox/core';
import { portLevel } from '@tvox/game';

/**
 * Инкрементальный структурный анализ проверяется единственным честным
 * способом: тем же сценарием на той же карте, прогнанным дважды — полным
 * пересчётом и инкрементальным. Расхождение результата означает, что
 * оптимизация врёт, и никакая скорость этого не оправдывает.
 */

interface Scene {
  sim: Simulation;
  level: Body;
}

function scene(): Scene {
  const sim = new Simulation();
  const bodies = portLevel.build(sim);
  return { sim, level: bodies[0] };
}

function blast(
  sim: Simulation,
  center: { x: number; y: number; z: number },
  radius: number,
): number {
  return carve(
    sim.world,
    { kind: 'sphere', center, radius },
    { power: 1, damage: 0, instant: true, falloff: 'quadratic', cause: 'test' },
  ).removed;
}

/** Прогон сценария и слепок итога, по которому сверяются два режима. */
function run(
  hits: Array<{ x: number; y: number; z: number; r: number }>,
  opts: StructureOptions,
): {
  fragments: number;
  detached: number;
  dust: number;
  failures: number;
  voxels: number;
  carved: number;
} {
  const { sim } = scene();
  // Первый проход всегда полный: он и ставит форме отметку «просмотрена».
  stepStructure(sim.world, opts);

  let fragments = 0;
  let detached = 0;
  let dust = 0;
  let failures = 0;
  let carved = 0;
  let passes = 0;
  for (const h of hits) {
    carved += blast(sim, { x: h.x, y: h.y, z: h.z }, h.r);
    // Крутим до затухания, а не фиксированное число проходов: частичный
    // режим намеренно размазывает работу по кадрам, и сравнивать надо
    // то, чем всё кончилось, а не сколько успелось к четвёртому проходу.
    let quiet = 0;
    for (let i = 0; i < 60 && quiet < 2; i++) {
      const res = stepStructure(sim.world, opts);
      passes++;
      const moved = res.fragments.length + res.detachedVoxels + res.dustVoxels + res.stressFailures;
      quiet = moved === 0 ? quiet + 1 : 0;
      fragments += res.fragments.length;
      detached += res.detachedVoxels;
      dust += res.dustVoxels;
      failures += res.stressFailures;
    }
    expect(passes).toBeLessThan(120);
  }
  return { fragments, detached, dust, failures, carved, voxels: sim.world.totalSolidVoxels() };
}

// Координаты — мировые, по фактической геометрии «Порта»: склад стоит на
// (6,0,14) и занимает 20×8×16 м, офис — на (30,0,14), кран — на (28,0,4).
const SCENARIOS: Array<{ name: string; hits: Array<{ x: number; y: number; z: number; r: number }> }> = [
  { name: 'дыра в стене склада', hits: [{ x: 12, y: 2, z: 14.1, r: 0.9 }] },
  {
    name: 'подрезанная колонна',
    hits: [
      { x: 10, y: 0.8, z: 18, r: 0.6 },
      { x: 10, y: 1.6, z: 18, r: 0.6 },
    ],
  },
  {
    name: 'серия по офису',
    hits: [
      { x: 35, y: 2, z: 14.1, r: 1.0 },
      { x: 32, y: 2, z: 14.1, r: 1.0 },
      { x: 35, y: 4, z: 14.1, r: 1.0 },
    ],
  },
  // Башня крана полая, а тяжёлая сталь берётся только у самого центра
  // заряда — отсюда и точка, и радиус.
  { name: 'удар в кран', hits: [{ x: 29.2, y: 5, z: 7, r: 0.8 }] },
  {
    name: 'подрез склада изнутри',
    hits: [
      { x: 14, y: 1.2, z: 22, r: 0.8 },
      { x: 18, y: 1.2, z: 22, r: 0.8 },
    ],
  },
];

describe('инкрементальная структурная целостность', () => {
  for (const sc of SCENARIOS) {
    it(`совпадает с полным пересчётом: ${sc.name}`, () => {
      const full = run(sc.hits, { incremental: false });
      const inc = run(sc.hits, { incremental: true });
      // Сценарий, который ничего не разрушил, сравнивать бессмысленно:
      // два нуля сойдутся и на сломанном коде.
      expect(full.carved).toBeGreaterThan(0);
      expect(inc).toEqual(full);
    });
  }

  it('первый проход по свежей форме всегда полный', () => {
    const { level } = scene();
    for (const s of level.shapes) expect(s.structureScanned).toBe(false);
  });

  it('удар в угол формы пачкает один чанк, а не всю форму', () => {
    const { sim, level } = scene();
    const shape = level.shapes.reduce((a, b) => (a.volume > b.volume ? a : b));
    for (const s of level.shapes) {
      s.clearMeshDirty();
      s.clearStructureDirty();
    }
    // Два удара по разным углам: AABB склеил бы их во всю форму,
    // список чанков держит ровно два.
    shape.set(1, 1, 1, 0);
    shape.set(shape.sx - 2, 1, shape.sz - 2, 0);
    expect(shape.dirtyMeshChunks.size).toBeLessThanOrEqual(2);
    expect(shape.chunkCount).toBeGreaterThan(2);
    expect(sim.world.bodies.size).toBeGreaterThan(0);
  });

  it('список грязных чанков не растёт выше их общего числа', () => {
    const { sim, level } = scene();
    const shape = level.shapes.reduce((a, b) => (a.volume > b.volume ? a : b));
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 1000; i++) {
      shape.set(
        Math.floor(rnd() * shape.sx),
        Math.floor(rnd() * shape.sy),
        Math.floor(rnd() * shape.sz),
        0,
      );
    }
    expect(shape.dirtyMeshChunks.size).toBeLessThanOrEqual(shape.chunkCount);
    // 1000 ударов вразнос по всей форме — и всё равно перестроек меньше,
    // чем ударов: в этом весь смысл чанков.
    expect(shape.dirtyMeshChunks.size).toBeLessThan(1000);
    expect(sim.world.bodies.size).toBeGreaterThan(0);
  });

  it('удар по стене склада укладывается в бюджет кадра', () => {
    const median = (incremental: boolean): number => {
      const { sim } = scene();
      stepStructure(sim.world, { incremental });
      const times: number[] = [];
      let carved = 0;
      for (let i = 0; i < 10; i++) {
        // Вдоль передней стены склада: каждый удар реально снимает кладку.
        carved += blast(sim, { x: 8 + i * 0.8, y: 2.2, z: 14.1 }, 0.7);
        const t0 = performance.now();
        stepStructure(sim.world, { incremental });
        times.push(performance.now() - t0);
      }
      expect(carved).toBeGreaterThan(0);
      times.sort((a, b) => a - b);
      return times[times.length >> 1];
    };

    const full = median(false);
    const inc = median(true);
    console.log(
      `структурный проход по удару: полный ${full.toFixed(2)} мс, ` +
        `инкрементальный ${inc.toFixed(2)} мс (×${(full / inc).toFixed(1)})`,
    );

    // Абсолютные миллисекунды здесь мерятся под vitest, где каждый вызов
    // импортированной функции идёт через объект модуля: в собранной игре
    // тот же проход заметно быстрее, и настоящий замер бюджета кадра живёт
    // в браузерном прогоне (tools/smoke). Здесь важно отношение: частичный
    // пересчёт обязан быть кратно дешевле полного.
    expect(inc).toBeLessThan(full / 5);
    expect(inc).toBeLessThan(30);
  });
});
