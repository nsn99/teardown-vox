import { Vec3, distance, dot, makeRng, normalize, v3 } from './math.js';
import { Mat, material } from './materials.js';
import { VoxelShape } from './voxel-shape.js';
import { Body } from './body.js';
import { VoxelWorld } from './world.js';

export interface FireOptions {
  seed?: number;
  /** Топлива сгорает в секунду при жаре 1.0. */
  burnRate?: number;
  /** Жар, ниже которого горение прекращается. */
  extinguishHeat?: number;
  /** Базовая вероятность переброса на соседа в секунду при flammability=1. */
  spreadRate?: number;
  /** Множитель для соседа сверху — огонь идёт вверх охотнее. */
  upwardBias?: number;
  /** Верхняя граница числа горящих вокселей: защита от лавины. */
  maxBurning?: number;
  wind?: Vec3;
  /** Насколько ветер усиливает переброс по своему направлению. */
  windStrength?: number;
  /** Секунд, на которые вода блокирует возгорание. */
  wetDuration?: number;
}

const DEFAULTS = {
  seed: 0xf12e,
  burnRate: 6,
  extinguishHeat: 0.15,
  spreadRate: 1.6,
  upwardBias: 2.2,
  maxBurning: 4000,
  wind: v3(0, 0, 0),
  windStrength: 0.8,
  wetDuration: 6,
} satisfies Required<FireOptions>;

interface BurningCell {
  index: number;
  heat: number;
  fuel: number;
}

interface ShapeFire {
  body: Body;
  shape: VoxelShape;
  cells: Map<number, BurningCell>;
  wet: Map<number, number>;
}

export interface FireStepResult {
  ignited: number;
  burnedOut: number;
  removed: number;
  burning: number;
}

const NEIGHBORS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * Распространение огня. Клеточный автомат по поверхностным горючим вокселям
 * с детерминированным PRNG: один и тот же сид даёт один и тот же пожар,
 * поэтому спидран воспроизводим, а тесты не мигают.
 */
export class FireSystem {
  private cfg: Required<FireOptions>;
  private rng: () => number;
  private shapes = new Map<number, ShapeFire>();
  private burningTotal = 0;

  constructor(opts: FireOptions = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    this.rng = makeRng(this.cfg.seed);
  }

  get burningCount(): number {
    return this.burningTotal;
  }

  /** Горящие воксели в мировых координатах — для частиц и света. */
  *burningPoints(): Generator<{ position: Vec3; heat: number }> {
    const c = { x: 0, y: 0, z: 0 };
    for (const sf of this.shapes.values()) {
      for (const cell of sf.cells.values()) {
        sf.shape.coords(cell.index, c);
        yield {
          position: sf.shape.voxelCenterWorld(c.x, c.y, c.z, sf.body.transform),
          heat: cell.heat,
        };
      }
    }
  }

  private slot(body: Body, shape: VoxelShape): ShapeFire {
    let sf = this.shapes.get(shape.id);
    if (!sf) {
      sf = { body, shape, cells: new Map(), wet: new Map() };
      this.shapes.set(shape.id, sf);
    } else {
      sf.body = body;
    }
    return sf;
  }

  /** Поджечь конкретный воксель. Возвращает false, если материал не горит. */
  ignite(body: Body, shape: VoxelShape, index: number, heat = 1): boolean {
    const mat = shape.data[index];
    if (mat === Mat.Air) return false;
    const def = material(mat);
    if (def.flammability <= 0 || def.fuel <= 0) return false;

    const sf = this.slot(body, shape);
    if ((sf.wet.get(index) ?? 0) > 0) return false;
    if (sf.cells.has(index)) return false;
    if (this.burningTotal >= this.cfg.maxBurning) return false;

    sf.cells.set(index, { index, heat, fuel: def.fuel });
    this.burningTotal++;
    return true;
  }

  /** Поджечь всё горючее в сфере. Так работают взрывы и паяльная лампа. */
  igniteArea(world: VoxelWorld, center: Vec3, radius: number, heat = 1): number {
    let n = 0;
    for (const body of world.bodies.values()) {
      if (body.destroyed) continue;
      for (const shape of body.shapes) {
        if (shape.solidVoxels === 0) continue;
        const local = shape.worldToVoxel(center, body.transform);
        const r = Math.ceil(radius / shape.voxelSize);
        for (let y = local.y - r; y <= local.y + r; y++) {
          for (let z = local.z - r; z <= local.z + r; z++) {
            for (let x = local.x - r; x <= local.x + r; x++) {
              if (!shape.inBounds(x, y, z)) continue;
              const p = shape.voxelCenterWorld(x, y, z, body.transform);
              if (distance(p, center) > radius) continue;
              const i = shape.idx(x, y, z);
              if (!this.isExposed(shape, x, y, z)) continue;
              if (this.ignite(body, shape, i, heat)) {
                n++;
                world.events.emit('fire:ignited', { body, shape, index: i, point: p });
              }
            }
          }
        }
      }
    }
    return n;
  }

  /**
   * Огнетушитель: гасит жар и оставляет влагу, которая какое-то время
   * не даёт разгореться заново.
   */
  extinguish(world: VoxelWorld, center: Vec3, radius: number, power = 1): number {
    let doused = 0;
    for (const body of world.bodies.values()) {
      if (body.destroyed) continue;
      for (const shape of body.shapes) {
        const sf = this.shapes.get(shape.id);
        const local = shape.worldToVoxel(center, body.transform);
        const r = Math.ceil(radius / shape.voxelSize);
        for (let y = local.y - r; y <= local.y + r; y++) {
          for (let z = local.z - r; z <= local.z + r; z++) {
            for (let x = local.x - r; x <= local.x + r; x++) {
              if (!shape.inBounds(x, y, z)) continue;
              const p = shape.voxelCenterWorld(x, y, z, body.transform);
              if (distance(p, center) > radius) continue;
              const i = shape.idx(x, y, z);
              if (shape.data[i] === Mat.Air) continue;
              const target = sf ?? this.slot(body, shape);
              target.wet.set(i, this.cfg.wetDuration);
              const cell = target.cells.get(i);
              if (cell) {
                cell.heat -= power * 0.9;
                if (cell.heat <= this.cfg.extinguishHeat) {
                  target.cells.delete(i);
                  this.burningTotal--;
                  doused++;
                }
              }
            }
          }
        }
      }
    }
    return doused;
  }

  /** Свободен ли хотя бы один сосед — горит только поверхность. */
  private isExposed(shape: VoxelShape, x: number, y: number, z: number): boolean {
    for (const [dx, dy, dz] of NEIGHBORS) {
      if (shape.get(x + dx, y + dy, z + dz) === Mat.Air) return true;
    }
    return false;
  }

  step(world: VoxelWorld, dt: number): FireStepResult {
    const res: FireStepResult = { ignited: 0, burnedOut: 0, removed: 0, burning: 0 };
    const cfg = this.cfg;
    const windDir = normalize(cfg.wind);
    const hasWind = windDir.x !== 0 || windDir.y !== 0 || windDir.z !== 0;
    const c = { x: 0, y: 0, z: 0 };

    for (const [shapeId, sf] of [...this.shapes]) {
      const { shape, body } = sf;

      if (body.destroyed || shape.solidVoxels === 0) {
        this.burningTotal -= sf.cells.size;
        this.shapes.delete(shapeId);
        continue;
      }

      // Влага испаряется.
      for (const [i, t] of sf.wet) {
        const left = t - dt;
        if (left <= 0) sf.wet.delete(i);
        else sf.wet.set(i, left);
      }

      for (const cell of [...sf.cells.values()]) {
        const mat = shape.data[cell.index];
        if (mat === Mat.Air) {
          sf.cells.delete(cell.index);
          this.burningTotal--;
          continue;
        }
        cell.heat = Math.min(1, cell.heat + dt * 0.8);
        cell.fuel -= cfg.burnRate * dt * cell.heat;

        if (cell.fuel <= 0) {
          sf.cells.delete(cell.index);
          this.burningTotal--;
          shape.coords(cell.index, c);
          if (mat !== Mat.Charred) {
            // Дерево сначала обугливается, и только потом рассыпается.
            shape.setAt(cell.index, Mat.Charred);
            const charred = material(Mat.Charred);
            sf.cells.set(cell.index, {
              index: cell.index,
              heat: cell.heat,
              fuel: charred.fuel,
            });
            this.burningTotal++;
          } else {
            shape.setAt(cell.index, Mat.Air);
            res.removed++;
            world.events.emit('fire:burnedOut', { body, shape, index: cell.index });
          }
          res.burnedOut++;
          continue;
        }

        // Переброс на соседей.
        shape.coords(cell.index, c);
        for (const [dx, dy, dz] of NEIGHBORS) {
          const nx = c.x + dx;
          const ny = c.y + dy;
          const nz = c.z + dz;
          if (!shape.inBounds(nx, ny, nz)) continue;
          const j = shape.idx(nx, ny, nz);
          const nmat = shape.data[j];
          if (nmat === Mat.Air) continue;
          if (sf.cells.has(j)) continue;
          if ((sf.wet.get(j) ?? 0) > 0) continue;
          const ndef = material(nmat);
          if (ndef.flammability <= 0 || ndef.fuel <= 0) continue;
          if (!this.isExposed(shape, nx, ny, nz)) continue;

          let p = ndef.flammability * cfg.spreadRate * cell.heat * dt;
          if (dy > 0) p *= cfg.upwardBias;
          if (hasWind) {
            const align = dot(v3(dx, dy, dz), windDir);
            p *= 1 + cfg.windStrength * align;
          }
          if (p <= 0) continue;
          if (this.rng() < p) {
            if (this.ignite(body, shape, j, cell.heat * 0.7)) {
              res.ignited++;
              world.events.emit('fire:ignited', {
                body,
                shape,
                index: j,
                point: shape.voxelCenterWorld(nx, ny, nz, body.transform),
              });
            }
          }
        }
      }

      if (sf.cells.size === 0 && sf.wet.size === 0) this.shapes.delete(shapeId);
    }

    res.burning = this.burningTotal;
    return res;
  }

  /** Полное тушение — для рестарта миссии. */
  reset(): void {
    this.shapes.clear();
    this.burningTotal = 0;
    this.rng = makeRng(this.cfg.seed);
  }

  isBurning(shape: VoxelShape, index: number): boolean {
    return this.shapes.get(shape.id)?.cells.has(index) ?? false;
  }

  isWet(shape: VoxelShape, index: number): boolean {
    return (this.shapes.get(shape.id)?.wet.get(index) ?? 0) > 0;
  }
}
