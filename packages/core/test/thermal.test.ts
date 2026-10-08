import { describe, expect, it } from 'vitest';
import { Body, FireSystem, Mat, VoxelShape, VoxelWorld, v3 } from '@tvox/core';

function fixture(mat = Mat.Wood, opts = {}) {
  const world = new VoxelWorld(), fire = new FireSystem(opts);
  const shape = new VoxelShape({ sx: 3, sy: 3, sz: 3, voxelSize: 0.1 });
  shape.fill({}, mat); shape.structural = false;
  const body = new Body({ kind: 'static', shapes: [shape] }); world.addBody(body);
  const index = shape.idx(1, 1, 0);
  const heat = (seconds: number) => {
    for (let t = 0; t < seconds; t += 0.05) {
      fire.heatSurface(world, body, shape, index, 0.05);
      fire.step(world, 0.05);
    }
  };
  return { world, fire, shape, body, index, heat };
}

describe('накопление тепла от огнемёта', () => {
  it('дерево загорается после нагрева и продолжает гореть без струи', () => {
    const { world, fire, shape, index, heat } = fixture();
    heat(0.05); expect(fire.isBurning(shape, index)).toBe(false);
    heat(0.8); expect(fire.isBurning(shape, index)).toBe(true);
    fire.step(world, 0.5); expect(fire.burningCount).toBeGreaterThan(0);
  });

  it.each([Mat.Wood, Mat.Plastic])('влага блокирует повторный нагрев материала %s', mat => {
    const { world, fire, shape, index, heat } = fixture(mat);
    heat(0.1); fire.extinguish(world, v3(0.15, 0.15, 0.05), 0.2, 2);
    const cold = fire.temperature(shape, index);
    heat(2); expect(fire.isBurning(shape, index)).toBe(false);
    expect(fire.temperature(shape, index)).toBeLessThanOrEqual(cold);
    expect(shape.get(1, 1, 0)).toBe(mat);
  });

  it('пластик плавится постепенно, меняет геометрию и коллайдер', () => {
    const { shape, body, heat } = fixture(Mat.Plastic);
    heat(0.05); expect(shape.get(1, 1, 0)).toBe(Mat.Plastic);
    body.collidersDirty = false;
    heat(0.6); expect(shape.get(1, 1, 0)).toBe(Mat.Air); expect(body.collidersDirty).toBe(true);
  });

  it('стекло сначала темнеет, затем теряет нагретую ячейку, оставляя соседние', () => {
    const { shape, index, heat } = fixture(Mat.Glass);
    heat(1.5); expect(shape.data[index]).toBe(Mat.Glass); expect(shape.damage[index]).toBeGreaterThan(0);
    heat(6); expect(shape.data[index]).toBe(Mat.Air); expect(shape.get(0, 1, 0)).toBe(Mat.Glass);
  });

  it.each([Mat.Metal, Mat.HeavyMetal, Mat.RoofMetal, Mat.Concrete, Mat.Rock])('материал %s не горит и не исчезает от струи', mat => {
    const { fire, shape, index, heat } = fixture(mat);
    heat(60); expect(shape.data[index]).toBe(mat); expect(fire.burningCount).toBe(0);
    expect(shape.damage[index]).toBeGreaterThan(0);
    expect(fire.temperature(shape, index)).toBeGreaterThan(650);
  });

  it('нагретая окрашенная сталь остывает и возвращает исходный цвет', () => {
    const { world, fire, shape, index, heat } = fixture(Mat.Metal);
    shape.paint.set(index, 0x1234567);
    heat(25); expect(shape.paint.get(index)).not.toBe(0x1234567);
    const hot = fire.temperature(shape, index);
    fire.step(world, 10); expect(fire.temperature(shape, index)).toBeLessThan(hot);
    fire.step(world, 1000); expect(fire.temperature(shape, index)).toBe(20);
    expect(shape.paint.get(index)).toBe(0x1234567);
  });

  it('снимок сохраняет нагрев, а рестарт снимает временную окраску', () => {
    const { world, fire, body, shape, index, heat } = fixture(Mat.Metal);
    heat(20); const hot = fire.temperature(shape, index), paint = shape.paint.get(index), saved = fire.snapshot();
    fire.reset(); expect(fire.temperature(shape, index)).toBe(20); expect(shape.paint.has(index)).toBe(false);
    fire.restore(saved, new Map([[body.id, body]]), new Map([[shape.id, shape]]));
    expect(fire.temperature(shape, index)).toBe(hot); expect(shape.paint.get(index)).toBe(paint);
    fire.step(world, 1); expect(fire.temperature(shape, index)).toBeLessThan(hot);
  });

  it.each([Mat.Foundation, Mat.Water, Mat.Loot, Mat.Air])('огонь не меняет защищённый материал %s', mat => {
    const { fire, shape, index, heat } = fixture(mat);
    heat(2); expect(shape.data[index]).toBe(mat); expect(fire.temperature(shape, index)).toBe(20);
  });

  it('под водой нагрев не накапливается; уничтоженные ячейки удаляются из состояния', () => {
    const f = fixture(Mat.Wood, { waterLevel: 1 });
    f.heat(2); expect(f.fire.temperature(f.shape, f.index)).toBe(20);
    const dry = fixture(Mat.Metal); dry.heat(1); dry.shape.setAt(dry.index, Mat.Air);
    dry.fire.step(dry.world, 0.1); expect(dry.fire.temperature(dry.shape, dry.index)).toBe(20);
    dry.body.destroyed = true; dry.fire.step(dry.world, 0.1); expect(dry.fire.snapshot()).toHaveLength(0);
  });
});

it('длительное поливание ограничивает память и продолжает греть новые поверхности', () => {
  const world = new VoxelWorld(), fire = new FireSystem();
  const shape = new VoxelShape({ sx: 100, sy: 1, sz: 80, voxelSize: 0.1 });
  shape.fill({}, Mat.Metal);
  const body = new Body({ kind: 'static', shapes: [shape] }); world.addBody(body);
  for (let i = 0; i < shape.data.length; i++) fire.heatSurface(world, body, shape, i, 0.05);
  expect(fire.snapshot().reduce((n, s) => n + s.heated.length, 0)).toBeLessThanOrEqual(4096);
  expect(fire.temperature(shape, shape.data.length - 1)).toBeGreaterThan(20);
  fire.reset(); expect(fire.snapshot()).toHaveLength(0);
});
