import { Vec3, v3 } from './math.js';
import { Body } from './body.js';
import { VoxelShape } from './voxel-shape.js';
import { EventBus } from './events.js';
import { RayHit, RaycastOptions, raycastBodies } from './raycast.js';

export interface VoxelsRemovedEvent {
  body: Body;
  shape: VoxelShape;
  count: number;
  /** Центр области разрушения в мире. */
  center: Vec3;
  /** Материалы, которых не стало: id → количество. */
  materials: Map<number, number>;
  /** Источник: инструмент, взрыв, огонь, удар. */
  cause: string;
  debris?: readonly { position: Vec3; material: number }[];
}

export interface BodySplitEvent {
  source: Body;
  fragments: Body[];
  reason: 'disconnected' | 'stress';
}

export interface ImpactEvent {
  body: Body;
  other: Body | null;
  point: Vec3;
  /** Импульс удара, кг·м/с. */
  impulse: number;
  normal: Vec3;
}

export interface WorldEvents extends Record<string, unknown> {
  'voxels:removed': VoxelsRemovedEvent;
  'body:added': { body: Body };
  'body:removed': { body: Body };
  'body:split': BodySplitEvent;
  'fire:ignited': { body: Body; shape: VoxelShape; index: number; point: Vec3 };
  'fire:burnedOut': { body: Body; shape: VoxelShape; index: number };
  impact: ImpactEvent;
}

export interface WorldOptions {
  gravity?: Vec3;
  /** Секунд покоя до засыпания динамического тела. */
  sleepAfter?: number;
  seed?: number;
}

/**
 * Воксельный мир: тела, шина событий, запросы. Интегрирование и коллизии
 * живут в физическом бэкенде (см. physics.ts) — мир только хранит состояние
 * и умеет по нему отвечать на вопросы.
 */
export class VoxelWorld {
  readonly bodies = new Map<number, Body>();
  readonly events = new EventBus<WorldEvents>();
  gravity: Vec3;
  sleepAfter: number;
  seed: number;
  /** Отработанное время симуляции, секунды. */
  time = 0;

  private shapeIndex = new Map<number, Body>();

  constructor(opts: WorldOptions = {}) {
    this.gravity = opts.gravity ?? v3(0, -9.81, 0);
    this.sleepAfter = opts.sleepAfter ?? 1.5;
    this.seed = opts.seed ?? 0x5eed;
  }

  addBody(body: Body): Body {
    this.bodies.set(body.id, body);
    for (const s of body.shapes) this.shapeIndex.set(s.id, body);
    this.events.emit('body:added', { body });
    return body;
  }

  removeBody(body: Body): boolean {
    if (!this.bodies.delete(body.id)) return false;
    for (const s of body.shapes) this.shapeIndex.delete(s.id);
    body.destroyed = true;
    this.events.emit('body:removed', { body });
    return true;
  }

  /** Тело, которому принадлежит форма. */
  bodyOfShape(shape: VoxelShape): Body | undefined {
    return this.shapeIndex.get(shape.id);
  }

  /** Пересобрать индекс форм — после ручного добавления формы в тело. */
  reindex(): void {
    this.shapeIndex.clear();
    for (const body of this.bodies.values()) {
      for (const s of body.shapes) this.shapeIndex.set(s.id, body);
    }
  }

  get dynamicBodies(): Body[] {
    return [...this.bodies.values()].filter((b) => b.kind === 'dynamic' && !b.destroyed);
  }

  get staticBodies(): Body[] {
    return [...this.bodies.values()].filter((b) => b.kind === 'static' && !b.destroyed);
  }

  raycast(origin: Vec3, direction: Vec3, opts: RaycastOptions = {}): RayHit | null {
    return raycastBodies(this.bodies.values(), origin, direction, opts);
  }

  /** Суммарное количество непустых вокселей — дешёвая метрика для тестов. */
  totalSolidVoxels(): number {
    let n = 0;
    for (const b of this.bodies.values()) if (!b.destroyed) n += b.solidVoxels;
    return n;
  }

  /** Убрать тела, помеченные destroyed, и пустые динамические обломки. */
  collectGarbage(): number {
    let removed = 0;
    for (const body of [...this.bodies.values()]) {
      if (body.destroyed) {
        this.bodies.delete(body.id);
        for (const s of body.shapes) this.shapeIndex.delete(s.id);
        removed++;
        continue;
      }
      if (body.kind === 'dynamic' && body.solidVoxels === 0) {
        this.removeBody(body);
        removed++;
      }
    }
    return removed;
  }
}
