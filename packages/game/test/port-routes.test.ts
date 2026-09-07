import { describe, expect, it } from 'vitest';
import { Vec3, v3 } from '@tvox/core';
import { EscapeRoute, Heist, Inventory, PlankBuilder, portLevel } from '@tvox/game';

/**
 * Наполнение карты: маршруты, ценности, задачи.
 *
 * Приёмка issue написана словами — «три маршрута укладываются в минуту»,
 * «есть задача, решаемая только техникой». Слова проверять нечем, поэтому
 * маршруты живут в самой карте, а этот файл проходит их настоящим
 * контроллером игрока по настоящей геометрии.
 *
 * Смысл в том, что карта — это код, который ломается. Передвинули
 * контейнер, переставили экскаватор — и путь отхода, который автор
 * когда-то прошёл руками, перестал существовать. Здесь это падает в CI,
 * а не в чужом прохождении.
 */

function heist(): Heist {
  const h = new Heist({ level: portLevel, sandbox: true });
  h.start();
  return h;
}

const flat = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
const routes = (): EscapeRoute[] => portLevel.routes ?? [];
const onFoot = () => routes().filter((r) => r.needs === 'foot');

/**
 * Пройти по точкам маршрута.
 *
 * Ходок примитивный: смотрит на следующую точку, идёт вперёд, прыгает,
 * когда упёрся. Именно поэтому он и годится в проверку — если маршрут
 * проходит такой, значит он проходит и человек. Умный ходок доказывал бы
 * качество поиска пути, а не качество карты.
 */
function walk(h: Heist, points: readonly Vec3[], limit = 60) {
  const dt = 1 / 60;
  let t = 0;
  h.character.teleport({ ...points[0] });
  for (let i = 1; i < points.length; i++) {
    const goal = points[i];
    let stuck = 0;
    let prev = { ...h.character.position };
    let arrived = false;
    while (t < limit) {
      const p = h.character.position;
      h.yaw = Math.atan2(-(goal.x - p.x), -(goal.z - p.z));
      stuck = Math.hypot(p.x - prev.x, p.z - prev.z) < 0.005 ? stuck + dt : 0;
      prev = { ...p };
      h.update(dt, { forward: 1, right: 0, jump: stuck > 0.2, sprint: true, crouch: false });
      t += dt;
      if (flat(h.character.position, goal) < 1.2) {
        arrived = true;
        break;
      }
    }
    if (!arrived) return { ok: false, t, leg: i, at: { ...h.character.position }, goal };
  }
  return { ok: true, t, leg: points.length - 1, at: { ...h.character.position }, goal: points[points.length - 1] };
}

/** Точки вдоль ломаной через каждый метр. */
function samples(r: EscapeRoute): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 1; i < r.waypoints.length; i++) {
    const a = r.waypoints[i - 1];
    const b = r.waypoints[i];
    const len = flat(a, b);
    for (let d = 0; d < len; d += 1) {
      const k = d / Math.max(len, 1e-6);
      out.push(v3(a.x + (b.x - a.x) * k, a.y, a.z + (b.z - a.z) * k));
    }
  }
  out.push(r.waypoints[r.waypoints.length - 1]);
  return out;
}

/** Расстояние от точки до ломаной маршрута, м. */
function distanceTo(p: Vec3, r: EscapeRoute): number {
  let best = Infinity;
  for (let i = 1; i < r.waypoints.length; i++) {
    const a = r.waypoints[i - 1];
    const b = r.waypoints[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t)));
  }
  return best;
}

/**
 * Насколько два маршрута идут по одному и тому же месту, 0..1.
 *
 * Последние метры у эвакуации не считаем: там сходятся все пути по
 * определению — зона эвакуации одна. Считаем середину, ту, ради которой
 * маршрут и выбирают.
 */
function overlap(a: EscapeRoute, b: EscapeRoute): number {
  const ex = portLevel.mission.extraction.center;
  const mid = samples(a).filter((p) => flat(p, ex) > 10);
  if (mid.length === 0) return 1;
  return mid.filter((p) => distanceTo(p, b) < 4).length / mid.length;
}

describe('пути отхода порта', () => {
  it('карта заявляет не меньше трёх пеших маршрутов', () => {
    expect(onFoot().length).toBeGreaterThanOrEqual(3);
    for (const r of routes()) {
      expect(r.waypoints.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('каждый пеший маршрут проходится и укладывается в таймер', () => {
    const alarm = portLevel.mission.alarmSeconds;
    for (const r of onFoot()) {
      const h = heist();
      const res = walk(h, r.waypoints, alarm);
      expect(
        `${r.name}: ${res.ok ? 'прошёл' : `застрял на ноге ${res.leg} в ` +
          `(${res.at.x.toFixed(1)}, ${res.at.z.toFixed(1)}), цель (${res.goal.x}, ${res.goal.z})`}`,
      ).toBe(`${r.name}: прошёл`);
      expect(res.t).toBeLessThan(alarm);
    }
  }, 300000);

  it('каждый маршрут заканчивается в зоне эвакуации', () => {
    const ex = portLevel.mission.extraction;
    for (const r of routes()) {
      const last = r.waypoints[r.waypoints.length - 1];
      expect(Math.abs(last.x - ex.center.x)).toBeLessThanOrEqual(ex.halfExtents.x + 1);
      expect(Math.abs(last.z - ex.center.z)).toBeLessThanOrEqual(ex.halfExtents.z + 1);
    }
  });

  it('маршруты действительно разные, а не один и тот же в трёх видах', () => {
    const list = onFoot();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        // У эвакуации все пути сходятся — это не совпадение маршрутов, а
        // одна зона. Совпасть целиком они не имеют права.
        expect(`${list[i].id}/${list[j].id}: ${overlap(list[i], list[j]).toFixed(2)}`)
          .toBe(`${list[i].id}/${list[j].id}: ${Math.min(overlap(list[i], list[j]), 0.5).toFixed(2)}`);
      }
    }
  });

  it('все пять ценностей лежат на маршрутах, но ни один не собирает всё', () => {
    const all = portLevel.mission.targets.map((t) => t.id);
    expect(all.length).toBe(5);

    const covered = new Set(routes().flatMap((r) => r.collects ?? []));
    for (const id of all) expect([...covered]).toContain(id);

    for (const r of routes()) {
      expect((r.collects ?? []).length).toBeLessThan(all.length);
    }
    // И унести всё за один заход нельзя даже теоретически: руки одни.
    expect(portLevel.mission.maxCarried).toBe(1);
  });

  it('ценности с маршрута действительно рядом с ним', () => {
    for (const r of routes()) {
      for (const id of r.collects ?? []) {
        const t = portLevel.mission.targets.find((x) => x.id === id);
        expect(t, `${r.id} обещает ценность «${id}», которой на карте нет`).toBeDefined();
        const near = Math.min(...r.waypoints.map((w) => flat(t!.position, w)));
        // Двадцать метров — это «по пути, с заходом», а не «через всю карту».
        expect(`${r.id}/${id}: ${near.toFixed(0)} м`).toBe(`${r.id}/${id}: ${Math.min(near, 20).toFixed(0)} м`);
      }
    }
  });
});

describe('задачи, которые решаются не ногами', () => {
  it('сейф руками не поднять — только техникой', () => {
    const h = heist();
    const safe = portLevel.mission.targets.find((t) => t.id === 'safe')!;
    expect(safe.mass).toBeGreaterThan(60);

    // Стоим вплотную, целимся точно — и всё равно не берём.
    h.character.teleport(v3(safe.position.x, 0.35, safe.position.z + 1.2));
    expect(h.mission.canLift('safe')).toBe(false);
    expect(h.mission.pickUp('safe')).toBe(false);
    // Неудачная попытка ничего не ломает: таймер не пошёл.
    expect(h.mission.phase).toBe('briefing');

    // Подогнали пикап — закатили. Руки при этом свободны.
    const van = h.vehicles.get('van')!;
    van.position = v3(safe.position.x, 0.1, safe.position.z + 1.2);
    h.character.teleport(v3(safe.position.x, 0.35, safe.position.z + 1.0));
    expect(h.stow()).toBe('van');
    expect(h.mission.targets.get('safe')!.state).toBe('stowed');
    expect(h.mission.carriedIds).toEqual([]);
  }, 60000);

  it('лёгкое поднимается руками, тяжёлое — нет', () => {
    const h = heist();
    expect(h.mission.canLift('docs')).toBe(true);
    expect(h.mission.canLift('painting')).toBe(true);
    expect(h.mission.canLift('electronics')).toBe(true);
    expect(h.mission.canLift('cash')).toBe(true);
    expect(h.mission.canLift('safe')).toBe(false);
  }, 60000);

  it('сумка на контейнерах: пешком не достать, по доске — достать', () => {
    const cash = portLevel.mission.targets.find((t) => t.id === 'cash')!;
    expect(cash.position.y).toBeGreaterThan(2.5);

    // Пешком: подходим вплотную и прыгаем сорок секунд подряд.
    const foot = heist();
    // Заходим с юга — из прохода за контейнерами, того самого, по
    // которому идёт маршрут отхода.
    foot.character.teleport(v3(cash.position.x, 0.9, cash.position.z + 2.5));
    let top = 0;
    for (let i = 0; i < 40 * 60; i++) {
      const p = foot.character.position;
      foot.yaw = Math.atan2(-(cash.position.x - p.x), -(cash.position.z - p.z));
      foot.update(1 / 60, { forward: 1, right: 0, jump: true, sprint: true, crouch: false });
      top = Math.max(top, foot.character.position.y);
    }
    // Выше метра игрок так и не поднялся: борт контейнера не берётся.
    expect(`выше всего ${top.toFixed(1)} м`).toBe(`выше всего ${Math.min(top, 1.5).toFixed(1)} м`);

    // С доской: тянем пандус от земли на крышу контейнера и поднимаемся.
    const h = heist();
    const inv = new Inventory({ unlimited: true });
    inv.select('planks');
    const builder = new PlankBuilder();
    builder.width = 8;
    // Пандус наискось вдоль прохода: в лоб борт не взять — уклон вышел бы
    // почти отвесным, а по такой доске не поднимаются.
    const base = v3(cash.position.x + 4, 0.05, cash.position.z + 2.3);
    const ledge = v3(cash.position.x + 1.5, cash.position.y - 0.4, cash.position.z + 1.3);
    const ctx = () => ({ ...h.toolContext(), inventory: inv });

    // Первый клик — низ пандуса, второй — край крыши.
    aim(h, base);
    expect(builder.click({ ...ctx(), origin: eyeNear(base), direction: down() }).reason).toBe(
      'needs-second-point',
    );
    // Второй клик — сверху вниз на край крыши: так точка удара не зависит
    // от того, попал ли луч в самую кромку борта.
    const built = builder.click({
      ...ctx(),
      origin: v3(ledge.x, ledge.y + 2.5, ledge.z),
      direction: down(),
    });
    expect(built.used, `доска не встала: ${built.reason}`).toBe(true);

    // Идём по пандусу, а не сквозь борт: наверх, потом к сумке.
    const up = walk(
      h,
      [
        v3(base.x, 0.9, base.z),
        v3(ledge.x, cash.position.y, ledge.z),
        v3(cash.position.x, cash.position.y, cash.position.z),
      ],
      40,
    );
    expect(
      `по доске: ${up.ok ? 'поднялся' : `застрял на ноге ${up.leg} в ` +
        `(${up.at.x.toFixed(1)}, ${up.at.y.toFixed(1)}, ${up.at.z.toFixed(1)})`}`,
    ).toBe('по доске: поднялся');
    // И оказался наверху, а не обошёл понизу.
    expect(h.character.position.y).toBeGreaterThan(2);
  }, 300000);
});

function aim(h: Heist, at: Vec3): void {
  const e = h.eye;
  h.yaw = Math.atan2(-(at.x - e.x), -(at.z - e.z));
  h.pitch = Math.atan2(at.y - e.y, Math.hypot(at.x - e.x, at.z - e.z));
}
const eyeNear = (p: Vec3) => v3(p.x, p.y + 2, p.z);
const down = () => v3(0, -1, 0);
