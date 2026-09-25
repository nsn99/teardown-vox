import { describe, expect, it } from 'vitest';
import { Mat, Simulation, stepStructure, v3 } from '@tvox/core';
import {
  DEFAULT_INPUT,
  Heist,
  PORT_EXTRACTION,
  PORT_TARGETS,
  Profile,
  TriggerDef,
  TriggerSystem,
  portLevel,
} from '@tvox/game';

/** Наводит взгляд игрока в заданную точку мира. */
function aimAt(h: Heist, point: { x: number; y: number; z: number }): void {
  const eye = h.eye;
  const dx = point.x - eye.x;
  const dy = point.y - eye.y;
  const dz = point.z - eye.z;
  const len = Math.hypot(dx, dy, dz);
  h.yaw = Math.atan2(-dx, -dz);
  h.pitch = Math.asin(dy / len);
}

const trigger = (over: Partial<TriggerDef> = {}): TriggerDef => ({
  id: 't1',
  kind: 'checkpoint',
  center: v3(0, 0, 0),
  halfExtents: v3(1, 1, 1),
  ...over,
});

describe('триггеры-объёмы', () => {
  it('вход и выход шлют события', () => {
    const sys = new TriggerSystem([trigger()]);
    const log: string[] = [];
    sys.events.on('trigger:entered', (e) => log.push(`in:${e.trigger.id}`));
    sys.events.on('trigger:exited', (e) => log.push(`out:${e.trigger.id}`));

    expect(sys.update('player', v3(5, 0, 0))).toHaveLength(0);
    expect(sys.update('player', v3(0, 0, 0))).toHaveLength(1);
    expect(sys.update('player', v3(0, 0, 0))).toHaveLength(0);
    expect(sys.isInside('player', 't1')).toBe(true);
    sys.update('player', v3(9, 0, 0));
    expect(log).toEqual(['in:t1', 'out:t1']);
  });

  it('одноразовый триггер срабатывает один раз', () => {
    const sys = new TriggerSystem([trigger({ once: true })]);
    expect(sys.update('p', v3(0, 0, 0))).toHaveLength(1);
    sys.update('p', v3(9, 0, 0));
    expect(sys.update('p', v3(0, 0, 0))).toHaveLength(0);
  });

  it('разные сущности отслеживаются независимо', () => {
    const sys = new TriggerSystem([trigger()]);
    sys.update('a', v3(0, 0, 0));
    expect(sys.isInside('a', 't1')).toBe(true);
    expect(sys.isInside('b', 't1')).toBe(false);
    expect(sys.update('b', v3(0, 0, 0))).toHaveLength(1);
  });

  it('добавление, поиск и сброс', () => {
    const sys = new TriggerSystem();
    sys.add(trigger({ id: 'x' }));
    expect(sys.byId('x')).toBeDefined();
    expect(sys.byId('нет')).toBeUndefined();
    expect(sys.triggers).toHaveLength(1);
    sys.update('p', v3(0, 0, 0));
    sys.reset();
    expect(sys.isInside('p', 'x')).toBe(false);
  });
});

describe('карта M: порт', () => {
  it('строится и содержит все заявленные объекты', () => {
    const sim = new Simulation();
    const bodies = portLevel.build(sim);
    expect(bodies.length).toBeGreaterThan(2);
    const level = bodies[0];
    expect(level.shapes.map((s) => s.name)).toEqual([
      'ground',
      'warehouse',
      'office',
      'crane',
      'pier',
      'containers',
      'fence',
    ]);
    expect(level.solidVoxels).toBeGreaterThan(100_000);
  });

  it('уровень не разрушает сам себя: ни одного обломка на старте', () => {
    const sim = new Simulation();
    portLevel.build(sim);
    const before = sim.world.totalSolidVoxels();
    // Форсируем полный структурный расчёт по всему уровню.
    for (const body of sim.world.bodies.values()) {
      for (const s of body.shapes) s.markDirty(0, 0, 0);
    }
    const res = stepStructure(sim.world, { stress: true });
    expect(res.stressFailures).toBe(0);
    expect(res.fragments).toHaveLength(0);
    expect(res.dustVoxels).toBe(0);
    expect(sim.world.totalSolidVoxels()).toBe(before);
  });

  it('в гавани есть вода, и она пассивна', () => {
    const sim = new Simulation();
    portLevel.build(sim);
    const water = [...sim.world.bodies.values()].find((b) => b.tags.has('water'))!;
    expect(water.passive).toBe(true);
    expect(water.solidVoxels).toBeGreaterThan(0);
  });

  it('точка спавна стоит на твёрдом и внутри зоны эвакуации', () => {
    const sim = new Simulation();
    portLevel.build(sim);
    const spawn = portLevel.spawn.position;
    const below = sim.world.raycast(
      v3(spawn.x, spawn.y + 1, spawn.z),
      v3(0, -1, 0),
      { maxDistance: 3 },
    );
    expect(below).not.toBeNull();
    expect(
      Math.abs(spawn.x - PORT_EXTRACTION.center.x) <= PORT_EXTRACTION.halfExtents.x,
    ).toBe(true);
  });

  it('цели существуют как тела и помечены тегами', () => {
    const sim = new Simulation();
    portLevel.build(sim);
    for (const spec of PORT_TARGETS) {
      const body = [...sim.world.bodies.values()].find((b) => b.tags.has(`target:${spec.id}`));
      expect(body, spec.id).toBeDefined();
      expect(body!.solidVoxels).toBeGreaterThan(0);
    }
  });

  it('две обязательные цели, обе на кабеле', () => {
    const required = PORT_TARGETS.filter((t) => t.required);
    expect(required).toHaveLength(2);
    expect(required.every((t) => t.wired)).toBe(true);
    expect(PORT_TARGETS.filter((t) => !t.required)).toHaveLength(3);
  });

  it('таймер тревоги — ровно 60 секунд', () => {
    expect(portLevel.mission.alarmSeconds).toBe(60);
  });

  it('вся техника из дизайн-документа расставлена', () => {
    const kinds = new Set(portLevel.vehicles.map((v) => v.kind));
    expect(kinds).toEqual(new Set(['pickup', 'car', 'boat', 'bulldozer', 'excavator']));
  });
});

describe('прохождение ограбления', () => {
  function startedHeist(profile = new Profile()): Heist {
    const h = new Heist({ level: portLevel, profile });
    h.start();
    return h;
  }

  it('старт создаёт мир, технику и цели', () => {
    const h = startedHeist();
    expect(h.sim.world.bodies.size).toBeGreaterThan(5);
    expect(h.vehicles.size).toBe(portLevel.vehicles.length);
    expect(h.targetBodies.size).toBe(PORT_TARGETS.length);
    expect(h.mission.phase).toBe('recon');
  });

  it('повторный start ничего не дублирует', () => {
    const h = startedHeist();
    const n = h.sim.world.bodies.size;
    h.start();
    expect(h.sim.world.bodies.size).toBe(n);
  });

  it('взятие проводной цели включает таймер, доставка приносит деньги', () => {
    const profile = new Profile();
    const h = startedHeist(profile);
    const events: string[] = [];
    h.events.on('target:picked', (e) => events.push(`pick:${e.id}`));
    h.events.on('heist:finished', (r) => events.push(`end:${r.success}`));

    // Ставим игрока рядом с папкой и наводим прицел точно на неё.
    // Сейф для этого не годится: сто восемьдесят килограммов руками не
    // берут — на то есть отдельная проверка и отдельная техника.
    const painting = PORT_TARGETS.find((t) => t.id === 'painting')!;
    h.character.teleport(v3(painting.position.x, 0.35, painting.position.z + 1.5));
    aimAt(h, v3(painting.position.x, painting.position.y + 0.4, painting.position.z));
    expect(h.interact()).toBe('painting');
    // Картина без провода: взяли тихо, таймер не пошёл.
    expect(h.mission.phase).toBe('recon');

    // Проводная цель включает таймер. Остальное отдаём напрямую — важна
    // механика доставки, а не путь по карте.
    h.mission.drop('painting', PORT_EXTRACTION.center);
    expect(h.mission.pickUp('docs')).toBe(true);
    expect(h.mission.phase).toBe('alarm');
    h.mission.drop('docs', PORT_EXTRACTION.center);
    // Сейф едет в кузове: сам он в зону эвакуации не дойдёт.
    const van = h.vehicles.get('van')!;
    van.position = { ...PORT_EXTRACTION.center };
    h.mission.stow('safe', 'van', van.position);
    h.character.teleport(PORT_EXTRACTION.center);
    h.update(0.1, DEFAULT_INPUT);

    expect(h.mission.phase).toBe('success');
    expect(profile.money).toBeGreaterThan(0);
    expect(events).toContain('end:true');
  });

  it('просроченный таймер — провал без денег', () => {
    const profile = new Profile();
    const h = startedHeist(profile);
    h.mission.triggerAlarm('test');
    for (let i = 0; i < 61; i++) h.update(1, DEFAULT_INPUT);
    expect(h.mission.phase).toBe('failed');
    expect(h.mission.result!.reason).toBe('timeout');
    expect(profile.money).toBe(0);
  });

  it('инструмент работает по прицелу и ломает уровень', () => {
    const h = startedHeist();
    const level = [...h.sim.world.bodies.values()].find((b) => b.tags.has('level'))!;
    const before = level.solidVoxels;
    // Кирпичная стена: бетонный пол кувалда намеренно не берёт.
    h.character.teleport(v3(12, 0.05, 15.2));
    h.yaw = 0;
    h.pitch = 0;
    h.inventory.select('sledge');
    let removed = 0;
    for (let i = 0; i < 10; i++) {
      removed += h.use().removed ?? 0;
      h.inventory.tick(1);
    }
    expect(removed).toBeGreaterThan(0);
    expect(level.solidVoxels).toBeLessThan(before);
  });

  it('цели не разрушаются инструментами', () => {
    const h = startedHeist();
    const safe = h.targetBodies.get('safe')!;
    const before = safe.solidVoxels;
    h.inventory.select('explosive');
    const spec = PORT_TARGETS[0];
    h.character.teleport(v3(spec.position.x, 0.35, spec.position.z + 1.5));
    aimAt(h, v3(spec.position.x, spec.position.y + 0.4, spec.position.z));
    h.use();
    h.charges.detonateAll(h.sim, new Set([Mat.Loot]));
    expect(safe.solidVoxels).toBe(before);
  });

  it('в песочнице нет таймера и расходников', () => {
    const h = new Heist({ level: portLevel, sandbox: true });
    h.start();
    expect(h.mission.phase).toBe('briefing');
    const before = h.inventory.ammo('explosive');
    h.inventory.consume('explosive');
    expect(h.inventory.ammo('explosive')).toBe(before);
    h.update(120, DEFAULT_INPUT);
    expect(h.mission.phase).toBe('briefing');
  });

  it('садится в технику и выходит', () => {
    const h = startedHeist();
    const van = portLevel.vehicles[0];
    h.character.teleport(van.position);
    expect(h.toggleVehicle()).toBe('van');
    expect(h.driving).not.toBeNull();
    expect(h.playerPosition.x).toBeCloseTo(van.position.x, 3);
    expect(h.toggleVehicle()).toBe('van');
    expect(h.driving).toBeNull();
  });

  it('вдали от техники сесть не в что', () => {
    const h = startedHeist();
    h.character.teleport(v3(-100, 0, -100));
    expect(h.toggleVehicle()).toBeNull();
  });

  it('несомая цель едет вместе с игроком', () => {
    const h = startedHeist();
    h.mission.pickUp('painting');
    h.character.teleport(v3(20, 1, 20));
    h.update(1 / 60, DEFAULT_INPUT);
    const body = h.targetBodies.get('painting')!;
    expect(body.transform.position.x).toBeCloseTo(h.eye.x + h.aimDirection.x * 1.1, 3);
  });

  it('положить цель можно обратно в мир', () => {
    const h = startedHeist();
    h.mission.pickUp('painting');
    expect(h.interact()).toBe('painting');
    expect(h.mission.targets.get('painting')!.state).toBe('idle');
  });

  it('взгляд не на цель ничего не берёт', () => {
    const h = startedHeist();
    h.character.teleport(v3(45, 0.1, 33));
    h.pitch = 0.5;
    expect(h.interact()).toBeNull();
  });

  it('рестарт возвращает уровень в исходное состояние', () => {
    const h = startedHeist();
    h.character.teleport(v3(12, 0.05, 15.2));
    h.yaw = 0;
    h.pitch = 0;
    for (let i = 0; i < 5; i++) {
      h.use();
      h.inventory.tick(1);
    }
    const damaged = h.sim.world.totalSolidVoxels();
    h.restart();
    expect(h.sim.world.totalSolidVoxels()).toBeGreaterThan(damaged);
    expect(h.mission.phase).toBe('recon');
    expect(h.driving).toBeNull();
  });

  it('шаг игры двигает и мир, и миссию', () => {
    const h = startedHeist();
    h.mission.triggerAlarm('test');
    const t0 = h.mission.timeLeft;
    h.update(1, DEFAULT_INPUT);
    expect(h.mission.timeLeft).toBeLessThan(t0);
    expect(h.sim.world.time).toBeGreaterThan(0);
  });
});
