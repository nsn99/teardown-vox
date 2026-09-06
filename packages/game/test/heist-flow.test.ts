import { describe, expect, it } from 'vitest';
import { Mat, carve, v3 } from '@tvox/core';
import { DEFAULT_INPUT, Heist, NEUTRAL_INPUT, PORT_EXTRACTION, portLevel } from '@tvox/game';

/**
 * Цикл ограбления целиком: кабель поднимает тревогу, цель уезжает в
 * кузове, а длинная сессия не растёт в тела и воксели без предела.
 */

function heist(sandbox = false): Heist {
  const h = new Heist({ level: portLevel, sandbox });
  h.start();
  return h;
}

function blast(h: Heist, at: { x: number; y: number; z: number }, radius: number) {
  return carve(
    h.sim.world,
    { kind: 'sphere', center: at, radius },
    { power: 1.4, damage: 0, instant: true, falloff: 'quadratic', cause: 'test' },
  );
}

function frames(h: Heist, n: number): void {
  for (let i = 0; i < n; i++) h.update(1 / 60, DEFAULT_INPUT, NEUTRAL_INPUT);
}

// Кабель склада идёт по верху передней стены: локально y = 7.3 м, z = 0.3 м,
// а сама форма стоит на (6, 0, 14).
const WAREHOUSE_CABLE = { x: 12, y: 7.35, z: 14.35 };

describe('кабель сигнализации', () => {
  it('разрыв кабеля поднимает тревогу', () => {
    const h = heist();
    expect(h.mission.phase).toBe('recon');

    const res = blast(h, WAREHOUSE_CABLE, 0.5);
    expect(res.byMaterial.get(Mat.Cable) ?? 0).toBeGreaterThan(0);
    expect(h.mission.phase).toBe('alarm');
    expect(h.mission.timeLeft).toBeCloseTo(60, 3);
  });

  it('аккуратный обход кабеля оставляет тишину', () => {
    const h = heist();
    // Дыра в той же стене, но на высоте груди: кабель проложен под крышей.
    const res = blast(h, { x: 12, y: 1.6, z: 14.2 }, 0.6);
    expect(res.removed).toBeGreaterThan(0);
    expect(res.byMaterial.get(Mat.Cable) ?? 0).toBe(0);
    expect(h.mission.phase).toBe('recon');
  });

  it('повторный разрыв уже сработавшего кабеля ничего не меняет', () => {
    const h = heist();
    blast(h, WAREHOUSE_CABLE, 0.5);
    expect(h.mission.phase).toBe('alarm');

    frames(h, 60);
    const left = h.mission.timeLeft;
    expect(left).toBeLessThan(60);

    blast(h, { x: 14, y: 7.35, z: 14.35 }, 0.5);
    expect(h.mission.phase).toBe('alarm');
    // Таймер не перезапустился: он идёт с первого разрыва.
    expect(h.mission.timeLeft).toBeLessThanOrEqual(left);
  });

  it('в песочнице кабель ничего не включает', () => {
    const h = heist(true);
    blast(h, WAREHOUSE_CABLE, 0.5);
    expect(h.mission.alarmActive).toBe(false);
  });
});

describe('эвакуация транспортом', () => {
  /** Ставит игрока и пикап рядом с целью и берёт её в руки. */
  function withPickup(): { h: Heist; vehicleId: string; targetId: string } {
    const h = heist();
    const targetId = 'painting';
    const target = h.mission.target(targetId)!;
    h.character.teleport(target.position);
    const veh = [...h.vehicles.entries()].find(([, v]) => v.spec.kind === 'pickup')!;
    veh[1].position = { ...target.position };
    expect(h.mission.pickUp(targetId)).toBe(true);
    return { h, vehicleId: veh[0], targetId };
  }

  it('цель кладётся в кузов и освобождает руки', () => {
    const { h, vehicleId, targetId } = withPickup();
    expect(h.stow()).toBe(vehicleId);
    expect(h.mission.carriedIds).toHaveLength(0);
    expect(h.mission.stowedIn(vehicleId).map((t) => t.spec.id)).toEqual([targetId]);
  });

  it('груз едет вместе с машиной', () => {
    const { h, vehicleId, targetId } = withPickup();
    h.stow();
    const veh = h.vehicles.get(vehicleId)!;

    veh.position = { ...PORT_EXTRACTION.center };
    frames(h, 2);

    const t = h.mission.target(targetId)!;
    expect(Math.hypot(t.position.x - veh.position.x, t.position.z - veh.position.z)).toBeLessThan(2);
    const body = h.targetBodies.get(targetId)!;
    expect(Math.hypot(body.transform.position.x - veh.position.x)).toBeLessThan(2);
  });

  it('въезд машины с целью в зону эвакуации засчитывается', () => {
    const { h, vehicleId, targetId } = withPickup();
    h.stow();
    const veh = h.vehicles.get(vehicleId)!;

    expect(h.mission.deliveredTargets()).toHaveLength(0);
    veh.position = { ...PORT_EXTRACTION.center };
    frames(h, 3);

    expect(h.mission.deliveredTargets().map((t) => t.spec.id)).toContain(targetId);
  });

  it('разбитая машина роняет груз, и он остаётся в мире', () => {
    const { h, vehicleId, targetId } = withPickup();
    h.stow();
    const veh = h.vehicles.get(vehicleId)!;
    const where = { ...veh.position };

    veh.wrecked = true;
    frames(h, 2);

    const t = h.mission.target(targetId)!;
    expect(t.state).toBe('idle');
    expect(h.mission.stowedIn(vehicleId)).toHaveLength(0);
    // Цель лежит там, где встала машина, и её тело никуда не делось.
    const body = h.targetBodies.get(targetId)!;
    expect(body.destroyed).toBe(false);
    expect(Math.hypot(body.transform.position.x - where.x, body.transform.position.z - where.z))
      .toBeLessThan(2);
  });

  it('выгрузка возвращает цель на землю', () => {
    const { h, vehicleId, targetId } = withPickup();
    h.stow();
    expect(h.unloadCargo(vehicleId)).toBe(1);
    const t = h.mission.target(targetId)!;
    expect(t.state).toBe('idle');
  });
});

describe('длинная сессия', () => {
  it('число тел выходит на плато, а не растёт линейно', () => {
    const h = heist(true);
    h.sim.focus = v3(45, 1, 33);

    const bodiesAfter = (rounds: number): number => {
      for (let r = 0; r < rounds; r++) {
        // Долбим по стене склада: обломки копятся непрерывно.
        blast(h, { x: 8 + (r % 12) * 1.2, y: 1.5 + (r % 3), z: 14.2 }, 0.8);
        frames(h, 10);
      }
      return h.sim.world.bodies.size;
    };

    const first = bodiesAfter(20);
    const second = bodiesAfter(20);
    const third = bodiesAfter(20);

    // Рост от первой трети ко второй ещё возможен, но дальше — плато:
    // потолок обломков сливает лишнее в общую свалку.
    expect(third).toBeLessThanOrEqual(Math.max(first, second) + 4);
    expect(third).toBeLessThan(120);
  });

  it('воксели не появляются из ниоткуда', () => {
    const h = heist(true);
    const before = h.sim.world.totalSolidVoxels();
    for (let r = 0; r < 15; r++) {
      blast(h, { x: 10 + r * 0.7, y: 2, z: 14.2 }, 0.7);
      frames(h, 6);
    }
    expect(h.sim.world.totalSolidVoxels()).toBeLessThan(before);
  });

  it('рестарт освобождает всё, что накопил прошлый заход', () => {
    const h = heist(true);
    for (let r = 0; r < 10; r++) {
      blast(h, { x: 10 + r, y: 2, z: 14.2 }, 0.9);
      frames(h, 6);
    }
    const dirty = h.sim.world.bodies.size;
    expect(dirty).toBeGreaterThan(3);

    h.sim.reset();

    expect(h.sim.world.bodies.size).toBe(0);
    expect(h.sim.world.totalSolidVoxels()).toBe(0);
    expect(h.sim.destruction.pending).toBe(0);
  });
});
