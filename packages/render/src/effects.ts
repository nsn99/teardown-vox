import * as THREE from 'three';
import { DebrisSample, MATERIALS, Vec3, makeRng } from '@tvox/core';

export interface ParticleOptions {
  /** Верхняя граница числа живых частиц. */
  capacity?: number;
  seed?: number;
  gravity?: number;
}

type Kind = 'debris' | 'spark' | 'smoke' | 'fire' | 'splash';

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
  r: number;
  g: number;
  b: number;
  kind: Kind;
}

const KIND_DRAG: Record<Kind, number> = {
  debris: 0.02,
  spark: 0.06,
  smoke: 0.9,
  fire: 0.7,
  splash: 0.1,
};

const KIND_BUOYANCY: Record<Kind, number> = {
  debris: 0,
  spark: 0,
  smoke: 1.6,
  fire: 2.4,
  splash: 0,
};

/**
 * Частицы: осколки, искры, дым, огонь, брызги.
 *
 * Одна система на всё, один буфер точек, фиксированный потолок. Цвет
 * осколка берётся из материала, который на самом деле сломали, —
 * кирпичная стена сыплется кирпичом, а не абстрактной серой пылью.
 */
export class ParticleSystem {
  readonly points: THREE.Points;
  private pool: Particle[] = [];
  private alive = 0;
  private capacity: number;
  private gravity: number;
  private rng: () => number;
  private positions: Float32Array;
  private colors: Float32Array;
  private sizes: Float32Array;

  constructor(opts: ParticleOptions = {}) {
    this.capacity = opts.capacity ?? 4000;
    this.gravity = opts.gravity ?? 9.81;
    this.rng = makeRng(opts.seed ?? 0xbeef);

    this.positions = new Float32Array(this.capacity * 3);
    this.colors = new Float32Array(this.capacity * 3);
    this.sizes = new Float32Array(this.capacity);

    for (let i = 0; i < this.capacity; i++) {
      this.pool.push({
        x: 0, y: 0, z: 0,
        vx: 0, vy: 0, vz: 0,
        life: 0, maxLife: 1, size: 1,
        r: 1, g: 1, b: 1,
        kind: 'debris',
      });
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    geom.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    geom.setDrawRange(0, 0);

    const material = new THREE.PointsMaterial({
      vertexColors: true,
      size: 0.08,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });

    this.points = new THREE.Points(geom, material);
    this.points.frustumCulled = false;
  }

  get count(): number {
    return this.alive;
  }

  private spawn(p: Partial<Particle> & { kind: Kind }): void {
    if (this.alive >= this.capacity) return;
    const slot = this.pool[this.alive++];
    Object.assign(slot, p);
    slot.life = slot.maxLife;
  }

  private rand(a: number, b: number): number {
    return a + this.rng() * (b - a);
  }

  /** Осколки на месте разрушения: цвет берём у сломанного материала. */
  emitDebris(samples: readonly DebrisSample[], power = 1): void {
    for (const d of samples) {
      const col = MATERIALS[d.material].color;
      this.spawn({
        kind: 'debris',
        x: d.position.x,
        y: d.position.y,
        z: d.position.z,
        vx: this.rand(-2, 2) * power,
        vy: this.rand(0.5, 4) * power,
        vz: this.rand(-2, 2) * power,
        maxLife: this.rand(0.6, 1.8),
        size: this.rand(0.04, 0.1),
        r: col[0] / 255,
        g: col[1] / 255,
        b: col[2] / 255,
      });
    }
  }

  emitSparks(at: Vec3, n = 12): void {
    for (let i = 0; i < n; i++) {
      this.spawn({
        kind: 'spark',
        x: at.x, y: at.y, z: at.z,
        vx: this.rand(-3, 3),
        vy: this.rand(0, 4),
        vz: this.rand(-3, 3),
        maxLife: this.rand(0.15, 0.5),
        size: this.rand(0.02, 0.05),
        r: 1, g: this.rand(0.65, 0.9), b: this.rand(0.1, 0.3),
      });
    }
  }

  emitSmoke(at: Vec3, n = 4, scale = 1): void {
    for (let i = 0; i < n; i++) {
      const grey = this.rand(0.18, 0.34);
      this.spawn({
        kind: 'smoke',
        x: at.x + this.rand(-0.2, 0.2),
        y: at.y,
        z: at.z + this.rand(-0.2, 0.2),
        vx: this.rand(-0.4, 0.4),
        vy: this.rand(0.3, 1.1),
        vz: this.rand(-0.4, 0.4),
        maxLife: this.rand(1.5, 3.5) * scale,
        size: this.rand(0.15, 0.4) * scale,
        r: grey, g: grey, b: grey * 1.05,
      });
    }
  }

  emitFire(at: Vec3, heat = 1): void {
    this.spawn({
      kind: 'fire',
      x: at.x + this.rand(-0.05, 0.05),
      y: at.y,
      z: at.z + this.rand(-0.05, 0.05),
      vx: this.rand(-0.2, 0.2),
      vy: this.rand(0.6, 1.6),
      vz: this.rand(-0.2, 0.2),
      maxLife: this.rand(0.25, 0.7),
      size: this.rand(0.08, 0.18),
      r: 1,
      g: this.rand(0.35, 0.7) * heat,
      b: this.rand(0.02, 0.12),
    });
  }

  emitSplash(at: Vec3, n = 10): void {
    for (let i = 0; i < n; i++) {
      this.spawn({
        kind: 'splash',
        x: at.x, y: at.y, z: at.z,
        vx: this.rand(-1.5, 1.5),
        vy: this.rand(1, 3),
        vz: this.rand(-1.5, 1.5),
        maxLife: this.rand(0.4, 1),
        size: this.rand(0.03, 0.08),
        r: 0.5, g: 0.72, b: 0.85,
      });
    }
  }

  step(dt: number): void {
    const live: Particle[] = [];
    const dead: Particle[] = [];

    for (let i = 0; i < this.alive; i++) {
      const p = this.pool[i];
      p.life -= dt;
      if (p.life <= 0) {
        dead.push(p);
        continue;
      }

      const drag = KIND_DRAG[p.kind];
      const buoy = KIND_BUOYANCY[p.kind];
      // Осколки и брызги падают, дым и огонь идут вверх.
      p.vy += (buoy > 0 ? buoy : -this.gravity) * dt;
      const k = Math.min(1, drag * dt * 20);
      p.vx -= p.vx * k;
      p.vz -= p.vz * k;
      if (buoy > 0) p.vy -= p.vy * k * 0.5;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      live.push(p);
    }

    for (let i = 0; i < live.length; i++) {
      const p = live[i];
      const t = p.life / p.maxLife;
      const fade = p.kind === 'smoke' ? t * 0.6 : t;
      this.positions[i * 3] = p.x;
      this.positions[i * 3 + 1] = p.y;
      this.positions[i * 3 + 2] = p.z;
      this.colors[i * 3] = p.r * fade;
      this.colors[i * 3 + 1] = p.g * fade;
      this.colors[i * 3 + 2] = p.b * fade;
      this.sizes[i] = p.size;
    }

    // Живые впереди, свободные слоты — в хвосте.
    this.pool = [...live, ...dead, ...this.pool.slice(this.alive)];
    this.alive = live.length;

    const geom = this.points.geometry;
    geom.setDrawRange(0, this.alive);
    (geom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (geom.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    (geom.getAttribute('size') as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    for (const p of this.pool) p.life = 0;
    this.alive = 0;
    this.points.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

/**
 * Динамический свет от очагов пожара. Ламп немного и они переиспользуются:
 * сотня источников света убьёт кадр быстрее, чем сам пожар — здание.
 */
export class FireLights {
  readonly group = new THREE.Group();
  private lights: THREE.PointLight[] = [];

  constructor(count = 6) {
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xff7a2a, 0, 14, 2);
      l.visible = false;
      this.lights.push(l);
      this.group.add(l);
    }
  }

  /** Расставляет лампы по самым жарким точкам. */
  update(points: Iterable<{ position: Vec3; heat: number }>, time: number): void {
    const best: { position: Vec3; heat: number }[] = [];
    for (const p of points) {
      if (best.length < this.lights.length) {
        best.push(p);
      } else {
        let minIdx = 0;
        for (let i = 1; i < best.length; i++) if (best[i].heat < best[minIdx].heat) minIdx = i;
        if (p.heat > best[minIdx].heat) best[minIdx] = p;
      }
    }
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const p = best[i];
      if (!p) {
        l.visible = false;
        continue;
      }
      l.visible = true;
      l.position.set(p.position.x, p.position.y + 0.2, p.position.z);
      // Мерцание: детерминированное, привязано к времени, без RNG в кадре.
      l.intensity = (2.2 + Math.sin(time * 11 + i * 2.3) * 0.5) * p.heat;
    }
  }
}
