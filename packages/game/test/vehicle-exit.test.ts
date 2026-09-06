import { describe, expect, it } from 'vitest';
import { Mat, VoxelShape, v3 } from '@tvox/core';
import { Heist, NEUTRAL_INPUT, portLevel } from '@tvox/game';
import { overlapsSolid } from '../src/character.js';

/**
 * Посадка и высадка.
 *
 * Единственное требование, которое здесь вообще имеет смысл проверять:
 * после выхода игрок стоит там, где может стоять. Всё остальное —
 * вкусовщина, а застрять в стене — баг, который ломает прохождение.
 */

function heist(): Heist {
  const h = new Heist({ level: portLevel, sandbox: true });
  h.start();
  return h;
}

function stuck(h: Heist): boolean {
  return overlapsSolid(h.sim.world, h.character.aabbAt(h.character.position));
}

describe('высадка из техники', () => {
  it('сесть можно только рядом и только в целую технику', () => {
    const h = heist();
    const van = h.vehicles.get('van')!;
    // Игрок на другом конце карты — сесть не в что.
    h.character.teleport(v3(2, 0.2, 2));
    expect(h.toggleVehicle()).toBeNull();

    h.character.teleport({ ...van.position });
    expect(h.toggleVehicle()).toBe('van');
    expect(h.drivingId).toBe('van');

    // Из разбитой не сесть: сначала выходим, потом ломаем.
    h.toggleVehicle();
    van.wrecked = true;
    h.character.teleport({ ...van.position });
    expect(h.toggleVehicle()).toBeNull();
  });

  it('высадка на открытом месте не роняет игрока в геометрию', () => {
    const h = heist();
    const van = h.vehicles.get('van')!;
    h.character.teleport({ ...van.position });
    h.toggleVehicle();
    h.toggleVehicle();
    expect(h.drivingId).toBeNull();
    expect(stuck(h)).toBe(false);
  });

  it('машина вплотную к стене высаживает с другой стороны', () => {
    const h = heist();
    const van = h.vehicles.get('van')!;
    // Ставим пикап впритык к передней стене склада (склад: x 6..26, z 14..30).
    van.position = v3(16, 0.1, 13.2);
    van.yaw = 0;
    h.character.teleport({ ...van.position });
    h.toggleVehicle();
    const out = h.exitPosition(van);
    h.toggleVehicle();

    expect(stuck(h)).toBe(false);
    // Высадило именно наружу, а не внутрь кладки.
    expect(out.z).toBeLessThan(14);
  });

  it('замурованная машина высаживает наверх, а не внутрь стены', () => {
    const h = heist();
    const van = h.vehicles.get('van')!;
    const at = v3(40, 0.2, 6);
    van.position = { ...at };

    // Забетонируем всё вокруг машины: свободных мест по кругу не остаётся.
    const wall = new VoxelShape({
      sx: 120,
      sy: 40,
      sz: 120,
      voxelSize: 0.1,
      grounded: true,
      name: 'ловушка',
    });
    wall.transform = {
      position: v3(at.x - 6, 0, at.z - 6),
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    };
    wall.fill({}, Mat.Concrete);
    const level = [...h.sim.world.bodies.values()].find((b) => b.tags.has('level'))!;
    level.addShape(wall);

    const out = h.exitPosition(van);
    // Единственный честный выход — на крышу собственного кузова.
    expect(out.y).toBeGreaterThan(at.y + 1);
    expect(out.x).toBeCloseTo(at.x, 5);
  });

  it('разрушение техники под игроком высаживает его само', () => {
    const h = heist();
    const van = h.vehicles.get('van')!;
    h.character.teleport({ ...van.position });
    h.toggleVehicle();
    expect(h.drivingId).toBe('van');

    // Сносим кузов: больше половины вокселей — техника мертва.
    for (const s of van.body.shapes) s.fill({}, Mat.Air);
    h.update(1 / 60, undefined, NEUTRAL_INPUT);

    expect(van.wrecked).toBe(true);
    expect(h.drivingId).toBeNull();
    expect(stuck(h)).toBe(false);
  });

  it('выход из катера не оставляет игрока внутри причала', () => {
    const h = heist();
    const boat = h.vehicles.get('boat')!;
    h.character.teleport({ ...boat.position });
    h.toggleVehicle();
    h.toggleVehicle();
    expect(stuck(h)).toBe(false);
  });
});
