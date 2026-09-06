import { Vec3, add, distance, length, quatMultiply, rotateVec, v3 } from './math.js';
import { Body } from './body.js';
import { VoxelWorld } from './world.js';
import { bodyCenter } from './physics.js';

export interface DebrisCapOptions {
  /** Сколько живых обломков держим одновременно. */
  maxActive?: number;
  /** Куда смотрит игрок — от неё считается «далеко». */
  focus?: Vec3;
  /** Обломки крупнее этого не замораживаем: они слишком заметны. */
  keepAboveVoxels?: number;
  /** Заморозить можно только то, что уже улеглось. */
  restOnly?: boolean;
  /** Ближе этого расстояния не трогаем вообще. */
  keepWithin?: number;
  /**
   * Сливать замороженные обломки в одно общее статическое тело.
   * Без этого число тел в длинной сессии растёт линейно, даже если
   * динамических среди них уже нет.
   */
  merge?: boolean;
}

const DEFAULTS = {
  maxActive: 200,
  focus: v3(),
  keepAboveVoxels: 600,
  restOnly: true,
  keepWithin: 12,
  merge: true,
} satisfies Required<DebrisCapOptions>;

export interface DebrisCapResult {
  /** Сколько обломков слилось в статическую геометрию. */
  frozen: number;
  /** Сколько динамических обломков осталось живыми. */
  active: number;
  bodies: Body[];
}

/**
 * Потолок числа активных обломков.
 *
 * Лишнее не удаляется, а вмерзает в статическую геометрию: обломок
 * остаётся ровно там, где лежал, по нему по-прежнему можно ходить и
 * бить, но солвер про него забывает. Удалять на глазах у игрока нельзя —
 * исчезающий на ровном месте кусок стены читается как баг, а не как
 * оптимизация.
 *
 * Кандидаты выбираются по «мелкий и далёкий»: крупный обломок у ног
 * игрока замрёт последним.
 */
export function capDebris(world: VoxelWorld, opts: DebrisCapOptions = {}): DebrisCapResult {
  const cfg = { ...DEFAULTS, ...opts };
  const candidates: Array<{ body: Body; score: number }> = [];
  let active = 0;

  for (const body of world.bodies.values()) {
    if (body.destroyed || body.kind !== 'dynamic' || body.kinematic || body.passive) continue;
    active++;
    if (!body.tags.has('debris')) continue;
    if (cfg.restOnly && !body.sleeping && length(body.velocity) > 0.2) continue;

    const voxels = body.solidVoxels;
    if (voxels > cfg.keepAboveVoxels) continue;
    const dist = distance(bodyCenter(body), cfg.focus);
    if (dist < cfg.keepWithin) continue;

    // Мелкий и далёкий уходит первым; крупный и близкий — последним.
    candidates.push({ body, score: dist / (voxels + 1) });
  }

  const excess = active - cfg.maxActive;
  if (excess <= 0) return { frozen: 0, active, bodies: [] };

  candidates.sort((a, b) => b.score - a.score);
  const frozenBodies: Body[] = [];
  for (const c of candidates) {
    if (frozenBodies.length >= excess) break;
    if (cfg.merge) mergeIntoField(world, c.body);
    else freeze(c.body);
    frozenBodies.push(c.body);
  }

  return { frozen: frozenBodies.length, active: active - frozenBodies.length, bodies: frozenBodies };
}

/** Тег общего тела, в которое сливаются замороженные обломки. */
export const DEBRIS_FIELD_TAG = 'debris-field';

/** Найти или создать общую свалку обломков. */
export function debrisField(world: VoxelWorld): Body {
  for (const b of world.bodies.values()) {
    if (!b.destroyed && b.tags.has(DEBRIS_FIELD_TAG)) return b;
  }
  const field = new Body({
    kind: 'static',
    shapes: [],
    name: 'обломки',
    tags: [DEBRIS_FIELD_TAG],
    passive: true,
  });
  return world.addBody(field);
}

/**
 * Перенести формы обломка в общую свалку и убрать его тело.
 *
 * Воксели остаются ровно там, где лежали: трансформ формы пересчитывается
 * в систему свалки. Смысл — плато по числу тел: без слияния длинная
 * сессия копит тысячи статических тел, и каждый кадр начинает с обхода
 * этого списка.
 */
export function mergeIntoField(world: VoxelWorld, body: Body): Body {
  const field = debrisField(world);
  // Свалка живёт в мировых осях без поворота — иначе пришлось бы
  // разворачивать в неё каждую форму, а смысла в этом никакого.
  const fp = field.transform.position;

  for (const shape of body.shapes) {
    if (shape.solidVoxels === 0) continue;
    // Мировой трансформ формы = трансформ тела ∘ трансформ формы,
    // и его надо выразить относительно свалки.
    const worldPos = add(body.transform.position, rotateVec(body.transform.rotation, shape.transform.position));
    const worldRot = quatMultiply(body.transform.rotation, shape.transform.rotation);
    shape.transform = {
      position: v3(worldPos.x - fp.x, worldPos.y - fp.y, worldPos.z - fp.z),
      rotation: worldRot,
    };
    shape.structural = false;
    shape.structureScanned = true;
    shape.clearStructureDirty();
    field.addShape(shape);
  }

  body.shapes = [];
  world.removeBody(body);
  world.reindex();
  field.collidersDirty = true;
  return field;
}

/** Вмораживает обломок в статическую геометрию, не двигая его с места. */
export function freeze(body: Body): void {
  body.kind = 'static';
  body.passive = true;
  body.sleeping = true;
  body.velocity = v3();
  body.angularVelocity = v3();
  body.collidersDirty = true;
  body.tags.add('frozen');
}
