import { describe, expect, it } from 'vitest';
import {
  Mat,
  carve,
  explode,
  isSurface,
  paint,
  quatFromAxisAngle,
  v3,
} from '@tvox/core';
import { VS, countMaterial, makeShape, voxelCenter, worldWith } from './helpers.js';

const TOOL = {
  sledge: 0.35,
  torch: 0.75,
  charge: 1.2,
} as const;

describe('carve: модель «сила против прочности»', () => {
  it('кувалда сносит дерево', () => {
    const s = makeShape(20, 20, 20);
    s.fill({}, Mat.Wood);
    const { world } = worldWith(s);
    const before = s.solidVoxels;
    carve(world, { kind: 'sphere', center: voxelCenter(10, 10, 10), radius: 0.3 }, {
      power: TOOL.sledge,
      damage: 999,
      cause: 'sledge',
    });
    expect(s.solidVoxels).toBeLessThan(before);
  });

  it('кувалда НЕ берёт металл, сколько ни бей', () => {
    const s = makeShape(20, 20, 20);
    s.fill({}, Mat.Metal);
    const { world } = worldWith(s);
    for (let i = 0; i < 200; i++) {
      carve(world, { kind: 'sphere', center: voxelCenter(10, 10, 10), radius: 0.3 }, {
        power: TOOL.sledge,
        damage: 50,
        cause: 'sledge',
      });
    }
    expect(s.solidVoxels).toBe(20 * 20 * 20);
  });

  it('паяльная лампа металл берёт', () => {
    const s = makeShape(20, 20, 20);
    s.fill({}, Mat.Metal);
    const { world } = worldWith(s);
    let removed = 0;
    for (let i = 0; i < 40; i++) {
      removed += carve(world, { kind: 'sphere', center: voxelCenter(10, 10, 10), radius: 0.25 }, {
        power: TOOL.torch,
        damage: 40,
        cause: 'torch',
      }).removed;
    }
    expect(removed).toBeGreaterThan(0);
  });

  it('фундамент неразрушим даже зарядом', () => {
    const s = makeShape(10, 10, 10);
    s.fill({}, Mat.Foundation);
    const { world } = worldWith(s);
    const res = explode(world, { center: voxelCenter(5, 5, 5), radius: 1, power: 5 });
    expect(res.removed).toBe(0);
    expect(s.solidVoxels).toBe(1000);
  });

  it('урон копится: один слабый удар не убивает воксель, серия — убивает', () => {
    const s = makeShape(5, 5, 5);
    s.set(2, 2, 2, Mat.Concrete);
    const { world } = worldWith(s);
    const brush = { kind: 'sphere' as const, center: voxelCenter(2, 2, 2), radius: 0.05 };
    const first = carve(world, brush, { power: 0.9, damage: 5 });
    expect(first.removed).toBe(0);
    expect(first.damaged).toBe(1);
    let guard = 0;
    while (s.get(2, 2, 2) !== Mat.Air && guard++ < 100) {
      carve(world, brush, { power: 0.9, damage: 5 });
    }
    expect(s.get(2, 2, 2)).toBe(Mat.Air);
    expect(guard).toBeGreaterThan(1);
  });

  it('мгновенный режим сносит без накопления', () => {
    const s = makeShape(5, 5, 5);
    s.set(2, 2, 2, Mat.Concrete);
    const { world } = worldWith(s);
    const res = carve(world, { kind: 'sphere', center: voxelCenter(2, 2, 2), radius: 0.05 }, {
      power: 0.9,
      damage: 0,
      instant: true,
    });
    expect(res.removed).toBe(1);
  });

  it('защищённые материалы не трогаются', () => {
    const s = makeShape(6, 6, 6);
    s.fill({}, Mat.Wood);
    s.set(3, 3, 3, Mat.Loot);
    const { world } = worldWith(s);
    explode(world, {
      center: voxelCenter(3, 3, 3),
      radius: 1,
      power: 3,
      protect: new Set([Mat.Loot]),
    });
    expect(s.get(3, 3, 3)).toBe(Mat.Loot);
    expect(s.get(1, 3, 3)).toBe(Mat.Air);
  });

  it('лимит вокселей за вызов соблюдается', () => {
    const s = makeShape(30, 30, 30);
    s.fill({}, Mat.Wood);
    const { world } = worldWith(s);
    const res = carve(world, { kind: 'sphere', center: voxelCenter(15, 15, 15), radius: 1 }, {
      power: 1,
      damage: 0,
      instant: true,
      maxVoxels: 10,
    });
    expect(res.removed).toBeLessThanOrEqual(10);
  });

  it('игнор-список тел работает', () => {
    const s = makeShape(8, 8, 8);
    s.fill({}, Mat.Wood);
    const { world, body } = worldWith(s);
    const res = explode(world, {
      center: voxelCenter(4, 4, 4),
      radius: 0.5,
      ignoreBodies: new Set([body.id]),
    });
    expect(res.removed).toBe(0);
  });

  it('детерминизм: два одинаковых прогона совпадают воксель в воксель', () => {
    const run = () => {
      const s = makeShape(24, 24, 24);
      s.fill({}, Mat.Brick);
      const { world } = worldWith(s);
      explode(world, { center: voxelCenter(12, 12, 12), radius: 0.7, power: 1.5 });
      return [...s.data];
    };
    expect(run()).toEqual(run());
  });
});

describe('формы кистей', () => {
  it('сфера снимает примерно шар', () => {
    const s = makeShape(24, 24, 24);
    s.fill({}, Mat.Wood);
    const { world } = worldWith(s);
    const r = 0.5;
    const res = carve(world, { kind: 'sphere', center: voxelCenter(12, 12, 12), radius: r }, {
      power: 1,
      damage: 0,
      instant: true,
      falloff: 'none',
    });
    const expected = (4 / 3) * Math.PI * (r / VS) ** 3;
    expect(res.removed).toBeGreaterThan(expected * 0.75);
    expect(res.removed).toBeLessThan(expected * 1.25);
  });

  it('бокс снимает параллелепипед', () => {
    const s = makeShape(24, 24, 24);
    s.fill({}, Mat.Wood);
    const { world } = worldWith(s);
    const res = carve(
      world,
      { kind: 'box', center: voxelCenter(12, 12, 12), halfExtents: v3(0.25, 0.15, 0.05) },
      { power: 1, damage: 0, instant: true, falloff: 'none' },
    );
    // 5 × 3 × 1 вокселя.
    expect(res.removed).toBe(5 * 3 * 1);
  });

  it('повёрнутый бокс режет по своей оси', () => {
    const s = makeShape(24, 24, 24);
    s.fill({}, Mat.Wood);
    const { world } = worldWith(s);
    const res = carve(
      world,
      {
        kind: 'box',
        center: voxelCenter(12, 12, 12),
        halfExtents: v3(0.55, 0.05, 0.05),
        rotation: quatFromAxisAngle(v3(0, 1, 0), Math.PI / 2),
      },
      { power: 1, damage: 0, instant: true, falloff: 'none' },
    );
    const bounds = s.solidBounds()!;
    expect(res.removed).toBeGreaterThan(8);
    expect(bounds).toBeTruthy();
    // Разрез идёт вдоль Z (полудлина 0.55 м = 5.5 вокселя от центра),
    // значит по X дыра остаётся узкой.
    expect(s.get(12, 12, 8)).toBe(Mat.Air);
    expect(s.get(12, 12, 16)).toBe(Mat.Air);
    expect(s.get(12, 12, 4)).toBe(Mat.Wood);
    expect(s.get(5, 12, 12)).toBe(Mat.Wood);
  });

  it('капсула прорезает коридор между двумя точками', () => {
    const s = makeShape(24, 8, 8);
    s.fill({}, Mat.Wood);
    const { world } = worldWith(s);
    carve(
      world,
      { kind: 'capsule', a: voxelCenter(2, 4, 4), b: voxelCenter(20, 4, 4), radius: 0.12 },
      { power: 1, damage: 0, instant: true, falloff: 'none' },
    );
    expect(s.get(2, 4, 4)).toBe(Mat.Air);
    expect(s.get(11, 4, 4)).toBe(Mat.Air);
    expect(s.get(20, 4, 4)).toBe(Mat.Air);
    expect(s.get(11, 0, 0)).toBe(Mat.Wood);
  });

  it('вырожденная капсула ведёт себя как сфера', () => {
    const s = makeShape(10, 10, 10);
    s.fill({}, Mat.Wood);
    const { world } = worldWith(s);
    const res = carve(
      world,
      { kind: 'capsule', a: voxelCenter(5, 5, 5), b: voxelCenter(5, 5, 5), radius: 0.15 },
      { power: 1, damage: 0, instant: true, falloff: 'none' },
    );
    expect(res.removed).toBeGreaterThan(0);
  });

  it('конус расширяется от вершины — дробовик', () => {
    const s = makeShape(30, 20, 20);
    s.fill({}, Mat.Plank);
    const { world } = worldWith(s);
    carve(
      world,
      {
        kind: 'cone',
        apex: voxelCenter(1, 10, 10),
        direction: v3(1, 0, 0),
        length: 2,
        angle: 0.35,
      },
      { power: 1, damage: 0, instant: true, falloff: 'none' },
    );
    let nearCount = 0;
    let farCount = 0;
    for (let y = 0; y < 20; y++) {
      for (let z = 0; z < 20; z++) {
        if (s.get(3, y, z) === Mat.Air) nearCount++;
        if (s.get(18, y, z) === Mat.Air) farCount++;
      }
    }
    expect(farCount).toBeGreaterThan(nearCount);
  });

  it('за конусом материал цел', () => {
    const s = makeShape(40, 20, 20);
    s.fill({}, Mat.Plank);
    const { world } = worldWith(s);
    carve(
      world,
      { kind: 'cone', apex: voxelCenter(1, 10, 10), direction: v3(1, 0, 0), length: 1, angle: 0.3 },
      { power: 1, damage: 0, instant: true, falloff: 'none' },
    );
    expect(s.get(35, 10, 10)).toBe(Mat.Plank);
  });
});

describe('ослабление', () => {
  it('квадратичное ослабление режет меньше линейного', () => {
    const build = () => {
      const s = makeShape(24, 24, 24);
      s.fill({}, Mat.Brick);
      return { s, ...worldWith(s) };
    };
    const lin = build();
    const quad = build();
    const brush = { kind: 'sphere' as const, center: voxelCenter(12, 12, 12), radius: 0.6 };
    const a = carve(lin.world, brush, { power: 1, damage: 0, instant: true, falloff: 'linear' });
    const b = carve(quad.world, brush, { power: 1, damage: 0, instant: true, falloff: 'quadratic' });
    expect(b.removed).toBeLessThan(a.removed);
  });

  it('без ослабления снимает больше, чем с линейным', () => {
    const build = () => {
      const s = makeShape(24, 24, 24);
      s.fill({}, Mat.Brick);
      return { s, ...worldWith(s) };
    };
    const none = build();
    const lin = build();
    const brush = { kind: 'sphere' as const, center: voxelCenter(12, 12, 12), radius: 0.6 };
    const a = carve(none.world, brush, { power: 1, damage: 0, instant: true, falloff: 'none' });
    const b = carve(lin.world, brush, { power: 1, damage: 0, instant: true, falloff: 'linear' });
    expect(a.removed).toBeGreaterThan(b.removed);
  });
});

describe('события и учёт', () => {
  it('шлёт voxels:removed с материалами и причиной', () => {
    const s = makeShape(10, 10, 10);
    s.fill({}, Mat.Wood);
    const { world } = worldWith(s);
    const seen: string[] = [];
    let count = 0;
    world.events.on('voxels:removed', (e) => {
      seen.push(e.cause);
      count += e.count;
      expect(e.materials.get(Mat.Wood)).toBeGreaterThan(0);
    });
    const res = explode(world, { center: voxelCenter(5, 5, 5), radius: 0.3, cause: 'charge' });
    expect(seen).toEqual(['charge']);
    expect(count).toBe(res.removed);
  });

  it('обломки собираются с ограничением', () => {
    const s = makeShape(30, 30, 30);
    s.fill({}, Mat.Wood);
    const { world } = worldWith(s);
    const res = explode(world, { center: voxelCenter(15, 15, 15), radius: 1.2, power: 3 });
    expect(res.removed).toBeGreaterThan(256);
    expect(res.debris.length).toBe(256);
  });

  it('центр результата рядом с центром взрыва', () => {
    const s = makeShape(20, 20, 20);
    s.fill({}, Mat.Wood);
    const { world } = worldWith(s);
    const c = voxelCenter(10, 10, 10);
    const res = explode(world, { center: c, radius: 0.4 });
    expect(Math.abs(res.center.x - c.x)).toBeLessThan(0.1);
  });

  it('промах даёт центр кисти', () => {
    const s = makeShape(4, 4, 4);
    const { world } = worldWith(s);
    const res = explode(world, { center: v3(50, 50, 50), radius: 0.4 });
    expect(res.removed).toBe(0);
    expect(res.center).toEqual(v3(50, 50, 50));
  });
});

describe('баллончик', () => {
  it('красит только поверхность и не меняет материал', () => {
    const s = makeShape(10, 10, 10);
    s.fill({}, Mat.Concrete);
    const { world } = worldWith(s);
    const n = paint(world, v3(0, 0.5, 0.5), 0.25, 3);
    expect(n).toBeGreaterThan(0);
    expect(countMaterial(s, Mat.Concrete)).toBe(1000);
    expect(s.paint.size).toBe(n);
    for (const idx of s.paint.keys()) {
      const c = s.coords(idx);
      expect(isSurface(s, c.x, c.y, c.z)).toBe(true);
    }
  });

  it('повторная покраска тем же цветом ничего не добавляет', () => {
    const s = makeShape(10, 10, 10);
    s.fill({}, Mat.Concrete);
    const { world } = worldWith(s);
    const n1 = paint(world, v3(0, 0.5, 0.5), 0.25, 3);
    const n2 = paint(world, v3(0, 0.5, 0.5), 0.25, 3);
    expect(n1).toBeGreaterThan(0);
    expect(n2).toBe(0);
  });

  it('покраска мимо геометрии ничего не делает', () => {
    const s = makeShape(4, 4, 4);
    s.fill({}, Mat.Concrete);
    const { world } = worldWith(s);
    expect(paint(world, v3(20, 20, 20), 0.5, 1)).toBe(0);
  });
});
