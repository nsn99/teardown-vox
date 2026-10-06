import { afterEach, describe, expect, it } from 'vitest';
import {
  Body, Mat, RapierPhysics, Simulation, VoxelShape,
  computeAnchored, computeStress, findLooseComponents, transformPoint, v3,
} from '@tvox/core';
import {
  ChargeSystem, CharacterController, Inventory, NEUTRAL_CRANE_INPUT, PortCrane, ToolContext, portLevel, useTool,
} from '@tvox/game';
import { overlapsSolid } from '../src/character.js';

let sim: Simulation;
let controller: PortCrane;

function scene(): VoxelShape {
  sim = new Simulation({
    structure: { timeBudgetMs: 0 }, structureEveryNSteps: 1, structureBudgetMs: 0,
  });
  const [level] = portLevel.build(sim);
  controller = new PortCrane(sim, portLevel.cranes![0]);
  controller.update(NEUTRAL_CRANE_INPUT, 0);
  return level.shapes.find(s => s.name === 'crane')!;
}

function context(tool: 'explosive' | 'blowtorch', origin: ReturnType<typeof v3>, direction: ReturnType<typeof v3>): ToolContext {
  const inventory = new Inventory({ unlimited: true });
  inventory.select(tool);
  return { sim, inventory, origin, direction };
}

function walkTo(character: CharacterController, x: number, z: number): void {
  for (let i = 0; i < 180; i++) {
    const dx = x - character.position.x;
    const dz = z - character.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.04) break;
    character.update(sim.world, {
      forward: Math.min(1, distance * 4), right: 0, jump: false, sprint: false, crouch: false,
    }, Math.atan2(-dx, -dz), 1 / 60);
  }
  expect(Math.hypot(x - character.position.x, z - character.position.z)).toBeLessThan(0.04);
  expect(overlapsSolid(sim.world, character.aabbAt(character.position))).toBe(false);
}

function highMetal(bodies: Body[]): number {
  let count = 0;
  for (const body of bodies) for (const shape of body.shapes) {
    for (let i = 0; i < shape.data.length; i++) {
      if (shape.data[i] !== Mat.Metal && shape.data[i] !== Mat.HeavyMetal) continue;
      const c = shape.coords(i);
      const point = transformPoint(body.transform, transformPoint(shape.transform,
        v3((c.x + 0.5) * shape.voxelSize, (c.y + 0.5) * shape.voxelSize, (c.z + 0.5) * shape.voxelSize)));
      if (point.y > 12) count++;
    }
  }
  return count;
}

afterEach(() => sim?.dispose());

describe('портовый кран', () => {
  it('связан с причалом и дном, не крошится и не отделяет детали при загрузке', () => {
    const crane = scene();
    expect(computeStress(crane).failures).toHaveLength(0);
    expect(findLooseComponents(crane, computeAnchored(crane))).toHaveLength(0);
    for (let i = 0; i < crane.data.length; i++) {
      // Единственные неразрушимые крепления находятся у самого дна.
      if (crane.data[i] === Mat.Foundation) expect(crane.coords(i).y).toBe(0);
    }
    for (const x of [29.6, 32.8]) for (const z of [4.6, 8.6]) {
      const foot = sim.world.raycast(v3(x, 0.39, z), v3(0, -1, 0), { maxDistance: 2.5 });
      expect(foot?.shape).toBe(crane);
      // Проверяем реальное дно под сваями, пропуская сам кран.
      const bed = sim.world.raycast(v3(x, -1.79, z), v3(0, -1, 0), {
        maxDistance: 0.1, filter: (mat, shape) => mat !== Mat.Air && shape.name === 'ground',
      });
      expect(bed).not.toBeNull();
      expect(bed!.point.y).toBeCloseTo(-1.8);
      expect(crane.transform.position.y).toBeCloseTo(-1.8);
    }
  });

  it('персонаж идёт с берега по лестнице и входит в кабину без прыжков', () => {
    scene();
    const character = new CharacterController({ position: v3(30.55, 0.01, 11) });
    for (const [x, z] of [
      [30.55, 9.15], [30.55, 5.20], [31.8, 5.20],
      [31.8, 7.95], [30.55, 7.95], [30.55, 5.20],
      [31.8, 5.20], [31.8, 7.95], [30.55, 7.95],
      [30.55, 4.85], [29.4, 4.85],
    ]) walkTo(character, x, z);
    expect(character.position.y).toBeCloseTo(10.9, 2);
    const console = sim.world.raycast(character.eye, v3(0, -0.6, -1), { maxDistance: 2 });
    expect(console?.shape.name).toBe('crane-house');
  });

  it('базовый контактный заряд вырезает отверстие в наружной стороне опоры', () => {
    const crane = scene();
    const charges = new ChargeSystem({ fuse: Infinity });
    const ctx = context('explosive', v3(28.5, 1.5, 4.4), v3(1, 0, 0));
    const hit = sim.world.raycast(ctx.origin, ctx.direction, { maxDistance: 3 });
    expect(hit?.shape).toBe(crane);
    expect(hit?.material).toBe(Mat.Metal);
    const before = crane.solidVoxels;
    expect(charges.place(ctx)).not.toBeNull();
    expect(charges.detonateAll(sim)).toBe(1);
    expect(crane.solidVoxels).toBeLessThan(before - 50);
    expect(crane.get(hit!.vx, hit!.vy, hit!.vz)).toBe(Mat.Air);
  });

  it('базовый заряд разрывает оба подъёмных троса и освобождает крюк', () => {
    scene();
    sim.primeStructure();
    const charges = new ChargeSystem({ fuse: Infinity });
    expect(charges.place(context('explosive', v3(31.55, 8, -5.8), v3(0, 0, 1)))).not.toBeNull();
    expect(charges.detonateAll(sim)).toBe(1);
    controller.update(NEUTRAL_CRANE_INPUT, 0);
    const hook = controller.hook;
    expect(hook).toBeDefined();
    expect(hook.tags.has('debris')).toBe(true);
    expect(hook.kinematic).toBe(false);
    const beforeY = hook.transform.position.y;
    for (let i = 0; i < 45; i++) sim.step(1 / 60);
    expect(hook.transform.position.y).toBeLessThan(beforeY - 0.5);
  });

  it('обычная паяльная лампа режет стальную раскосину', () => {
    const crane = scene();
    const ctx = context('blowtorch', v3(30, 1, 3.7), v3(0, 0, 1));
    const hit = sim.world.raycast(ctx.origin, ctx.direction, { maxDistance: 1.6 });
    expect(hit?.shape).toBe(crane);
    expect(hit?.material).toBe(Mat.Metal);
    let removed = 0;
    for (let i = 0; i < 10; i++) {
      removed += useTool(ctx).removed ?? 0;
      ctx.inventory.tick(1);
    }
    expect(removed).toBeGreaterThan(0);
    expect(crane.get(hit!.vx, hit!.vy, hit!.vz)).toBe(Mat.Air);
  });

  it('заряды разрушают опоры, после чего кран падает и разбивается', async () => {
    const crane = scene();
    sim.setPhysics(await RapierPhysics.create(sim.world));
    sim.primeStructure();
    const charges = new ChargeSystem({ fuse: Infinity });
    const place = (origin: ReturnType<typeof v3>, direction: ReturnType<typeof v3>) => {
      const ctx = context('explosive', origin, direction);
      ctx.inventory.setTier('explosive', 3);
      expect(charges.place(ctx)).not.toBeNull();
    };
    // Две стороны каждой усиленной опоры и связанный с верхом пролёт
    // лестницы. Используются настоящие игровые параметры зарядов.
    for (const x of [29.6, 32.8]) for (const z of [4.6, 8.6]) for (const side of [-1, 1]) {
      place(v3(x, 1.5, z + side * 1.2), v3(0, 0, -side));
    }
    place(v3(30.55, 1.3, 9.3), v3(0, 0, -1));
    expect(charges.detonateAll(sim)).toBe(9);
    controller.update(NEUTRAL_CRANE_INPUT, 0);
    expect(controller.house.kinematic).toBe(false);
    expect(controller.operable).toBe(false);
    expect(crane.get(36, 124, 125)).toBe(Mat.Air);
    const detached = [...sim.world.bodies.values()].filter(b => b.kind === 'dynamic'
      && (b.tags.has('crane') || b.shapes.some(s => s.name.startsWith('crane:frag'))));
    expect(detached.length).toBeGreaterThan(0);
    const upper = detached.filter(b => b.tags.has('crane'));
    const shell = upper.reduce((a, b) => a.solidVoxels > b.solidVoxels ? a : b);
    const before = shell.solidVoxels;
    const highBefore = highMetal(upper);
    expect(highBefore).toBeGreaterThan(1000);
    for (let i = 0; i < 360; i++) sim.step(1 / 60);
    const pieces = [...sim.world.bodies.values()].filter(b => b.tags.has('crane'));
    expect(Math.max(...pieces.map(b => b.solidVoxels))).toBeLessThan(before * 0.6);
    expect(highMetal(pieces)).toBeLessThan(highBefore * 0.2);
  }, 90_000);
});
