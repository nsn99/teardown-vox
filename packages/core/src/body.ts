import { Aabb, Transform, Vec3, aabbEmpty, aabbExpand, transformIdentity, v3 } from './math.js';
import { VoxelShape, SerializedShape } from './voxel-shape.js';

export type BodyKind = 'static' | 'dynamic';

export interface BodyOptions {
  kind?: BodyKind;
  transform?: Transform;
  shapes?: VoxelShape[];
  name?: string;
  tags?: string[];
  /** Тело не участвует в разрушении и структурном анализе (напр. вода). */
  passive?: boolean;
}

let nextBodyId = 1;
/** Только для тестов. */
export function __resetBodyIds(): void {
  nextBodyId = 1;
}

/**
 * Тело — контейнер форм с общим трансформом. Статическое тело держит
 * геометрию уровня, динамическое — обломки, технику и предметы.
 * Само тело не интегрируется: этим занимается физический бэкенд,
 * а сюда синхронизируются позиция и скорость.
 */
export class Body {
  readonly id: number;
  kind: BodyKind;
  transform: Transform;
  shapes: VoxelShape[];
  name: string;
  tags: Set<string>;
  passive: boolean;

  velocity: Vec3 = v3();
  angularVelocity: Vec3 = v3();
  /** Хэндл в физическом бэкенде, если тело туда заведено. */
  physicsHandle: number | null = null;
  /** Коллайдеры устарели — нужна перестройка после разрушения. */
  collidersDirty = true;
  /** Тело уснуло: не считаем структурную целостность и не шлём в солвер. */
  sleeping = false;
  /** Секунд без движения. */
  restTime = 0;
  /** Помечено на удаление в конце шага. */
  destroyed = false;

  constructor(opts: BodyOptions = {}) {
    this.id = nextBodyId++;
    this.kind = opts.kind ?? 'static';
    this.transform = opts.transform ?? transformIdentity();
    this.shapes = opts.shapes ?? [];
    this.name = opts.name ?? `body${this.id}`;
    this.tags = new Set(opts.tags ?? []);
    this.passive = opts.passive ?? false;
  }

  addShape(shape: VoxelShape): VoxelShape {
    this.shapes.push(shape);
    this.collidersDirty = true;
    return shape;
  }

  removeShape(shape: VoxelShape): boolean {
    const i = this.shapes.indexOf(shape);
    if (i < 0) return false;
    this.shapes.splice(i, 1);
    this.collidersDirty = true;
    return true;
  }

  get solidVoxels(): number {
    let n = 0;
    for (const s of this.shapes) n += s.solidVoxels;
    return n;
  }

  mass(): number {
    let m = 0;
    for (const s of this.shapes) m += s.mass();
    return m;
  }

  /** AABB тела в мировых координатах (по границам форм, не по вокселям). */
  aabb(): Aabb {
    const box = aabbEmpty();
    for (const s of this.shapes) {
      const local = s.localAabb();
      for (let i = 0; i < 8; i++) {
        const p = v3(
          i & 1 ? local.max.x : local.min.x,
          i & 2 ? local.max.y : local.min.y,
          i & 4 ? local.max.z : local.min.z,
        );
        aabbExpand(box, worldPoint(this.transform, p));
      }
    }
    return box;
  }

  wake(): void {
    this.sleeping = false;
    this.restTime = 0;
  }

  toJSON(): SerializedBody {
    return {
      kind: this.kind,
      transform: this.transform,
      name: this.name,
      tags: [...this.tags],
      passive: this.passive,
      shapes: this.shapes.map((s) => s.toJSON()),
    };
  }

  static fromJSON(json: SerializedBody): Body {
    return new Body({
      kind: json.kind,
      transform: json.transform,
      name: json.name,
      tags: json.tags,
      passive: json.passive,
      shapes: json.shapes.map((s) => VoxelShape.fromJSON(s)),
    });
  }
}

export interface SerializedBody {
  kind: BodyKind;
  transform: Transform;
  name: string;
  tags: string[];
  passive: boolean;
  shapes: SerializedShape[];
}

// Локальная копия, чтобы не тянуть math в горячий путь через ре-экспорт.
function worldPoint(t: Transform, p: Vec3): Vec3 {
  const q = t.rotation;
  const tx = 2 * (q.y * p.z - q.z * p.y);
  const ty = 2 * (q.z * p.x - q.x * p.z);
  const tz = 2 * (q.x * p.y - q.y * p.x);
  return v3(
    p.x + q.w * tx + (q.y * tz - q.z * ty) + t.position.x,
    p.y + q.w * ty + (q.z * tx - q.x * tz) + t.position.y,
    p.z + q.w * tz + (q.x * ty - q.y * tx) + t.position.z,
  );
}
