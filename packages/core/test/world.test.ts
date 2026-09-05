import { describe, expect, it } from 'vitest';
import {
  Body,
  EventBus,
  Mat,
  VoxelShape,
  VoxelWorld,
  __resetBodyIds,
  __resetShapeIds,
  v3,
} from '@tvox/core';
import { VS, makeShape, staticBody } from './helpers.js';

describe('шина событий', () => {
  it('доставляет подписчикам и снимает подписку', () => {
    const bus = new EventBus<{ ping: number }>();
    const seen: number[] = [];
    const off = bus.on('ping', (n) => seen.push(n));
    bus.emit('ping', 1);
    off();
    bus.emit('ping', 2);
    expect(seen).toEqual([1]);
    expect(bus.listenerCount('ping')).toBe(0);
  });

  it('once срабатывает ровно раз', () => {
    const bus = new EventBus<{ ping: number }>();
    let n = 0;
    bus.once('ping', () => n++);
    bus.emit('ping', 1);
    bus.emit('ping', 1);
    expect(n).toBe(1);
  });

  it('отписка во время доставки не ломает обход', () => {
    const bus = new EventBus<{ ping: number }>();
    const seen: string[] = [];
    const offB = bus.on('ping', () => seen.push('b'));
    bus.on('ping', () => {
      seen.push('a');
      offB();
    });
    bus.emit('ping', 1);
    expect(seen).toContain('a');
  });

  it('emit без подписчиков безопасен, clear чистит всё', () => {
    const bus = new EventBus<{ ping: number }>();
    expect(() => bus.emit('ping', 1)).not.toThrow();
    bus.on('ping', () => {});
    bus.clear();
    expect(bus.listenerCount('ping')).toBe(0);
  });

  it('off по неизвестному обработчику безопасен', () => {
    const bus = new EventBus<{ ping: number }>();
    expect(() => bus.off('ping', () => {})).not.toThrow();
  });
});

describe('мир', () => {
  it('добавление и удаление тела шлёт события', () => {
    const world = new VoxelWorld();
    const added: number[] = [];
    const removed: number[] = [];
    world.events.on('body:added', (e) => added.push(e.body.id));
    world.events.on('body:removed', (e) => removed.push(e.body.id));
    const b = world.addBody(staticBody([makeShape(2, 2, 2)]));
    expect(added).toEqual([b.id]);
    expect(world.removeBody(b)).toBe(true);
    expect(world.removeBody(b)).toBe(false);
    expect(removed).toEqual([b.id]);
  });

  it('индекс форм связывает форму с телом', () => {
    const world = new VoxelWorld();
    const s = makeShape(2, 2, 2);
    const b = world.addBody(staticBody([s]));
    expect(world.bodyOfShape(s)).toBe(b);

    const extra = makeShape(2, 2, 2);
    b.addShape(extra);
    expect(world.bodyOfShape(extra)).toBeUndefined();
    world.reindex();
    expect(world.bodyOfShape(extra)).toBe(b);
  });

  it('разделяет статические и динамические тела', () => {
    const world = new VoxelWorld();
    world.addBody(staticBody([makeShape(2, 2, 2)]));
    world.addBody(new Body({ kind: 'dynamic', shapes: [makeShape(2, 2, 2)] }));
    expect(world.staticBodies).toHaveLength(1);
    expect(world.dynamicBodies).toHaveLength(1);
  });

  it('считает суммарное число вокселей', () => {
    const world = new VoxelWorld();
    const s = makeShape(3, 3, 3);
    s.fill({}, Mat.Wood);
    world.addBody(staticBody([s]));
    expect(world.totalSolidVoxels()).toBe(27);
  });

  it('сборщик мусора убирает пустые динамические тела', () => {
    const world = new VoxelWorld();
    const s = makeShape(2, 2, 2);
    const dyn = world.addBody(new Body({ kind: 'dynamic', shapes: [s] }));
    const stat = world.addBody(staticBody([makeShape(2, 2, 2)]));
    expect(world.collectGarbage()).toBe(1);
    expect(world.bodies.has(dyn.id)).toBe(false);
    // Пустое статическое тело — это часть уровня, его не трогаем.
    expect(world.bodies.has(stat.id)).toBe(true);
  });

  it('гравитация по умолчанию направлена вниз', () => {
    expect(new VoxelWorld().gravity).toEqual(v3(0, -9.81, 0));
    expect(new VoxelWorld({ gravity: v3(0, -1, 0) }).gravity.y).toBe(-1);
  });
});

describe('тело', () => {
  it('добавляет и убирает формы', () => {
    const b = new Body();
    const s = makeShape(2, 2, 2);
    b.addShape(s);
    expect(b.shapes).toHaveLength(1);
    expect(b.removeShape(s)).toBe(true);
    expect(b.removeShape(s)).toBe(false);
  });

  it('масса складывается из форм', () => {
    const a = makeShape(2, 2, 2);
    a.fill({}, Mat.Wood);
    const b = makeShape(2, 2, 2);
    b.fill({}, Mat.Wood);
    const body = new Body({ shapes: [a, b] });
    expect(body.mass()).toBeCloseTo(16 * 700 * 0.001, 9);
    expect(body.solidVoxels).toBe(16);
  });

  it('AABB учитывает позицию тела', () => {
    const s = makeShape(4, 4, 4);
    s.fill({}, Mat.Wood);
    const body = new Body({
      shapes: [s],
      transform: { position: v3(10, 0, 0), rotation: { x: 0, y: 0, z: 0, w: 1 } },
    });
    const box = body.aabb();
    expect(box.min.x).toBeCloseTo(10, 9);
    expect(box.max.x).toBeCloseTo(10 + 4 * VS, 9);
  });

  it('wake сбрасывает сон и таймер покоя', () => {
    const b = new Body({ kind: 'dynamic' });
    b.sleeping = true;
    b.restTime = 5;
    b.wake();
    expect(b.sleeping).toBe(false);
    expect(b.restTime).toBe(0);
  });

  it('переживает круговой рейс через JSON', () => {
    const s = makeShape(4, 3, 2);
    s.fill({ x0: 1, x1: 3 }, Mat.Brick);
    const body = new Body({
      kind: 'dynamic',
      shapes: [s],
      tags: ['loot', 'safe'],
      name: 'сейф',
      transform: { position: v3(1, 2, 3), rotation: { x: 0, y: 0, z: 0, w: 1 } },
    });
    const back = Body.fromJSON(JSON.parse(JSON.stringify(body.toJSON())));
    expect(back.name).toBe('сейф');
    expect(back.kind).toBe('dynamic');
    expect([...back.tags]).toEqual(['loot', 'safe']);
    expect(back.solidVoxels).toBe(body.solidVoxels);
    expect(back.transform.position).toEqual(v3(1, 2, 3));
  });
});

describe('идентификаторы', () => {
  it('сброс счётчиков делает id предсказуемыми', () => {
    __resetShapeIds();
    __resetBodyIds();
    const s = new VoxelShape({ sx: 1, sy: 1, sz: 1 });
    const b = new Body();
    expect(s.id).toBe(1);
    expect(b.id).toBe(1);
  });
});
