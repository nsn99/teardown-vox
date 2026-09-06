import {
  Body,
  EventBus,
  Mat,
  Simulation,
  Vec3,
  VoxelShape,
  add,
  clamp,
  distance,
  normalize,
  quatFromEulerYXZ,
  scale,
  sub,
  v3,
} from '@tvox/core';

/**
 * Преследование.
 *
 * Таймер тревоги кончается вертолётом. Надпись «провал» на чёрном экране —
 * это не событие, а сообщение об ошибке; событие — это когда за двадцать
 * секунд до конца из-за воды выходит вертолёт, гул нарастает, прожектор
 * ложится на землю рядом, и ты понимаешь, что не успеваешь. Отсюда и
 * устройство: преследователь — обычное кинематическое тело из вокселей,
 * его видно, слышно и по нему даже можно попасть.
 *
 * Скорость подбирается так, чтобы преследователь пришёл ровно к нулю
 * таймера. Это не «честная» аэродинамика, зато читается однозначно:
 * насколько он близко — настолько мало времени.
 */

export type ChaserKind = 'helicopter' | 'boat';
export type PursuitPhase = 'idle' | 'inbound' | 'arrived';

export interface ChaserSpec {
  kind: ChaserKind;
  /** Точка выхода на карту, м. */
  from: Vec3;
  /** Высота, на которой он держится над целью, м. */
  hover: number;
  /** Потолок скорости, м/с. Ниже него он не догонит — так и задумано. */
  maxSpeed: number;
  /** За сколько секунд до конца таймера выходит на карту. */
  lead: number;
  /** Радиус прожектора по земле, м. */
  light: number;
  /**
   * Идёт только по воде. Катер выходит, лишь когда игрок ушёл в гавань:
   * гонять его по набережной незачем.
   */
  aquatic?: boolean;
}

export interface PursuitEvents extends Record<string, unknown> {
  'pursuit:inbound': { kind: ChaserKind; distance: number };
  'pursuit:close': { kind: ChaserKind; distance: number };
  'pursuit:arrived': { kind: ChaserKind };
}

export interface PursuitState {
  alarmActive: boolean;
  /** Секунд до конца таймера. */
  timeLeft: number;
  /** Миссия уже кончилась — преследователь просто зависает. */
  finished: boolean;
}

export interface PursuitOptions {
  specs?: ChaserSpec[];
  voxelSize?: number;
  waterLevel?: number;
  /** Расстояние, с которого преследователя вообще слышно, м. */
  audibleRange?: number;
  /** Ближе этого он считается «на хвосте», м. */
  closeRange?: number;
}

const DEFAULT_HELI: ChaserSpec = {
  kind: 'helicopter',
  from: v3(24, 48, -70),
  hover: 16,
  maxSpeed: 34,
  lead: 20,
  light: 9,
};

const DEFAULT_BOAT: ChaserSpec = {
  kind: 'boat',
  from: v3(-24, 0, 5),
  hover: 0,
  maxSpeed: 18,
  lead: 26,
  light: 7,
  aquatic: true,
};

export const DEFAULT_CHASERS: readonly ChaserSpec[] = [DEFAULT_HELI, DEFAULT_BOAT];

/** Один преследователь: состояние + тело в мире. */
export class Chaser {
  readonly spec: ChaserSpec;
  position: Vec3;
  phase: PursuitPhase = 'idle';
  body: Body | null = null;
  /** Секунд в воздухе — на это крутится винт. */
  private age = 0;
  private rotor: VoxelShape | null = null;

  constructor(spec: ChaserSpec) {
    this.spec = spec;
    this.position = { ...spec.from };
  }

  get active(): boolean {
    return this.phase !== 'idle';
  }

  /** Расстояние до точки, м. */
  distanceTo(p: Vec3): number {
    return distance(this.position, p);
  }

  reset(): void {
    this.phase = 'idle';
    this.position = { ...this.spec.from };
    this.age = 0;
    this.body = null;
    this.rotor = null;
  }

  spawn(sim: Simulation, voxelSize: number): Body {
    const body =
      this.spec.kind === 'helicopter'
        ? buildHelicopter(voxelSize)
        : buildPatrolBoat(voxelSize);
    body.transform.position = { ...this.position };
    sim.world.addBody(body);
    sim.physics.sync(body);
    this.body = body;
    this.rotor = body.shapes.find((s) => s.name.endsWith('rotor')) ?? null;
    return body;
  }

  /** Двигать к цели так, чтобы прийти ровно к нулю таймера. */
  advance(target: Vec3, timeLeft: number, dt: number): void {
    this.age += dt;
    const goal = v3(target.x, target.y + this.spec.hover, target.z);
    const delta = sub(goal, this.position);
    const d = Math.hypot(delta.x, delta.y, delta.z);
    if (d > 1e-4) {
      // Скорость — ровно та, что нужна, чтобы успеть: время кончается
      // одновременно с дистанцией. Потолок не даёт телепортироваться,
      // если игрок вдруг убежал через всю карту.
      const need = d / Math.max(0.2, timeLeft);
      const step = Math.min(d, Math.min(need, this.spec.maxSpeed) * dt);
      this.position = add(this.position, scale(normalize(delta), step));
    }
    this.syncBody(delta);
  }

  private syncBody(heading: Vec3): void {
    const body = this.body;
    if (!body) return;
    body.transform.position = { ...this.position };
    const yaw = Math.atan2(-heading.x, -heading.z);
    body.transform.rotation = quatFromEulerYXZ(yaw, 0);
    if (this.rotor) {
      // Винт — отдельная форма в том же теле: её трансформ крутится, а
      // фюзеляж стоит на месте. Иначе пришлось бы вращать весь вертолёт.
      this.rotor.transform = {
        position: this.rotor.transform.position,
        rotation: quatFromEulerYXZ(this.age * ROTOR_SPEED, 0),
      };
    }
    body.wake();
  }
}

/**
 * Погоня целиком: кто вышел, где он и насколько близко.
 *
 * Чистая логика, без единой строчки рендера и звука: приложение спрашивает
 * `proximity` и `spotlight` и рисует по ним. Поэтому это проверяется тестом,
 * а не глазами.
 */
export class Pursuit {
  readonly events = new EventBus<PursuitEvents>();
  readonly chasers: Chaser[];
  private voxelSize: number;
  private waterLevel: number;
  private audible: number;
  private close: number;
  private announced = new Set<ChaserKind>();

  constructor(opts: PursuitOptions = {}) {
    this.chasers = (opts.specs ?? DEFAULT_CHASERS).map((s) => new Chaser(s));
    this.voxelSize = opts.voxelSize ?? 0.1;
    this.waterLevel = opts.waterLevel ?? 0;
    this.audible = opts.audibleRange ?? 120;
    this.close = opts.closeRange ?? 25;
  }

  /** Общая фаза: главное — прилетел кто-нибудь или нет. */
  get phase(): PursuitPhase {
    if (this.chasers.some((c) => c.phase === 'arrived')) return 'arrived';
    return this.chasers.some((c) => c.active) ? 'inbound' : 'idle';
  }

  get active(): boolean {
    return this.phase !== 'idle';
  }

  /** Кто сейчас в воздухе или на воде. */
  activeChasers(): Chaser[] {
    return this.chasers.filter((c) => c.active);
  }

  /**
   * Насколько близко ближайший преследователь, 0..1.
   * Ноль — не слышно, единица — над головой. По этому числу приложение
   * ведёт и гул винта, и дрожание камеры.
   */
  proximity(to: Vec3): number {
    let best = 0;
    for (const c of this.activeChasers()) {
      const d = c.distanceTo(to);
      const t = 1 - (d - this.close) / Math.max(1e-6, this.audible - this.close);
      best = Math.max(best, clamp(t, 0, 1));
    }
    return best;
  }

  /** Точка ближайшего преследователя — для звука с направлением. */
  nearest(to: Vec3): Chaser | null {
    let best: Chaser | null = null;
    let bestD = Infinity;
    for (const c of this.activeChasers()) {
      const d = c.distanceTo(to);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  /** Игрок в пятне прожектора. */
  spotlight(on: Vec3): boolean {
    return this.activeChasers().some((c) => {
      const dx = c.position.x - on.x;
      const dz = c.position.z - on.z;
      return Math.hypot(dx, dz) <= c.spec.light;
    });
  }

  /**
   * Шаг погони.
   *
   * Пока идёт тревога — выпускаем тех, кому пора, и ведём их к игроку.
   * После конца миссии никто не исчезает: вертолёт остаётся висеть над
   * местом провала, потому что именно это и объясняет игроку, что было.
   */
  update(sim: Simulation, dt: number, state: PursuitState, target: Vec3): void {
    for (const c of this.chasers) {
      if (!c.active) {
        if (!this.shouldLaunch(c, state, target)) continue;
        c.phase = 'inbound';
        c.spawn(sim, this.voxelSize);
        this.events.emit('pursuit:inbound', {
          kind: c.spec.kind,
          distance: c.distanceTo(target),
        });
      }

      const timeLeft = state.finished ? 0.2 : state.timeLeft;
      c.advance(target, timeLeft, dt);

      const d = c.distanceTo(target);
      if (d <= this.close && !this.announced.has(c.spec.kind)) {
        this.announced.add(c.spec.kind);
        this.events.emit('pursuit:close', { kind: c.spec.kind, distance: d });
      }
      // Прибытие — это конец таймера, а не «долетел»: иначе игрок,
      // забежавший под вертолёт на десятой секунде, проигрывал бы раньше
      // срока, и это читалось бы как несправедливость.
      if (c.phase === 'inbound' && state.timeLeft <= 0) {
        c.phase = 'arrived';
        this.events.emit('pursuit:arrived', { kind: c.spec.kind });
      }
    }
  }

  private shouldLaunch(c: Chaser, state: PursuitState, target: Vec3): boolean {
    if (!state.alarmActive) return false;
    if (state.timeLeft > c.spec.lead) return false;
    // Катер выходит, только если игрок ушёл на воду: гонять его по
    // набережной было бы просто смешно.
    if (c.spec.aquatic && target.y > this.waterLevel + 1.2) return false;
    return true;
  }

  /** Убрать преследователей из мира. */
  reset(sim?: Simulation): void {
    for (const c of this.chasers) {
      if (c.body && sim) sim.world.removeBody(c.body);
      c.reset();
    }
    this.announced.clear();
  }
}

/** Скорость вращения винта, рад/с. */
const ROTOR_SPEED = 14;

/**
 * Вертолёт из вокселей: фюзеляж, хвостовая балка, полозья и винт отдельной
 * формой. Модель нарочно грубая — её видят снизу, ночью и полторы секунды.
 */
export function buildHelicopter(voxelSize: number): Body {
  const s = (m: number) => Math.max(1, Math.round(m / voxelSize));
  const bodyLen = s(6);
  const bodyH = s(2.2);
  const bodyW = s(2);
  const hull = new VoxelShape({
    sx: bodyLen,
    sy: bodyH,
    sz: bodyW,
    voxelSize,
    grounded: false,
    name: 'heli-hull',
  });
  hull.fill({}, Mat.Metal);
  // Кабина спереди — стеклянный нос, чтобы силуэт читался снизу.
  hull.fill({ x0: 0, x1: s(1.6), y0: s(0.6), y1: bodyH - s(0.4), z0: 2, z1: bodyW - 2 }, Mat.Glass);
  // Хвостовая балка.
  const tail = new VoxelShape({
    sx: s(4),
    sy: s(0.5),
    sz: s(0.5),
    voxelSize,
    grounded: false,
    name: 'heli-tail',
  });
  tail.fill({}, Mat.Metal);
  tail.transform = {
    position: v3(bodyLen * voxelSize, bodyH * voxelSize * 0.6, ((bodyW - s(0.5)) / 2) * voxelSize),
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };
  // Винт: отдельная форма, которая крутится вокруг своей середины.
  const span = s(7);
  const rotor = new VoxelShape({
    sx: span,
    sy: 2,
    sz: span,
    voxelSize,
    grounded: false,
    name: 'heli-rotor',
  });
  const mid = Math.floor(span / 2);
  rotor.fill({ x0: 0, x1: span, y0: 0, y1: 2, z0: mid - 1, z1: mid + 1 }, Mat.HeavyMetal);
  rotor.fill({ x0: mid - 1, x1: mid + 1, y0: 0, y1: 2, z0: 0, z1: span }, Mat.HeavyMetal);
  rotor.transform = {
    position: v3(0, bodyH * voxelSize + 0.1, 0),
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };

  // Центрируем: тело позиционируется по своей середине.
  hull.transform = {
    position: v3((-bodyLen / 2) * voxelSize, 0, (-bodyW / 2) * voxelSize),
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };
  tail.transform.position = add(tail.transform.position, hull.transform.position);

  return new Body({
    kind: 'dynamic',
    kinematic: true,
    shapes: [hull, tail, rotor],
    name: 'Вертолёт',
    tags: ['pursuit', 'helicopter'],
  });
}

/** Катер преследования: корпус с рубкой и мигалкой. */
export function buildPatrolBoat(voxelSize: number): Body {
  const s = (m: number) => Math.max(1, Math.round(m / voxelSize));
  const sx = s(7);
  const sy = s(1.8);
  const sz = s(2.4);
  const hull = new VoxelShape({
    sx,
    sy,
    sz,
    voxelSize,
    grounded: false,
    name: 'patrol-hull',
  });
  hull.fill({ y0: 0, y1: s(1) }, Mat.Metal);
  hull.fill({ x0: s(2), x1: s(4.5), y0: s(1), y1: s(1.6), z0: 2, z1: sz - 2 }, Mat.Metal);
  hull.fill({ x0: s(2.2), x1: s(4.3), y0: s(1.1), y1: s(1.5), z0: 3, z1: sz - 3 }, Mat.Glass);
  // Мигалка: единственный воксель, который светится.
  hull.fill({ x0: s(3), x1: s(3.4), y0: s(1.6), y1: s(1.8), z0: s(1), z1: s(1.4) }, Mat.Cable);
  hull.transform = {
    position: v3((-sx / 2) * voxelSize, 0, (-sz / 2) * voxelSize),
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };
  return new Body({
    kind: 'dynamic',
    kinematic: true,
    shapes: [hull],
    name: 'Катер преследования',
    tags: ['pursuit', 'boat'],
  });
}
