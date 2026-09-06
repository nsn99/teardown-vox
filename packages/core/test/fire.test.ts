import { describe, expect, it } from 'vitest';
import { FireSystem, Mat, VoxelShape, v3 } from '@tvox/core';
import { VS, makeShape, voxelCenter, worldWith } from './helpers.js';

function burn(fire: FireSystem, world: ReturnType<typeof worldWith>['world'], seconds: number, dt = 1 / 30) {
  const steps = Math.round(seconds / dt);
  let ignited = 0;
  let removed = 0;
  for (let i = 0; i < steps; i++) {
    const r = fire.step(world, dt);
    ignited += r.ignited;
    removed += r.removed;
  }
  return { ignited, removed };
}

function woodWall(sx = 24, sy = 12, sz = 3): VoxelShape {
  const s = makeShape(sx, sy, sz);
  s.fill({}, Mat.Wood);
  return s;
}

describe('поджиг', () => {
  it('дерево горит, металл — нет', () => {
    const s = makeShape(4, 4, 4);
    s.set(1, 1, 1, Mat.Wood);
    s.set(2, 1, 1, Mat.Metal);
    const { body } = worldWith(s);
    const fire = new FireSystem();
    expect(fire.ignite(body, s, s.idx(1, 1, 1))).toBe(true);
    expect(fire.ignite(body, s, s.idx(2, 1, 1))).toBe(false);
    expect(fire.burningCount).toBe(1);
  });

  it('воздух не поджечь, повторный поджиг не удваивает', () => {
    const s = makeShape(4, 4, 4);
    s.set(1, 1, 1, Mat.Wood);
    const { body } = worldWith(s);
    const fire = new FireSystem();
    expect(fire.ignite(body, s, s.idx(0, 0, 0))).toBe(false);
    fire.ignite(body, s, s.idx(1, 1, 1));
    expect(fire.ignite(body, s, s.idx(1, 1, 1))).toBe(false);
    expect(fire.burningCount).toBe(1);
  });

  it('igniteArea зажигает поверхность в радиусе', () => {
    const s = woodWall();
    const { world } = worldWith(s);
    const fire = new FireSystem();
    const n = fire.igniteArea(world, voxelCenter(12, 11, 1), 0.35);
    expect(n).toBeGreaterThan(0);
    expect(fire.burningCount).toBe(n);
  });

  it('igniteArea мимо геометрии ничего не зажигает', () => {
    const s = woodWall();
    const { world } = worldWith(s);
    const fire = new FireSystem();
    expect(fire.igniteArea(world, v3(50, 50, 50), 1)).toBe(0);
  });

  it('глубоко внутри массива не горит — огню нужен воздух', () => {
    const s = makeShape(9, 9, 9);
    s.fill({}, Mat.Wood);
    const { world, body } = worldWith(s);
    const fire = new FireSystem();
    fire.ignite(body, s, s.idx(4, 4, 4));
    // Поджечь вручную можно, но соседи внутри массива не займутся.
    const before = fire.burningCount;
    burn(fire, world, 2);
    expect(fire.burningCount).toBeLessThanOrEqual(before + 6);
  });

  it('лимит одновременно горящих вокселей соблюдается', () => {
    const s = woodWall(40, 20, 3);
    const { world } = worldWith(s);
    const fire = new FireSystem({ maxBurning: 12 });
    fire.igniteArea(world, voxelCenter(20, 19, 1), 1.5);
    burn(fire, world, 5);
    expect(fire.burningCount).toBeLessThanOrEqual(12);
  });
});

describe('распространение', () => {
  it('огонь расползается по деревянной стене', () => {
    const s = woodWall();
    const { world, body } = worldWith(s);
    const fire = new FireSystem({ seed: 1 });
    fire.ignite(body, s, s.idx(12, 11, 1));
    const before = fire.burningCount;
    burn(fire, world, 6);
    expect(fire.burningCount).toBeGreaterThan(before);
  });

  it('огонь не перекидывается на металл', () => {
    const s = makeShape(20, 6, 3);
    s.fill({}, Mat.Metal);
    s.set(10, 5, 1, Mat.Wood);
    const { world, body } = worldWith(s);
    const fire = new FireSystem({ seed: 3 });
    fire.ignite(body, s, s.idx(10, 5, 1));
    burn(fire, world, 20);
    for (let i = 0; i < s.data.length; i++) {
      if (s.data[i] === Mat.Metal) expect(fire.isBurning(s, i)).toBe(false);
    }
  });

  it('дерево обугливается, потом исчезает', () => {
    const s = makeShape(3, 3, 3);
    s.set(1, 1, 1, Mat.Wood);
    const { world, body } = worldWith(s);
    const fire = new FireSystem();
    fire.ignite(body, s, s.idx(1, 1, 1));

    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      fire.step(world, 1 / 30);
      seen.add(s.get(1, 1, 1));
    }
    // Обязательная промежуточная стадия: уголь, а не мгновенное исчезновение.
    expect(seen.has(Mat.Charred)).toBe(true);
    expect(s.get(1, 1, 1)).toBe(Mat.Air);
    expect(fire.burningCount).toBe(0);
  });

  it('ветер смещает фронт по своему направлению', () => {
    const run = (wind: ReturnType<typeof v3>) => {
      const s = woodWall(41, 6, 3);
      const { world, body } = worldWith(s);
      const fire = new FireSystem({ seed: 11, wind, windStrength: 0.95, upwardBias: 1 });
      fire.ignite(body, s, s.idx(20, 5, 1));
      burn(fire, world, 4);
      let minX = 41;
      let maxX = -1;
      for (let i = 0; i < s.data.length; i++) {
        if (!fire.isBurning(s, i)) continue;
        const c = s.coords(i);
        minX = Math.min(minX, c.x);
        maxX = Math.max(maxX, c.x);
      }
      return { minX, maxX };
    };
    const plus = run(v3(1, 0, 0));
    const minus = run(v3(-1, 0, 0));
    expect(plus.maxX - 20).toBeGreaterThan(20 - plus.minX);
    expect(20 - minus.minX).toBeGreaterThan(minus.maxX - 20);
  });

  it('детерминизм: одинаковый сид — одинаковый пожар', () => {
    const run = () => {
      const s = woodWall();
      const { world, body } = worldWith(s);
      const fire = new FireSystem({ seed: 777 });
      fire.ignite(body, s, s.idx(12, 11, 1));
      burn(fire, world, 5);
      return [...s.data];
    };
    expect(run()).toEqual(run());
  });

  it('разные сиды дают разные пожары', () => {
    const run = (seed: number) => {
      const s = woodWall();
      const { world, body } = worldWith(s);
      const fire = new FireSystem({ seed });
      fire.ignite(body, s, s.idx(12, 11, 1));
      burn(fire, world, 12);
      return [...s.data];
    };
    expect(run(1)).not.toEqual(run(999));
  });
});

describe('тушение', () => {
  it('огнетушитель гасит огонь и оставляет мокрое пятно', () => {
    const s = woodWall();
    const { world, body } = worldWith(s);
    const fire = new FireSystem({ seed: 5 });
    fire.ignite(body, s, s.idx(12, 11, 1));
    burn(fire, world, 1);
    expect(fire.burningCount).toBeGreaterThan(0);

    fire.extinguish(world, voxelCenter(12, 11, 1), 1.2, 2);
    expect(fire.burningCount).toBe(0);
    expect(fire.isWet(s, s.idx(12, 11, 1))).toBe(true);
  });

  it('мокрый воксель не поджечь', () => {
    const s = woodWall();
    const { world, body } = worldWith(s);
    const fire = new FireSystem();
    fire.extinguish(world, voxelCenter(12, 11, 1), 0.3, 1);
    expect(fire.ignite(body, s, s.idx(12, 11, 1))).toBe(false);
  });

  it('влага испаряется, и материал снова горюч', () => {
    const s = woodWall();
    const { world, body } = worldWith(s);
    const fire = new FireSystem({ wetDuration: 1 });
    fire.extinguish(world, voxelCenter(12, 11, 1), 0.3, 1);
    burn(fire, world, 1.5);
    expect(fire.isWet(s, s.idx(12, 11, 1))).toBe(false);
    expect(fire.ignite(body, s, s.idx(12, 11, 1))).toBe(true);
  });

  it('слабая струя только сбивает жар, не туша полностью', () => {
    const s = woodWall();
    const { world, body } = worldWith(s);
    const fire = new FireSystem({ seed: 8 });
    fire.ignite(body, s, s.idx(12, 11, 1), 1);
    const doused = fire.extinguish(world, voxelCenter(12, 11, 1), 0.15, 0.05);
    expect(doused).toBe(0);
    expect(fire.burningCount).toBe(1);
  });
});

describe('жизненный цикл', () => {
  it('reset тушит всё', () => {
    const s = woodWall();
    const { body } = worldWith(s);
    const fire = new FireSystem();
    fire.ignite(body, s, s.idx(12, 11, 1));
    fire.reset();
    expect(fire.burningCount).toBe(0);
  });

  it('исчезновение тела снимает его огонь с учёта', () => {
    const s = woodWall(6, 6, 3);
    const { world, body } = worldWith(s);
    const fire = new FireSystem();
    fire.ignite(body, s, s.idx(3, 5, 1));
    world.removeBody(body);
    fire.step(world, 0.1);
    expect(fire.burningCount).toBe(0);
  });

  it('горящие точки отдаются в мировых координатах', () => {
    const s = woodWall(6, 6, 3);
    const { body } = worldWith(s);
    const fire = new FireSystem();
    fire.ignite(body, s, s.idx(3, 5, 1));
    const pts = [...fire.burningPoints()];
    expect(pts).toHaveLength(1);
    expect(pts[0].position.x).toBeCloseTo(3.5 * VS, 9);
    expect(pts[0].heat).toBeGreaterThan(0);
  });

  it('сгоревший воксель шлёт событие', () => {
    const s = makeShape(3, 3, 3);
    s.set(1, 1, 1, Mat.Wood);
    const { world, body } = worldWith(s);
    const fire = new FireSystem();
    let out = 0;
    world.events.on('fire:burnedOut', () => out++);
    fire.ignite(body, s, s.idx(1, 1, 1));
    burn(fire, world, 10);
    expect(out).toBe(1);
  });
});
