import { describe, expect, it } from 'vitest';
import { Simulation, v3 } from '@tvox/core';
import {
  AudioDirector,
  ChaserSpec,
  DEFAULT_CHASERS,
  Heist,
  Pursuit,
  buildHelicopter,
  portLevel,
} from '@tvox/game';

/**
 * Преследование.
 *
 * Провал должен читаться как событие, а не как надпись. Проверяем ровно
 * это: вертолёт выходит заранее, приближается предсказуемо, приходит
 * одновременно с нулём таймера — и ни секундой раньше.
 */

const HELI: ChaserSpec = {
  kind: 'helicopter',
  from: v3(0, 40, -100),
  hover: 15,
  maxSpeed: 40,
  lead: 20,
  light: 9,
};

const BOAT: ChaserSpec = {
  kind: 'boat',
  from: v3(-40, 0, 0),
  hover: 0,
  maxSpeed: 20,
  lead: 25,
  light: 7,
  aquatic: true,
};

function scene(specs: ChaserSpec[] = [HELI], waterLevel = -0.4) {
  return { sim: new Simulation(), pursuit: new Pursuit({ specs, waterLevel }) };
}

/** Прокрутить тревогу от timeLeft до нуля с шагом dt. */
function runAlarm(
  pursuit: Pursuit,
  sim: Simulation,
  target: { x: number; y: number; z: number },
  from = 30,
  dt = 1 / 30,
): void {
  for (let t = from; t > 0; t -= dt) {
    pursuit.update(sim, dt, { alarmActive: true, timeLeft: t, finished: false }, target);
  }
  pursuit.update(sim, dt, { alarmActive: true, timeLeft: 0, finished: false }, target);
}

describe('преследование', () => {
  const at = v3(20, 1, 20);

  it('без тревоги никто не выходит', () => {
    const { sim, pursuit } = scene();
    for (let i = 0; i < 60; i++) {
      pursuit.update(sim, 1 / 30, { alarmActive: false, timeLeft: 60, finished: false }, at);
    }
    expect(pursuit.phase).toBe('idle');
    expect(pursuit.activeChasers().length).toBe(0);
    expect(sim.world.bodies.size).toBe(0);
  });

  it('вертолёт выходит не раньше своего срока', () => {
    const { sim, pursuit } = scene();
    pursuit.update(sim, 0.1, { alarmActive: true, timeLeft: 21, finished: false }, at);
    expect(pursuit.phase).toBe('idle');
    pursuit.update(sim, 0.1, { alarmActive: true, timeLeft: 19.5, finished: false }, at);
    expect(pursuit.phase).toBe('inbound');
    // И появляется в мире телом, а не абстракцией.
    expect(sim.world.bodies.size).toBe(1);
    const body = [...sim.world.bodies.values()][0];
    expect(body.tags.has('pursuit')).toBe(true);
    expect(body.solidVoxels).toBeGreaterThan(0);
  });

  it('к нулю таймера он ровно над целью', () => {
    const { sim, pursuit } = scene();
    runAlarm(pursuit, sim, at);
    const heli = pursuit.chasers[0];
    // «Над целью» — это на высоте зависания, а не в самой цели.
    expect(heli.distanceTo(at)).toBeLessThan(HELI.hover + 1);
    expect(heli.position.y).toBeGreaterThan(at.y + HELI.hover - 1);
    expect(pursuit.phase).toBe('arrived');
  });

  it('близость растёт, а не скачет', () => {
    const { sim, pursuit } = scene();
    const seen: number[] = [];
    for (let t = 20; t > 0; t -= 0.5) {
      pursuit.update(sim, 0.5, { alarmActive: true, timeLeft: t, finished: false }, at);
      seen.push(pursuit.proximity(at));
    }
    expect(seen[0]).toBeLessThan(0.35);
    expect(seen[seen.length - 1]).toBeGreaterThan(0.9);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] - 1e-9);
    }
  });

  it('прожектор ложится на игрока только вблизи', () => {
    const { sim, pursuit } = scene();
    pursuit.update(sim, 0.1, { alarmActive: true, timeLeft: 19, finished: false }, at);
    expect(pursuit.spotlight(at)).toBe(false);
    runAlarm(pursuit, sim, at, 19);
    expect(pursuit.spotlight(at)).toBe(true);
    // В тридцати метрах в стороне — уже нет.
    expect(pursuit.spotlight(v3(at.x + 30, at.y, at.z))).toBe(false);
  });

  it('о подлёте сообщается один раз, о прибытии — тоже', () => {
    const { sim, pursuit } = scene();
    let inbound = 0;
    let close = 0;
    let arrived = 0;
    pursuit.events.on('pursuit:inbound', () => inbound++);
    pursuit.events.on('pursuit:close', () => close++);
    pursuit.events.on('pursuit:arrived', () => arrived++);

    runAlarm(pursuit, sim, at);
    // Ещё несколько кадров после нуля: повторов быть не должно.
    for (let i = 0; i < 10; i++) {
      pursuit.update(sim, 1 / 30, { alarmActive: false, timeLeft: 0, finished: true }, at);
    }
    expect(inbound).toBe(1);
    expect(close).toBe(1);
    expect(arrived).toBe(1);
  });

  it('катер не выходит на сушу', () => {
    const land = v3(20, 1.5, 20);
    const { sim, pursuit } = scene([BOAT]);
    runAlarm(pursuit, sim, land);
    expect(pursuit.phase).toBe('idle');
    expect(sim.world.bodies.size).toBe(0);
  });

  it('катер выходит, если игрок ушёл на воду', () => {
    const water = v3(20, -0.4, 5);
    const { sim, pursuit } = scene([BOAT]);
    pursuit.update(sim, 0.1, { alarmActive: true, timeLeft: 24, finished: false }, water);
    expect(pursuit.phase).toBe('inbound');
    expect([...sim.world.bodies.values()][0].tags.has('boat')).toBe(true);
  });

  it('винт крутится, а фюзеляж — нет', () => {
    const { sim, pursuit } = scene();
    pursuit.update(sim, 0.1, { alarmActive: true, timeLeft: 19, finished: false }, at);
    const body = pursuit.chasers[0].body!;
    const rotor = body.shapes.find((s) => s.name === 'heli-rotor')!;
    const hull = body.shapes.find((s) => s.name === 'heli-hull')!;
    const before = { ...rotor.transform.rotation };
    const hullBefore = { ...hull.transform.rotation };
    for (let i = 0; i < 10; i++) {
      pursuit.update(sim, 1 / 30, { alarmActive: true, timeLeft: 18, finished: false }, at);
    }
    expect(rotor.transform.rotation.y).not.toBe(before.y);
    expect(hull.transform.rotation).toEqual(hullBefore);
  });

  it('сброс убирает преследователей из мира', () => {
    const { sim, pursuit } = scene([HELI, BOAT]);
    pursuit.update(sim, 0.1, { alarmActive: true, timeLeft: 10, finished: false }, v3(20, -0.4, 5));
    expect(sim.world.bodies.size).toBe(2);
    pursuit.reset(sim);
    expect(pursuit.phase).toBe('idle');
    expect(pursuit.chasers.every((c) => c.body === null)).toBe(true);
    expect(pursuit.chasers[0].position).toEqual(HELI.from);
    // Тело помечено на удаление и уходит на ближайшем шаге мира.
    sim.step(1 / 60);
    expect([...sim.world.bodies.values()].filter((b) => b.tags.has('pursuit')).length).toBe(0);
  });

  it('умолчания есть и они разумные', () => {
    expect(DEFAULT_CHASERS.length).toBe(2);
    expect(DEFAULT_CHASERS[0].kind).toBe('helicopter');
    // Вертолёт должен успевать: путь от точки входа за отведённые секунды.
    const d = Math.hypot(DEFAULT_CHASERS[0].from.x - 24, DEFAULT_CHASERS[0].from.y, DEFAULT_CHASERS[0].from.z);
    expect(d / DEFAULT_CHASERS[0].lead).toBeLessThan(DEFAULT_CHASERS[0].maxSpeed);
  });

  it('модель вертолёта — три формы и целый корпус', () => {
    const body = buildHelicopter(0.1);
    expect(body.shapes.map((s) => s.name)).toEqual(['heli-hull', 'heli-tail', 'heli-rotor']);
    expect(body.kinematic).toBe(true);
    for (const s of body.shapes) expect(s.solidVoxels).toBeGreaterThan(0);
  });

  it('звук винта громче и выше по мере приближения', () => {
    const director = new AudioDirector();
    const far = director
      .update(1 / 30, v3(), { alarmActive: true, timeLeft: 20, alarmSeconds: 60, pursuit: 0.1 })
      .find((c) => c.id === 'rotor');
    const near = director
      .update(1 / 30, v3(), { alarmActive: true, timeLeft: 1, alarmSeconds: 60, pursuit: 0.95 })
      .find((c) => c.id === 'rotor');
    expect(far).toBeTruthy();
    expect(near!.gain).toBeGreaterThan(far!.gain);
    expect(near!.pitch).toBeGreaterThan(far!.pitch);
    expect(near!.loop).toBe(true);

    // Пока никого нет — тишина.
    const quiet = director
      .update(1 / 30, v3(), { alarmActive: true, timeLeft: 40, alarmSeconds: 60 })
      .find((c) => c.id === 'rotor');
    expect(quiet).toBeUndefined();
  });
});

describe('преследование в ограблении', () => {
  it('провал по таймеру приводит вертолёт, успех — нет', () => {
    const heist = new Heist({ level: portLevel });
    heist.start();
    // Форсируем тревогу и досчитываем таймер до нуля крупным шагом.
    heist.mission.triggerAlarm('test');
    const step = 0.5;
    for (let t = 0; t < heist.mission.config.alarmSeconds + 1; t += step) {
      heist.update(step);
      if (heist.mission.finished) break;
    }
    expect(heist.mission.result?.reason).toBe('timeout');
    expect(heist.pursuit.phase).toBe('arrived');
    // Вертолёт остаётся висеть над местом провала: это и объясняет игроку,
    // что случилось, без единой надписи.
    expect(heist.pursuit.nearest(heist.playerPosition)!.distanceTo(heist.playerPosition)).toBeLessThan(
      20,
    );

    // Рестарт убирает погоню и возвращает карту в исходное.
    heist.restart();
    expect(heist.pursuit.phase).toBe('idle');
    expect([...heist.sim.world.bodies.values()].some((b) => b.tags.has('pursuit'))).toBe(false);
  });

  it('в песочнице никто не летает', () => {
    const heist = new Heist({ level: portLevel, sandbox: true });
    heist.start();
    for (let i = 0; i < 30; i++) heist.update(1);
    expect(heist.pursuit.phase).toBe('idle');
  });
});
