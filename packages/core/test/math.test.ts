import { describe, expect, it } from 'vitest';
import {
  aabbContains,
  aabbEmpty,
  aabbExpand,
  aabbIsEmpty,
  aabbOverlaps,
  add,
  clamp,
  composeTransform,
  cross,
  distance,
  dot,
  inverseTransformDirection,
  inverseTransformPoint,
  length,
  lengthSq,
  lerp,
  makeRng,
  normalize,
  quatConjugate,
  quatFromAxisAngle,
  quatFromEulerYXZ,
  quatIdentity,
  quatMultiply,
  quatNormalize,
  rayAabb,
  rotateVec,
  rotateVecInverse,
  scale,
  sub,
  transformDirection,
  transformIdentity,
  transformPoint,
  v3,
} from '@tvox/core';

const near = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);
const nearVec = (a: { x: number; y: number; z: number }, b: [number, number, number], eps = 1e-9) => {
  near(a.x, b[0], eps);
  near(a.y, b[1], eps);
  near(a.z, b[2], eps);
};

describe('векторы', () => {
  it('складывает, вычитает, масштабирует', () => {
    nearVec(add(v3(1, 2, 3), v3(4, 5, 6)), [5, 7, 9]);
    nearVec(sub(v3(4, 5, 6), v3(1, 2, 3)), [3, 3, 3]);
    nearVec(scale(v3(1, -2, 3), 2), [2, -4, 6]);
  });

  it('считает скалярное и векторное произведение', () => {
    expect(dot(v3(1, 0, 0), v3(0, 1, 0))).toBe(0);
    expect(dot(v3(1, 2, 3), v3(4, 5, 6))).toBe(32);
    nearVec(cross(v3(1, 0, 0), v3(0, 1, 0)), [0, 0, 1]);
  });

  it('длина и нормализация', () => {
    expect(lengthSq(v3(3, 4, 0))).toBe(25);
    expect(length(v3(3, 4, 0))).toBe(5);
    nearVec(normalize(v3(0, 5, 0)), [0, 1, 0]);
    expect(distance(v3(0, 0, 0), v3(0, 0, 7))).toBe(7);
  });

  it('нормализация нулевого вектора возвращает ноль, а не NaN', () => {
    nearVec(normalize(v3(0, 0, 0)), [0, 0, 0]);
  });

  it('lerp', () => {
    nearVec(lerp(v3(0, 0, 0), v3(10, 20, 30), 0.5), [5, 10, 15]);
  });

  it('clamp', () => {
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});

describe('кватернионы', () => {
  it('единичный кватернион ничего не поворачивает', () => {
    nearVec(rotateVec(quatIdentity(), v3(1, 2, 3)), [1, 2, 3]);
  });

  it('поворот на 90° вокруг Y переводит +X в -Z', () => {
    const q = quatFromAxisAngle(v3(0, 1, 0), Math.PI / 2);
    nearVec(rotateVec(q, v3(1, 0, 0)), [0, 0, -1], 1e-12);
  });

  it('обратный поворот возвращает исходный вектор', () => {
    const q = quatFromEulerYXZ(0.7, -0.3, 0.15);
    const v = v3(1.3, -2.2, 0.7);
    nearVec(rotateVecInverse(q, rotateVec(q, v)), [v.x, v.y, v.z], 1e-12);
  });

  it('умножение кватернионов эквивалентно последовательному повороту', () => {
    const a = quatFromAxisAngle(v3(0, 1, 0), 0.4);
    const b = quatFromAxisAngle(v3(1, 0, 0), 0.9);
    const v = v3(0.3, 1.1, -0.6);
    const seq = rotateVec(a, rotateVec(b, v));
    const combined = rotateVec(quatMultiply(a, b), v);
    nearVec(seq, [combined.x, combined.y, combined.z], 1e-12);
  });

  it('нормализация и сопряжение', () => {
    const q = quatNormalize({ x: 2, y: 0, z: 0, w: 0 });
    near(Math.hypot(q.x, q.y, q.z, q.w), 1);
    expect(quatNormalize({ x: 0, y: 0, z: 0, w: 0 })).toEqual(quatIdentity());
    const c = quatConjugate({ x: 1, y: 2, z: 3, w: 4 });
    expect(c).toEqual({ x: -1, y: -2, z: -3, w: 4 });
  });

  it('поворот вокруг нулевой оси не роняет вычисления', () => {
    const q = quatFromAxisAngle(v3(0, 0, 0), 1);
    expect(Number.isFinite(q.w)).toBe(true);
  });
});

describe('трансформы', () => {
  const t = {
    position: v3(10, 0, 0),
    rotation: quatFromAxisAngle(v3(0, 1, 0), Math.PI / 2),
  };

  it('прямое и обратное преобразование точки взаимно обратны', () => {
    const p = v3(1, 2, 3);
    nearVec(inverseTransformPoint(t, transformPoint(t, p)), [1, 2, 3], 1e-12);
  });

  it('направление не сдвигается позицией', () => {
    const d = transformDirection(t, v3(1, 0, 0));
    nearVec(d, [0, 0, -1], 1e-12);
    nearVec(inverseTransformDirection(t, d), [1, 0, 0], 1e-12);
  });

  it('композиция трансформов эквивалентна последовательному применению', () => {
    const child = { position: v3(0, 1, 0), rotation: quatFromAxisAngle(v3(1, 0, 0), 0.3) };
    const composed = composeTransform(t, child);
    const p = v3(0.5, -0.2, 0.9);
    const seq = transformPoint(t, transformPoint(child, p));
    nearVec(transformPoint(composed, p), [seq.x, seq.y, seq.z], 1e-9);
  });

  it('единичный трансформ ничего не меняет', () => {
    const id = transformIdentity();
    nearVec(transformPoint(id, v3(4, 5, 6)), [4, 5, 6]);
  });
});

describe('AABB', () => {
  it('пустой бокс определяется как пустой', () => {
    expect(aabbIsEmpty(aabbEmpty())).toBe(true);
  });

  it('расширение и попадание точки', () => {
    const box = aabbEmpty();
    aabbExpand(box, v3(0, 0, 0));
    aabbExpand(box, v3(2, 2, 2));
    expect(aabbIsEmpty(box)).toBe(false);
    expect(aabbContains(box, v3(1, 1, 1))).toBe(true);
    expect(aabbContains(box, v3(3, 1, 1))).toBe(false);
  });

  it('пересечение боксов', () => {
    const a = { min: v3(0, 0, 0), max: v3(1, 1, 1) };
    const b = { min: v3(0.5, 0.5, 0.5), max: v3(2, 2, 2) };
    const c = { min: v3(5, 5, 5), max: v3(6, 6, 6) };
    expect(aabbOverlaps(a, b)).toBe(true);
    expect(aabbOverlaps(a, c)).toBe(false);
  });
});

describe('луч против AABB', () => {
  const box = { min: v3(0, 0, 0), max: v3(1, 1, 1) };

  it('пробивает бокс насквозь', () => {
    const hit = rayAabb(v3(-1, 0.5, 0.5), v3(1, 0, 0), box);
    expect(hit).not.toBeNull();
    near(hit![0], 1);
    near(hit![1], 2);
  });

  it('мимо бокса — null', () => {
    expect(rayAabb(v3(-1, 5, 0.5), v3(1, 0, 0), box)).toBeNull();
  });

  it('луч, параллельный оси и вне слоя, не попадает', () => {
    expect(rayAabb(v3(2, 0.5, 0.5), v3(0, 1, 0), box)).toBeNull();
  });

  it('луч, параллельный оси и внутри слоя, попадает', () => {
    expect(rayAabb(v3(0.5, -1, 0.5), v3(0, 1, 0), box)).not.toBeNull();
  });

  it('старт внутри бокса даёт отрицательный tMin', () => {
    const hit = rayAabb(v3(0.5, 0.5, 0.5), v3(1, 0, 0), box);
    expect(hit![0]).toBeLessThan(0);
  });
});

describe('детерминированный PRNG', () => {
  it('один сид — одна последовательность', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it('разные сиды расходятся', () => {
    const a = makeRng(1);
    const b = makeRng(2);
    expect(a()).not.toBe(b());
  });

  it('значения лежат в [0,1)', () => {
    const r = makeRng(7);
    for (let i = 0; i < 1000; i++) {
      const x = r();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
