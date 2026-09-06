import { describe, expect, it } from 'vitest';
import { Simulation, SmokeField, explode, v3 } from '@tvox/core';
import { Body, Mat, VoxelShape } from '@tvox/core';

/**
 * Дым.
 *
 * Проверяется ровно то, ради чего он вообще существует как данные, а не
 * как спрайты: плотное облако закрывает линию взгляда, редкое — нет,
 * и через несколько секунд не остаётся ни того ни другого.
 */

const still = () => new SmokeField({ wind: v3(), rise: 0 });

describe('поле дыма', () => {
  it('пустое поле ничего не закрывает', () => {
    const smoke = new SmokeField();
    expect(smoke.size).toBe(0);
    expect(smoke.opacityAlong(v3(0, 1, 0), v3(10, 1, 0))).toBe(0);
    expect(smoke.densityAt(v3(0, 1, 0))).toBe(0);
  });

  it('плотное облако закрывает цель за ним', () => {
    const smoke = still();
    // Три метра сплошного дыма между глазом и целью.
    for (let x = 3; x < 7; x++) smoke.emit(v3(x + 0.5, 1.5, 0.5), 1);
    const blocked = smoke.opacityAlong(v3(0, 1.5, 0.5), v3(10, 1.5, 0.5));
    expect(blocked).toBeGreaterThan(0.9);

    // Мимо облака — чисто.
    const clear = smoke.opacityAlong(v3(0, 1.5, 20.5), v3(10, 1.5, 20.5));
    expect(clear).toBe(0);
  });

  it('редкий дым мешает, но не слепит', () => {
    const smoke = still();
    smoke.emit(v3(5.5, 1.5, 0.5), 0.2);
    const d = smoke.opacityAlong(v3(0, 1.5, 0.5), v3(10, 1.5, 0.5));
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(0.4);
  });

  it('густота копится, но выше единицы не растёт', () => {
    const smoke = still();
    for (let i = 0; i < 20; i++) smoke.emit(v3(1.5, 1.5, 1.5), 0.3);
    expect(smoke.densityAt(v3(1.5, 1.5, 1.5))).toBe(1);
    expect(smoke.size).toBe(1);
  });

  it('дым редеет и исчезает сам', () => {
    const smoke = still();
    smoke.emit(v3(1.5, 1.5, 1.5), 1);
    const start = smoke.densityAt(v3(1.5, 1.5, 1.5));
    for (let i = 0; i < 30; i++) smoke.step(1 / 30);
    const after = smoke.densityAt(v3(1.5, 1.5, 1.5));
    expect(after).toBeLessThan(start);

    // Через десять секунд от облака не остаётся ни ячейки.
    for (let i = 0; i < 300; i++) smoke.step(1 / 30);
    expect(smoke.size).toBe(0);
  });

  it('дым поднимается вверх и сносится ветром', () => {
    const smoke = new SmokeField({ decay: 0, rise: 2, wind: v3(2, 0, 0) });
    smoke.emit(v3(0.5, 0.5, 0.5), 1);
    for (let i = 0; i < 60; i++) smoke.step(1 / 30);

    // Через две секунды: вверх примерно на четыре метра, вбок на четыре.
    const clouds = [...smoke.clouds()];
    expect(clouds.length).toBe(1);
    expect(clouds[0].position.y).toBeGreaterThan(3);
    expect(clouds[0].position.x).toBeGreaterThan(3);
    expect(smoke.densityAt(v3(0.5, 0.5, 0.5))).toBe(0);
  });

  it('число ячеек не растёт бесконечно', () => {
    const smoke = new SmokeField({ maxCells: 64, decay: 0 });
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 5000; i++) {
      smoke.emit(v3(rnd() * 200, rnd() * 40, rnd() * 200), 0.1 + rnd() * 0.9);
    }
    expect(smoke.size).toBeLessThanOrEqual(64);
  });

  it('разрушение даёт больше дыма, чем царапина', () => {
    const a = still();
    const b = still();
    a.emitFromDestruction(v3(0.5, 0.5, 0.5), 5);
    b.emitFromDestruction(v3(0.5, 0.5, 0.5), 5000);
    expect(b.densityAt(v3(0.5, 0.5, 0.5))).toBeGreaterThan(
      a.densityAt(v3(0.5, 0.5, 0.5)),
    );
    // И то и другое — дым, а не белая стена.
    expect(a.densityAt(v3(0.5, 0.5, 0.5))).toBeGreaterThan(0);
    expect(b.densityAt(v3(0.5, 0.5, 0.5))).toBeLessThanOrEqual(1);
  });

  it('три полупрозрачных облака не дают полной темноты', () => {
    const smoke = still();
    for (const x of [2, 4, 6]) smoke.emit(v3(x + 0.5, 1.5, 0.5), 0.35);
    const d = smoke.opacityAlong(v3(0, 1.5, 0.5), v3(10, 1.5, 0.5));
    expect(d).toBeGreaterThan(0.2);
    expect(d).toBeLessThan(0.9);
  });
});

describe('дым в симуляции', () => {
  function wall(): Simulation {
    const sim = new Simulation();
    const s = new VoxelShape({ sx: 60, sy: 40, sz: 20, voxelSize: 0.1, name: 'стена' });
    s.fill({}, Mat.Brick);
    s.transform = { position: v3(0, 0, 0), rotation: { x: 0, y: 0, z: 0, w: 1 } };
    sim.world.addBody(new Body({ kind: 'static', shapes: [s], name: 'стена' }));
    return sim;
  }

  it('взрыв поднимает дым сам, без ручных вызовов', () => {
    const sim = wall();
    expect(sim.smoke.size).toBe(0);
    const res = explode(sim.world, {
      center: v3(3, 2, 1),
      radius: 1.5,
      power: 1.4,
      cause: 'test',
    });
    expect(res.removed).toBeGreaterThan(0);
    expect(sim.smoke.size).toBeGreaterThan(0);
  });

  it('дым рассеивается по ходу симуляции', () => {
    const sim = wall();
    explode(sim.world, { center: v3(3, 2, 1), radius: 1.5, power: 1.4, cause: 'test' });
    const before = sim.smoke.size;
    for (let i = 0; i < 600; i++) sim.step(1 / 60);
    expect(sim.smoke.size).toBeLessThan(before);
  });

  it('рестарт уносит дым вместе с миром', () => {
    const sim = wall();
    explode(sim.world, { center: v3(3, 2, 1), radius: 1.5, power: 1.4, cause: 'test' });
    expect(sim.smoke.size).toBeGreaterThan(0);
    sim.reset();
    expect(sim.smoke.size).toBe(0);
  });
});
