import { describe, expect, it } from 'vitest';
import {
  Body,
  Mat,
  VoxelShape,
  VoxelWorld,
  computeAnchored,
  computeStress,
  extractFragment,
  findLooseComponents,
  isAnchorVoxel,
  solveBodyStructure,
  stepStructure,
  v3,
} from '@tvox/core';
import { VS, staticBody } from './helpers.js';

/** Форма без автозаземления: якорит только явный фундамент. */
const shape = (sx: number, sy: number, sz: number) =>
  new VoxelShape({ sx, sy, sz, voxelSize: VS, grounded: false });

function withFoundation(s: VoxelShape): VoxelShape {
  s.fill({ y0: 0, y1: 1 }, Mat.Foundation);
  return s;
}

function worldOf(s: VoxelShape): { world: VoxelWorld; body: Body } {
  const world = new VoxelWorld();
  const body = staticBody([s]);
  world.addBody(body);
  return { world, body };
}

describe('якоря и связность', () => {
  it('перерезанный падающий обломок распадается, связный не пересоздаётся', () => {
    const s = shape(12, 2, 2); s.fill({}, Mat.Wood);
    const world = new VoxelWorld();
    const body = new Body({kind: 'dynamic', shapes: [s], tags: ['debris']});
    body.velocity = v3(1, -3, 2);
    world.addBody(body);
    expect(stepStructure(world).fragments).toHaveLength(0);
    s.fill({x0: 5, x1: 6}, Mat.Air);
    const before = world.totalSolidVoxels();
    const result = stepStructure(world);
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0].body.velocity).toEqual(v3(1, -3, 2));
    expect(world.totalSolidVoxels()).toBe(before);
    expect(world.bodies.size).toBe(2);
    expect(stepStructure(world).fragments).toHaveLength(0);
  });
  it.each([Mat.Dirt, Mat.HeavyMetal, Mat.Rock])('материал %i не удерживает отрезанный блок в воздухе', (mat) => {
    const s = withFoundation(shape(5, 8, 5));
    s.fill({ x0: 1, x1: 4, y0: 5, y1: 7, z0: 1, z1: 4 }, mat);
    expect(findLooseComponents(s, computeAnchored(s))).toHaveLength(1);
  });
  it('оторванная листва исчезает без твёрдого обломка', () => {
    const s = withFoundation(shape(5, 8, 5));
    s.fill({x0: 1, x1: 4, y0: 5, y1: 7, z0: 1, z1: 4}, Mat.Foliage);
    const {world} = worldOf(s);
    const result = stepStructure(world, {stress: false});
    expect(result.dustVoxels).toBe(18);
    expect(result.fragments).toHaveLength(0);
  });
  it('фундамент — якорь, воздух — нет', () => {
    const s = shape(3, 3, 3);
    s.set(1, 1, 1, Mat.Foundation);
    expect(isAnchorVoxel(s, 1, 1, 1)).toBe(true);
    expect(isAnchorVoxel(s, 0, 0, 0)).toBe(false);
  });

  it('нижний слой заземлённой формы якорит', () => {
    const g = new VoxelShape({ sx: 3, sy: 3, sz: 3, voxelSize: VS, grounded: true });
    g.set(1, 0, 1, Mat.Concrete);
    g.set(1, 1, 1, Mat.Concrete);
    expect(isAnchorVoxel(g, 1, 0, 1)).toBe(true);
    expect(isAnchorVoxel(g, 1, 1, 1)).toBe(false);
    const anchored = computeAnchored(g);
    expect(anchored[g.idx(1, 1, 1)]).toBe(1);
  });

  it('парящий блок не якорится', () => {
    const s = withFoundation(shape(5, 8, 5));
    s.fill({ x0: 1, x1: 4, y0: 5, y1: 7, z0: 1, z1: 4 }, Mat.Concrete);
    const anchored = computeAnchored(s);
    expect(anchored[s.idx(2, 6, 2)]).toBe(0);
    const loose = findLooseComponents(s, anchored);
    expect(loose).toHaveLength(1);
    expect(loose[0]).toHaveLength(3 * 2 * 3);
  });

  it('связность идёт по граням, а не по углам', () => {
    const s = withFoundation(shape(5, 5, 5));
    s.set(1, 1, 1, Mat.Concrete);
    // Касается фундамента только углом.
    s.set(3, 2, 3, Mat.Concrete);
    const anchored = computeAnchored(s);
    expect(anchored[s.idx(1, 1, 1)]).toBe(1);
    expect(anchored[s.idx(3, 2, 3)]).toBe(0);
  });

  it('две независимые оторванные группы дают две компоненты', () => {
    const s = withFoundation(shape(9, 6, 3));
    s.fill({ x0: 0, x1: 2, y0: 3, y1: 4, z0: 0, z1: 2 }, Mat.Wood);
    s.fill({ x0: 7, x1: 9, y0: 3, y1: 4, z0: 0, z1: 2 }, Mat.Wood);
    const loose = findLooseComponents(s, computeAnchored(s));
    expect(loose).toHaveLength(2);
  });
});

describe('обрушение при потере опоры', () => {
  it('подпиленная колонна роняет плиту одним обломком', () => {
    const s = withFoundation(shape(9, 16, 9));
    s.fill({ x0: 4, x1: 5, y0: 1, y1: 11, z0: 4, z1: 5 }, Mat.Concrete);
    s.fill({ x0: 2, x1: 7, y0: 11, y1: 12, z0: 2, z1: 7 }, Mat.Concrete);
    const { world, body } = worldOf(s);

    const before = solveBodyStructure(body, { stress: true });
    expect(before.fragments).toHaveLength(0);

    // Перепиливаем колонну на середине.
    s.set(4, 5, 4, Mat.Air);
    const res = solveBodyStructure(body, { stress: true });

    expect(res.fragments).toHaveLength(1);
    const frag = res.fragments[0];
    // 5 вокселей колонны (y=6..10) + плита 5×5.
    expect(frag.voxels).toBe(5 + 25);
    expect(frag.body.kind).toBe('dynamic');
    expect(world.bodies.size).toBe(1);
  });

  it('обломок остаётся ровно там, где был', () => {
    const s = withFoundation(shape(9, 16, 9));
    s.fill({ x0: 4, x1: 6, y0: 6, y1: 9, z0: 4, z1: 6 }, Mat.Concrete);
    const { body } = worldOf(s);
    const wasAt = s.voxelCenterWorld(4, 6, 4, body.transform);

    const res = solveBodyStructure(body, { stress: false });
    expect(res.fragments).toHaveLength(1);
    const fragShape = res.fragments[0].body.shapes[0];
    const nowAt = fragShape.voxelCenterWorld(0, 0, 0, res.fragments[0].body.transform);
    expect(nowAt.x).toBeCloseTo(wasAt.x, 9);
    expect(nowAt.y).toBeCloseTo(wasAt.y, 9);
    expect(nowAt.z).toBeCloseTo(wasAt.z, 9);
  });

  it('мост, подрезанный с одного конца, держится вторым', () => {
    const s = shape(21, 8, 3);
    s.fill({ x0: 0, x1: 2, y0: 0, y1: 5, z0: 0, z1: 3 }, Mat.Foundation);
    s.fill({ x0: 19, x1: 21, y0: 0, y1: 5, z0: 0, z1: 3 }, Mat.Foundation);
    s.fill({ x0: 0, x1: 21, y0: 5, y1: 6, z0: 0, z1: 3 }, Mat.Metal);
    const { body } = worldOf(s);

    expect(solveBodyStructure(body, { stress: true }).fragments).toHaveLength(0);

    // Убираем одну опору целиком.
    s.fill({ x0: 0, x1: 2, y0: 0, y1: 5, z0: 0, z1: 3 }, Mat.Air);
    const res = solveBodyStructure(body, { stress: true });
    // Настил всё ещё связан со второй опорой — падать нечему.
    expect(res.fragments).toHaveLength(0);
    expect(s.get(0, 5, 0)).toBe(Mat.Metal);
  });

  it('мелкий осколок уходит в пыль, а не в отдельное тело', () => {
    const s = withFoundation(shape(6, 6, 6));
    s.set(2, 3, 2, Mat.Wood);
    s.set(3, 3, 2, Mat.Wood);
    const { body } = worldOf(s);
    const res = solveBodyStructure(body, { minFragmentVoxels: 4, stress: false });
    expect(res.fragments).toHaveLength(0);
    expect(res.dustVoxels).toBe(2);
    expect(s.get(2, 3, 2)).toBe(Mat.Air);
  });

  it('лимит обломков за шаг соблюдается, остаток осыпается', () => {
    const s = withFoundation(shape(20, 6, 20));
    for (let x = 0; x < 20; x += 2) {
      for (let z = 0; z < 20; z += 2) {
        s.fill({ x0: x, x1: x + 1, y0: 3, y1: 6, z0: z, z1: z + 1 }, Mat.Wood);
      }
    }
    const { body } = worldOf(s);
    const res = solveBodyStructure(body, { maxFragmentsPerStep: 3, minFragmentVoxels: 2, stress: false });
    expect(res.fragments).toHaveLength(3);
    expect(res.dustVoxels).toBeGreaterThan(0);
  });
});

describe('напряжения', () => {
  it('стоящая конструкция не разрушает сама себя', () => {
    const s = withFoundation(shape(9, 40, 9));
    s.fill({ x0: 4, x1: 5, y0: 1, y1: 40, z0: 4, z1: 5 }, Mat.Wood);
    const { failures } = computeStress(s);
    expect(failures).toHaveLength(0);
  });

  it('нагрузка накапливается сверху вниз', () => {
    const s = withFoundation(shape(3, 10, 3));
    s.fill({ x0: 1, x1: 2, y0: 1, y1: 10, z0: 1, z1: 2 }, Mat.Concrete);
    const { load } = computeStress(s);
    const top = load[s.idx(1, 9, 1)];
    const bottom = load[s.idx(1, 1, 1)];
    expect(bottom).toBeGreaterThan(top * 8);
  });

  it('обугленная опора не держит перекрытие, стальная держит', () => {
    const build = (mat: Mat) => {
      const s = withFoundation(shape(9, 10, 9));
      s.fill({ x0: 4, x1: 5, y0: 1, y1: 6, z0: 4, z1: 5 }, mat);
      s.fill({ x0: 2, x1: 7, y0: 6, y1: 7, z0: 2, z1: 7 }, Mat.Concrete);
      return s;
    };
    expect(computeStress(build(Mat.Charred)).failures.length).toBeGreaterThan(0);
    expect(computeStress(build(Mat.Metal)).failures).toHaveLength(0);
  });

  it('стекло не держит изгиб: полка отламывается, стальная — нет', () => {
    const shelf = (mat: Mat) => {
      const s = shape(20, 14, 3);
      s.fill({ x0: 0, x1: 1, y0: 0, y1: 11, z0: 0, z1: 3 }, Mat.Foundation);
      s.fill({ x0: 1, x1: 16, y0: 10, y1: 11, z0: 1, z1: 2 }, mat);
      return s;
    };
    expect(computeStress(shelf(Mat.Glass)).failures.length).toBeGreaterThan(0);
    expect(computeStress(shelf(Mat.Metal)).failures).toHaveLength(0);
  });

  it('длинная деревянная консоль отламывается, короткая держится', () => {
    const beam = (len: number, mat: Mat) => {
      const s = shape(len + 2, 14, 3);
      s.fill({ x0: 0, x1: 1, y0: 0, y1: 11, z0: 0, z1: 3 }, Mat.Foundation);
      s.fill({ x0: 1, x1: len + 1, y0: 10, y1: 11, z0: 1, z1: 2 }, mat);
      return s;
    };
    expect(computeStress(beam(15, Mat.Wood)).failures).toHaveLength(0);
    expect(computeStress(beam(45, Mat.Wood)).failures.length).toBeGreaterThan(0);
  });

  it('стальная консоль той же длины выдерживает', () => {
    const s = shape(47, 14, 3);
    s.fill({ x0: 0, x1: 1, y0: 0, y1: 11, z0: 0, z1: 3 }, Mat.Foundation);
    s.fill({ x0: 1, x1: 46, y0: 10, y1: 11, z0: 1, z1: 2 }, Mat.Metal);
    expect(computeStress(s).failures).toHaveLength(0);
  });

  it('множитель нагрузки усиливает обрушение', () => {
    const build = () => {
      const s = withFoundation(shape(9, 10, 9));
      s.fill({ x0: 4, x1: 5, y0: 1, y1: 6, z0: 4, z1: 5 }, Mat.Brick);
      s.fill({ x0: 1, x1: 8, y0: 6, y1: 8, z0: 1, z1: 8 }, Mat.Concrete);
      return s;
    };
    const normal = computeStress(build(), { loadScale: 1 }).failures.length;
    const heavy = computeStress(build(), { loadScale: 20 }).failures.length;
    expect(heavy).toBeGreaterThan(normal);
  });

  it('краска и вода не считаются несущими', () => {
    const s = withFoundation(shape(3, 4, 3));
    s.set(1, 1, 1, Mat.Paint);
    s.set(1, 2, 1, Mat.Water);
    const { load } = computeStress(s);
    expect(load[s.idx(1, 1, 1)]).toBe(0);
    expect(load[s.idx(1, 2, 1)]).toBe(0);
  });

  it('отключённый расчёт напряжений ничего не ломает', () => {
    const s = withFoundation(shape(9, 10, 9));
    s.fill({ x0: 4, x1: 5, y0: 1, y1: 6, z0: 4, z1: 5 }, Mat.Glass);
    s.fill({ x0: 2, x1: 7, y0: 6, y1: 7, z0: 2, z1: 7 }, Mat.Concrete);
    const { body } = worldOf(s);
    const res = solveBodyStructure(body, { stress: false });
    expect(res.stressFailures).toBe(0);
    expect(res.fragments).toHaveLength(0);
  });
});

describe('извлечение обломка', () => {
  it('переносит воксели и краску, очищая исходную форму', () => {
    const s = shape(6, 6, 6);
    s.set(2, 2, 2, Mat.Wood);
    s.set(3, 2, 2, Mat.Wood);
    s.paint.set(s.idx(2, 2, 2), 7);
    const body = staticBody([s]);
    const { body: frag, mass } = extractFragment(body, s, [s.idx(2, 2, 2), s.idx(3, 2, 2)]);
    expect(s.solidVoxels).toBe(0);
    expect(s.paint.size).toBe(0);
    expect(frag.shapes[0].solidVoxels).toBe(2);
    expect(frag.shapes[0].paint.size).toBe(1);
    expect(mass).toBeCloseTo(2 * 700 * 0.001, 9);
    expect(frag.kind).toBe('dynamic');
  });

  it('обломок не наследует тег уровня', () => {
    const s = shape(4, 4, 4);
    s.set(1, 1, 1, Mat.Wood);
    const body = new Body({ kind: 'static', shapes: [s], tags: ['level', 'port'] });
    const { body: frag } = extractFragment(body, s, [s.idx(1, 1, 1)]);
    expect(frag.tags.has('level')).toBe(false);
    expect(frag.tags.has('port')).toBe(true);
  });
});

describe('шаг структурного анализа по миру', () => {
  it('обрабатывает только грязные статические тела и шлёт событие', () => {
    const s = withFoundation(shape(9, 12, 9));
    s.fill({ x0: 4, x1: 5, y0: 1, y1: 8, z0: 4, z1: 5 }, Mat.Concrete);
    s.fill({ x0: 3, x1: 6, y0: 8, y1: 9, z0: 3, z1: 6 }, Mat.Concrete);
    const { world, body } = worldOf(s);
    for (const sh of body.shapes) sh.clearStructureDirty();

    expect(stepStructure(world).fragments).toHaveLength(0);

    s.set(4, 4, 4, Mat.Air);
    const events: string[] = [];
    world.events.on('body:split', (e) => events.push(e.reason));
    const res = stepStructure(world);
    expect(res.fragments.length).toBe(1);
    expect(events).toEqual(['disconnected']);
    expect(world.bodies.size).toBe(2);
    expect(world.dynamicBodies).toHaveLength(1);
  });

  it('динамические обломки повторно не пересчитываются', () => {
    const world = new VoxelWorld();
    const s = shape(6, 6, 6);
    s.fill({ x0: 1, x1: 5, y0: 1, y1: 5, z0: 1, z1: 5 }, Mat.Wood);
    world.addBody(new Body({ kind: 'dynamic', shapes: [s], name: 'debris' }));
    const res = stepStructure(world);
    expect(res.fragments).toHaveLength(0);
    expect(s.solidVoxels).toBe(64);
  });

  it('пустое тело собирается сборщиком мусора', () => {
    const world = new VoxelWorld();
    const s = shape(4, 4, 4);
    s.set(1, 1, 1, Mat.Wood);
    const b = world.addBody(new Body({ kind: 'dynamic', shapes: [s], name: 'dust' }));
    s.set(1, 1, 1, Mat.Air);
    stepStructure(world);
    expect(world.bodies.has(b.id)).toBe(false);
  });

  it('пассивные тела (вода) не анализируются', () => {
    const world = new VoxelWorld();
    const s = shape(4, 4, 4);
    s.fill({ y0: 2, y1: 3 }, Mat.Water);
    world.addBody(new Body({ kind: 'static', shapes: [s], passive: true, name: 'water' }));
    const res = stepStructure(world);
    expect(res.fragments).toHaveLength(0);
    expect(s.solidVoxels).toBe(16);
  });

  it('обрушение сохраняет суммарное число вокселей', () => {
    const s = withFoundation(shape(9, 14, 9));
    s.fill({ x0: 4, x1: 5, y0: 1, y1: 10, z0: 4, z1: 5 }, Mat.Concrete);
    s.fill({ x0: 2, x1: 7, y0: 10, y1: 11, z0: 2, z1: 7 }, Mat.Concrete);
    const { world } = worldOf(s);
    const before = world.totalSolidVoxels();
    s.set(4, 5, 4, Mat.Air);
    stepStructure(world);
    expect(world.totalSolidVoxels()).toBe(before - 1);
  });

  it('позиция обломка в мире учитывает трансформ тела', () => {
    const s = withFoundation(shape(6, 10, 6));
    s.fill({ x0: 2, x1: 4, y0: 5, y1: 7, z0: 2, z1: 4 }, Mat.Concrete);
    const world = new VoxelWorld();
    const body = new Body({
      kind: 'static',
      shapes: [s],
      transform: { position: v3(100, 0, -50), rotation: { x: 0, y: 0, z: 0, w: 1 } },
    });
    world.addBody(body);
    const res = stepStructure(world);
    expect(res.fragments).toHaveLength(1);
    expect(res.fragments[0].center.x).toBeCloseTo(100 + 0.3, 6);
    expect(res.fragments[0].center.z).toBeCloseTo(-50 + 0.3, 6);
  });
});
