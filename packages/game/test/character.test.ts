import { describe, expect, it } from 'vitest';
import { Body, Mat, VoxelShape, VoxelWorld, v3 } from '@tvox/core';
import { CharacterController, CharacterInput, overlapsMaterial, overlapsSolid } from '@tvox/game';

const VS = 0.1;
const IDLE: CharacterInput = {
  forward: 0,
  right: 0,
  jump: false,
  sprint: false,
  crouch: false,
};

/** Плита пола 12×0.3×12 м, верх на y=0. */
function floorWorld(): VoxelWorld {
  const world = new VoxelWorld();
  const s = new VoxelShape({ sx: 120, sy: 3, sz: 120, voxelSize: VS, grounded: true });
  s.fill({}, Mat.Concrete);
  s.transform = { position: v3(-6, -0.3, -6), rotation: { x: 0, y: 0, z: 0, w: 1 } };
  world.addBody(new Body({ kind: 'static', shapes: [s], name: 'floor' }));
  return world;
}

function addBlock(
  world: VoxelWorld,
  pos: { x: number; y: number; z: number },
  size: { x: number; y: number; z: number },
  mat = Mat.Brick,
): Body {
  const s = new VoxelShape({
    sx: Math.round(size.x / VS),
    sy: Math.round(size.y / VS),
    sz: Math.round(size.z / VS),
    voxelSize: VS,
    grounded: true,
  });
  s.fill({}, mat);
  s.transform = { position: v3(pos.x, pos.y, pos.z), rotation: { x: 0, y: 0, z: 0, w: 1 } };
  const body = new Body({ kind: 'static', shapes: [s], name: 'block' });
  world.addBody(body);
  return body;
}

function run(
  ch: CharacterController,
  world: VoxelWorld,
  input: CharacterInput,
  yaw: number,
  seconds: number,
): void {
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds / dt); i++) ch.update(world, input, yaw, dt);
}

describe('гравитация и опора', () => {
  it('падает на пол и встаёт на него', () => {
    const world = floorWorld();
    const ch = new CharacterController({ position: v3(0, 3, 0) });
    run(ch, world, IDLE, 0, 2);
    expect(ch.onGround).toBe(true);
    expect(ch.position.y).toBeGreaterThan(-0.02);
    expect(ch.position.y).toBeLessThan(0.05);
  });

  it('без опоры продолжает падать', () => {
    const world = new VoxelWorld();
    const ch = new CharacterController({ position: v3(0, 10, 0) });
    run(ch, world, IDLE, 0, 1);
    expect(ch.onGround).toBe(false);
    expect(ch.position.y).toBeLessThan(5);
  });

  it('прыгает только с земли', () => {
    const world = floorWorld();
    const ch = new CharacterController({ position: v3(0, 0.5, 0) });
    run(ch, world, IDLE, 0, 1);
    const ground = ch.position.y;

    ch.update(world, { ...IDLE, jump: true }, 0, 1 / 60);
    expect(ch.velocity.y).toBeGreaterThan(0);
    const airborne = ch.velocity.y;
    ch.update(world, { ...IDLE, jump: true }, 0, 1 / 60);
    expect(ch.velocity.y).toBeLessThan(airborne);
    run(ch, world, IDLE, 0, 2);
    expect(ch.position.y).toBeCloseTo(ground, 2);
  });
});

describe('движение и столкновения', () => {
  it('идёт вперёд по направлению взгляда', () => {
    const world = floorWorld();
    const ch = new CharacterController({ position: v3(0, 0.1, 0) });
    run(ch, world, { ...IDLE, forward: 1 }, 0, 1);
    // yaw = 0 смотрит в -Z.
    expect(ch.position.z).toBeLessThan(-1);
    expect(Math.abs(ch.position.x)).toBeLessThan(0.2);
  });

  it('бег быстрее шага, присед медленнее', () => {
    const dist = (input: CharacterInput) => {
      const world = floorWorld();
      const ch = new CharacterController({ position: v3(0, 0.1, 0) });
      run(ch, world, input, 0, 1.5);
      return Math.abs(ch.position.z);
    };
    const walk = dist({ ...IDLE, forward: 1 });
    const sprint = dist({ ...IDLE, forward: 1, sprint: true });
    const crouch = dist({ ...IDLE, forward: 1, crouch: true });
    expect(sprint).toBeGreaterThan(walk);
    expect(crouch).toBeLessThan(walk);
  });

  it('упирается в стену и не проходит сквозь', () => {
    const world = floorWorld();
    addBlock(world, { x: -1, y: 0, z: -3 }, { x: 2, y: 3, z: 0.4 });
    const ch = new CharacterController({ position: v3(0, 0.1, 0) });
    run(ch, world, { ...IDLE, forward: 1, sprint: true }, 0, 3);
    expect(ch.position.z).toBeGreaterThan(-3);
  });

  it('на большой скорости не протуннелирует стену', () => {
    const world = floorWorld();
    addBlock(world, { x: -2, y: 0, z: -2 }, { x: 4, y: 3, z: 0.2 });
    const ch = new CharacterController({ position: v3(0, 0.1, 0) });
    ch.velocity = v3(0, 0, -80);
    ch.update(world, IDLE, 0, 1 / 30);
    expect(ch.position.z).toBeGreaterThan(-2);
  });

  it('сам заходит на низкую ступеньку', () => {
    const world = floorWorld();
    addBlock(world, { x: -1, y: 0, z: -3 }, { x: 2, y: 0.3, z: 1 });
    const ch = new CharacterController({ position: v3(0, 0.1, 0) });
    run(ch, world, { ...IDLE, forward: 1 }, 0, 0.75);
    expect(ch.position.y).toBeCloseTo(0.3, 2);
    expect(ch.position.z).toBeLessThan(-2);
    expect(ch.onGround).toBe(true);
  });

  it('высокий уступ не перешагивается', () => {
    const world = floorWorld();
    addBlock(world, { x: -1, y: 0, z: -3 }, { x: 2, y: 1.5, z: 1 });
    const ch = new CharacterController({ position: v3(0, 0.1, 0) });
    run(ch, world, { ...IDLE, forward: 1 }, 0, 1);
    expect(ch.position.y).toBeLessThan(0.3);
    expect(ch.position.z).toBeGreaterThan(-2.1);
  });

  it('движение вбок работает независимо от взгляда', () => {
    const world = floorWorld();
    const ch = new CharacterController({ position: v3(0, 0.1, 0) });
    run(ch, world, { ...IDLE, right: 1 }, 0, 1);
    expect(ch.position.x).toBeGreaterThan(1);
  });
});

describe('присед', () => {
  it('под низким проёмом нельзя встать', () => {
    const world = floorWorld();
    // Потолок на высоте 1.2 м прямо над игроком.
    addBlock(world, { x: -1, y: 1.2, z: -1 }, { x: 2, y: 0.4, z: 2 });
    const ch = new CharacterController({ position: v3(0, 0.05, 0) });
    run(ch, world, { ...IDLE, crouch: true }, 0, 0.5);
    expect(ch.crouching).toBe(true);
    run(ch, world, IDLE, 0, 0.5);
    expect(ch.crouching).toBe(true);
  });

  it('на открытом месте встаёт обратно', () => {
    const world = floorWorld();
    const ch = new CharacterController({ position: v3(0, 0.05, 0) });
    run(ch, world, { ...IDLE, crouch: true }, 0, 0.3);
    expect(ch.crouching).toBe(true);
    run(ch, world, IDLE, 0, 0.3);
    expect(ch.crouching).toBe(false);
  });

  it('глаза ниже макушки и опускаются в приседе', () => {
    const ch = new CharacterController({ position: v3(0, 0, 0) });
    const standing = ch.eye.y;
    ch.crouching = true;
    expect(ch.eye.y).toBeLessThan(standing);
  });
});

describe('вода', () => {
  it('в воде игрок замедляется и не тонет камнем', () => {
    const world = floorWorld();
    addBlock(world, { x: -3, y: 0, z: -3 }, { x: 6, y: 2, z: 6 }, Mat.Water);
    const ch = new CharacterController({ position: v3(0, 1, 0) });
    run(ch, world, IDLE, 0, 1);
    expect(ch.inWater).toBe(true);
    expect(ch.velocity.y).toBeGreaterThan(-2);
  });

  it('пробелом всплывает', () => {
    const world = floorWorld();
    addBlock(world, { x: -3, y: 0, z: -3 }, { x: 6, y: 3, z: 6 }, Mat.Water);
    const ch = new CharacterController({ position: v3(0, 1, 0) });
    run(ch, world, { ...IDLE, jump: true }, 0, 1);
    expect(ch.velocity.y).toBeGreaterThan(0);
  });
});

describe('запросы пересечения', () => {
  it('вода и краска не считаются твёрдыми', () => {
    const world = new VoxelWorld();
    addBlock(world, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, Mat.Water);
    const box = { min: v3(0.1, 0.1, 0.1), max: v3(0.5, 0.5, 0.5) };
    expect(overlapsSolid(world, box)).toBe(false);
    expect(overlapsMaterial(world, box, Mat.Water)).toBe(true);
  });

  it('коробка вне тела ничего не находит', () => {
    const world = floorWorld();
    expect(overlapsSolid(world, { min: v3(500, 500, 500), max: v3(501, 501, 501) })).toBe(false);
  });

  it('телепорт обнуляет скорость', () => {
    const ch = new CharacterController();
    ch.velocity = v3(5, -3, 2);
    ch.teleport(v3(1, 2, 3));
    expect(ch.position).toEqual(v3(1, 2, 3));
    expect(ch.velocity).toEqual(v3(0, 0, 0));
  });

  it('снимок состояния независим от контроллера', () => {
    const ch = new CharacterController({ position: v3(1, 2, 3) });
    const snap = ch.state;
    ch.position.x = 99;
    expect(snap.position.x).toBe(1);
    expect(snap.height).toBeGreaterThan(1.5);
  });
});
