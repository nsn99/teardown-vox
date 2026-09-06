import {
  Body,
  EventBus,
  Mat,
  Simulation,
  SimulationOptions,
  Vec3,
  add,
  normalize,
  scale,
  v3,
} from '@tvox/core';
import { CharacterController, CharacterInput, overlapsSolid } from './character.js';
import { Inventory } from './inventory.js';
import { LevelSource, TriggerDef, TriggerSystem } from './level.js';
import { Mission, MissionResult } from './mission.js';
import { Profile } from './progression.js';
import { Pursuit } from './pursuit.js';
import { ChargeSystem, PlankBuilder, ToolContext, ToolUseResult, useTool } from './tool-use.js';
import { CARGO_OFFSET, NEUTRAL_INPUT, Vehicle, VehicleInput } from './vehicles.js';

export interface HeistOptions {
  level: LevelSource;
  profile?: Profile;
  /** Песочница: без таймера, без расходников, без начисления денег. */
  sandbox?: boolean;
  simulation?: SimulationOptions;
}

export interface HeistEvents extends Record<string, unknown> {
  'heist:started': { levelId: string };
  'heist:finished': MissionResult;
  'target:picked': { id: string };
  'target:dropped': { id: string };
  /** Перерезан кабель сигнализации. */
  'cable:cut': { count: number };
  'target:stowed': { id: string; vehicle: string };
  'vehicle:entered': { id: string };
  'vehicle:exited': { id: string };
  'trigger:fired': { trigger: TriggerDef };
}

export const DEFAULT_INPUT: CharacterInput = {
  forward: 0,
  right: 0,
  jump: false,
  sprint: false,
  crouch: false,
};

/** Дальность взятия цели руками, м. */
export const REACH = 2.4;

/**
 * Игровой цикл ограбления: связывает физическое ядро, миссию, инвентарь,
 * персонажа и технику. Приложение дёргает только update() и хэндлеры ввода,
 * вся логика и все правила — здесь, под тестами.
 */
export class Heist {
  readonly sim: Simulation;
  readonly mission: Mission;
  readonly triggers: TriggerSystem;
  readonly inventory: Inventory;
  readonly character: CharacterController;
  readonly charges = new ChargeSystem();
  readonly planks = new PlankBuilder();
  /** Вертолёт и катер: то, чем кончается таймер. */
  readonly pursuit: Pursuit;
  readonly events = new EventBus<HeistEvents>();
  readonly level: LevelSource;
  readonly profile: Profile;
  readonly sandbox: boolean;
  readonly vehicles = new Map<string, Vehicle>();

  /** Физические тела целей: id цели → тело в мире. */
  readonly targetBodies = new Map<string, Body>();

  yaw = 0;
  pitch = 0;
  /** id техники, в которой сидит игрок. */
  drivingId: string | null = null;
  private started = false;
  private resultApplied = false;

  constructor(opts: HeistOptions) {
    this.level = opts.level;
    this.sandbox = opts.sandbox ?? false;
    this.profile = opts.profile ?? new Profile();
    this.sim = new Simulation({
      ...opts.simulation,
      physics: {
        // Цели миссии не должна разрушать даже падающая на них плита.
        protectedMaterials: this.sandbox ? EMPTY_SET : PROTECTED,
        ...opts.simulation?.physics,
      },
    });
    this.mission = new Mission(opts.level.mission);
    this.triggers = new TriggerSystem(opts.level.triggers);
    this.inventory = new Inventory({
      tiers: this.profile.tiers(),
      unlimited: this.sandbox,
    });
    this.character = new CharacterController({ position: opts.level.spawn.position });
    this.yaw = opts.level.spawn.yaw;
    this.pursuit = new Pursuit({
      ...(opts.level.pursuit ? { specs: opts.level.pursuit } : {}),
      voxelSize: opts.level.voxelSize,
      waterLevel: opts.level.waterLevel,
    });
  }

  get playerPosition(): Vec3 {
    if (this.drivingId) {
      const v = this.vehicles.get(this.drivingId);
      if (v) return { ...v.position };
    }
    return { ...this.character.position };
  }

  get eye(): Vec3 {
    if (this.drivingId) {
      const v = this.vehicles.get(this.drivingId);
      if (v) return add(v.position, v3(0, 1.4, 0));
    }
    return this.character.eye;
  }

  get aimDirection(): Vec3 {
    const cp = Math.cos(this.pitch);
    return normalize(v3(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp));
  }

  get driving(): Vehicle | null {
    return this.drivingId ? (this.vehicles.get(this.drivingId) ?? null) : null;
  }

  /** Построить уровень и перейти в разведку. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.level.build(this.sim);
    for (const spawn of this.level.vehicles) {
      const veh = new Vehicle(spawn.kind, {
        position: spawn.position,
        yaw: spawn.yaw ?? 0,
        voxelSize: this.level.voxelSize,
        waterLevel: this.level.waterLevel,
      });
      veh.spawn(this.sim);
      this.vehicles.set(spawn.id, veh);
    }
    this.bindTargets();
    this.watchCables();
    this.character.teleport(this.level.spawn.position);
    if (!this.sandbox) this.mission.begin();
    this.events.emit('heist:started', { levelId: this.level.id });
  }

  /**
   * Разрыв кабеля сигнализации поднимает тревогу.
   *
   * Кабель — обычный материал на стене: его видно, его можно обойти, а
   * можно снести вместе со стеной. Второй разрыв уже ничего не меняет —
   * сирена не включается дважды, и это проверяет тест.
   */
  private watchCables(): void {
    if (this.sandbox) return;
    this.sim.world.events.on('voxels:removed', (e) => {
      if (!e.materials.has(Mat.Cable)) return;
      if (this.mission.phase !== 'recon' && this.mission.phase !== 'briefing') return;
      if (this.mission.triggerAlarm('cable')) {
        this.events.emit('cable:cut', { count: e.materials.get(Mat.Cable) ?? 0 });
      }
    });
  }

  /**
   * Груз в кузове едет с машиной. Разбитая машина груз роняет: цель
   * остаётся лежать там, где её выбросило, а не исчезает вместе с
   * техникой.
   */
  private moveCargo(): void {
    for (const [id, veh] of this.vehicles) {
      const stowed = this.mission.stowedIn(id);
      if (stowed.length === 0) continue;
      const at = add(veh.position, v3(CARGO_OFFSET.x, CARGO_OFFSET.y, CARGO_OFFSET.z));

      if (veh.wrecked) {
        for (const t of stowed) {
          this.mission.unstow(t.spec.id, at);
          veh.cargo.delete(t.spec.id);
          this.placeTargetBody(t.spec.id, at, false);
        }
        continue;
      }

      this.mission.moveStowed(id, at);
      for (const t of stowed) this.placeTargetBody(t.spec.id, at, true);
    }
  }

  /** Поставить тело цели в точку мира. */
  private placeTargetBody(id: string, at: Vec3, held: boolean): void {
    const body = this.targetBodies.get(id);
    if (!body) return;
    body.transform.position = { ...at };
    body.velocity = v3();
    body.sleeping = held;
    if (!held) body.wake();
    this.sim.physics.sync(body);
  }

  /**
   * Закинуть несомую цель в кузов техники в пределах вытянутой руки.
   * Возвращает id техники или null.
   */
  stow(): string | null {
    const carried = this.mission.carriedIds[0];
    if (!carried) return null;
    const from = this.playerPosition;
    for (const [id, veh] of this.vehicles) {
      if (veh.wrecked) continue;
      const d = Math.hypot(
        veh.position.x - from.x,
        veh.position.y - from.y,
        veh.position.z - from.z,
      );
      if (d > REACH + 1.6) continue;
      const at = add(veh.position, v3(CARGO_OFFSET.x, CARGO_OFFSET.y, CARGO_OFFSET.z));
      if (!this.mission.stow(carried, id, at)) continue;
      veh.cargo.add(carried);
      this.placeTargetBody(carried, at, true);
      this.events.emit('target:stowed', { id: carried, vehicle: id });
      return id;
    }
    return null;
  }

  /** Выгрузить всё из кузова машины на землю рядом. */
  unloadCargo(vehicleId: string): number {
    const veh = this.vehicles.get(vehicleId);
    if (!veh) return 0;
    const at = add(veh.position, v3(0, 0.4, 0));
    let n = 0;
    for (const t of this.mission.stowedIn(vehicleId)) {
      if (!this.mission.unstow(t.spec.id, at)) continue;
      veh.cargo.delete(t.spec.id);
      this.placeTargetBody(t.spec.id, at, false);
      n++;
    }
    return n;
  }

  private bindTargets(): void {
    for (const body of this.sim.world.bodies.values()) {
      for (const tag of body.tags) {
        if (tag.startsWith('target:')) this.targetBodies.set(tag.slice(7), body);
      }
    }
  }

  /** Множество материалов, которые инструменты не разрушают. */
  protectedMaterials(): ReadonlySet<number> {
    return this.sandbox ? EMPTY_SET : PROTECTED;
  }

  private ignoredBodies(): ReadonlySet<number> {
    const set = new Set<number>();
    const v = this.driving;
    if (v) set.add(v.body.id);
    for (const id of this.mission.carriedIds) {
      const b = this.targetBodies.get(id);
      if (b) set.add(b.id);
    }
    return set;
  }

  toolContext(): ToolContext {
    return {
      sim: this.sim,
      inventory: this.inventory,
      origin: this.eye,
      direction: this.aimDirection,
      ignoreBodies: this.ignoredBodies(),
      protect: this.protectedMaterials(),
      paintColor: 0,
    };
  }

  /** Основное действие инструментом (ЛКМ). */
  use(): ToolUseResult {
    const ctx = this.toolContext();
    if (this.inventory.active === 'explosive') {
      const charge = this.charges.place(ctx);
      return charge
        ? { used: true, tool: 'explosive', point: charge.position }
        : { used: false, tool: 'explosive', reason: 'no-target' };
    }
    if (this.inventory.active === 'planks') return this.planks.click(ctx);
    return useTool(ctx);
  }

  /** Детонатор (ПКМ при выбранной взрывчатке). */
  detonate(): number {
    return this.charges.detonateAll(this.sim, this.protectedMaterials());
  }

  /**
   * Взять / положить цель. Работает по прицелу в пределах REACH.
   * Возвращает id цели, с которой что-то произошло.
   */
  interact(): string | null {
    const carried = this.mission.carriedIds[0];
    if (carried) {
      const drop = add(this.eye, scale(this.aimDirection, 1.2));
      if (this.mission.drop(carried, drop)) {
        const body = this.targetBodies.get(carried);
        if (body) {
          body.transform.position = drop;
          body.wake();
          this.sim.physics.sync(body);
        }
        this.events.emit('target:dropped', { id: carried });
        return carried;
      }
      return null;
    }

    const hit = this.sim.world.raycast(this.eye, this.aimDirection, {
      maxDistance: REACH,
      ignore: this.ignoredBodies(),
    });
    if (!hit) return null;
    const tag = [...hit.body.tags].find((t) => t.startsWith('target:'));
    if (!tag) return null;
    const id = tag.slice(7);
    if (!this.mission.pickUp(id)) return null;
    this.events.emit('target:picked', { id });
    return id;
  }

  /**
   * Куда высадить игрока из этой машины.
   *
   * Фиксированная точка «сбоку от кузова» работает ровно до первого раза,
   * когда машина стоит вплотную к стене или в яме от заряда: игрок
   * оказывается внутри геометрии и застревает. Поэтому перебираем места
   * вокруг машины и берём первое свободное, а если свободных нет вообще —
   * сажаем на крышу: над кузовом пусто по построению.
   */
  exitPosition(veh: Vehicle): Vec3 {
    const side = (veh.spec.size.z / 2) * this.level.voxelSize;
    const back = (veh.spec.size.x / 2) * this.level.voxelSize;
    const fits = (p: Vec3): boolean =>
      !overlapsSolid(this.sim.world, this.character.aabbAt(p));

    // Направления считаем от машины, а не от мировых осей: «вбок» — это
    // вбок от кузова, куда бы он ни был повёрнут.
    const fwd = veh.forward;
    const right = v3(Math.cos(veh.yaw), 0, -Math.sin(veh.yaw));

    for (const dist of [side + 0.6, side + 1.2, back + 1.0]) {
      for (const angle of EXIT_ANGLES) {
        const dir = add(scale(fwd, Math.cos(angle)), scale(right, Math.sin(angle)));
        const at = add(veh.position, scale(dir, dist));
        const candidate = v3(at.x, veh.position.y + 0.2, at.z);
        if (fits(candidate)) return candidate;
      }
    }
    // Свободных мест вокруг нет вообще — значит, машину завалило.
    // Крыша своего же кузова остаётся единственным честным вариантом:
    // лучше стоять на капоте, чем внутри стены.
    return add(veh.position, v3(0, (veh.spec.size.y + 2) * this.level.voxelSize, 0));
  }

  /** Сесть за руль ближайшей техники / выйти. */
  toggleVehicle(): string | null {
    if (this.drivingId) {
      const veh = this.vehicles.get(this.drivingId)!;
      this.character.teleport(this.exitPosition(veh));
      const id = this.drivingId;
      this.drivingId = null;
      this.events.emit('vehicle:exited', { id });
      return id;
    }
    let best: string | null = null;
    let bestDist = 3.5;
    for (const [id, veh] of this.vehicles) {
      if (veh.wrecked) continue;
      const d = Math.hypot(
        veh.position.x - this.character.position.x,
        veh.position.y - this.character.position.y,
        veh.position.z - this.character.position.z,
      );
      if (d < bestDist) {
        bestDist = d;
        best = id;
      }
    }
    if (!best) return null;
    this.drivingId = best;
    this.events.emit('vehicle:entered', { id: best });
    return best;
  }

  /** Шаг игры. */
  update(dt: number, input: CharacterInput = DEFAULT_INPUT, vehicleInput: VehicleInput = NEUTRAL_INPUT): void {
    if (!this.started) this.start();

    this.inventory.tick(dt);
    this.charges.step(this.sim, dt, this.protectedMaterials());

    const veh = this.driving;
    if (veh) {
      veh.update(this.sim, vehicleInput, dt);
      this.yaw = veh.yaw;
      this.character.teleport(add(veh.position, v3(0, 0.5, 0)));
      if (veh.wrecked) this.toggleVehicle();
    } else {
      this.character.update(this.sim.world, input, this.yaw, dt);
    }

    // Потолок обломков считает «далеко» от игрока, а не от начала координат:
    // замёрзнуть должно то, что осталось за спиной, а не то, во что он смотрит.
    this.sim.focus = this.playerPosition;
    this.sim.step(dt);

    // Несомая цель едет вместе с игроком, чуть впереди на уровне груди.
    const holdAt = add(this.eye, scale(this.aimDirection, 1.1));
    for (const id of this.mission.carriedIds) {
      const body = this.targetBodies.get(id);
      if (!body) continue;
      body.transform.position = holdAt;
      body.velocity = v3();
      body.sleeping = true;
    }

    this.moveCargo();

    const pos = this.playerPosition;
    if (!this.sandbox) {
      this.mission.update(dt, pos);
      for (const t of this.triggers.update('player', pos)) {
        this.events.emit('trigger:fired', { trigger: t });
      }
      this.syncTargetPositions();
      this.finishIfNeeded();
      // Погоня идёт после миссии: вертолёт должен видеть тот же остаток
      // таймера, что и HUD, иначе он приходит на кадр раньше цифры «0».
      // После финала таймер уже ничего не значит, поэтому подставляем ноль
      // только на провале по времени — на успехе вертолёт просто проходит
      // мимо, и это правильная картинка: успел.
      this.pursuit.update(this.sim, dt, this.pursuitState(), pos);
    }
  }

  private pursuitState() {
    const timedOut = this.mission.result?.reason === 'timeout';
    return {
      alarmActive: this.mission.alarmActive,
      timeLeft: this.mission.finished
        ? timedOut
          ? 0
          : this.mission.config.alarmSeconds
        : this.mission.timeLeft,
      finished: this.mission.finished,
    };
  }

  /** Цели, лежащие в мире, могли уехать вместе с обломками. */
  private syncTargetPositions(): void {
    for (const [id, body] of this.targetBodies) {
      const t = this.mission.targets.get(id);
      if (!t || t.state !== 'idle') continue;
      t.position = { ...body.transform.position };
    }
  }

  private finishIfNeeded(): void {
    if (!this.mission.finished || this.resultApplied) return;
    this.resultApplied = true;
    const result = this.mission.result!;
    this.profile.applyResult(result);
    this.events.emit('heist:finished', result);
  }

  restart(): void {
    this.mission.restart();
    this.pursuit.reset(this.sim);
    this.triggers.reset();
    this.charges.clear();
    this.planks.cancel();
    this.resultApplied = false;
    this.drivingId = null;
    this.sim.reset();
    this.targetBodies.clear();
    this.vehicles.clear();
    this.started = false;
    this.start();
  }
}

/**
 * Куда пробуем высадить: сначала по бортам, потом назад, потом вперёд.
 * Порядок не случайный — выходить принято вбок, а не под собственные колёса.
 */
const EXIT_ANGLES: readonly number[] = [
  Math.PI / 2,
  -Math.PI / 2,
  Math.PI,
  0,
  Math.PI * 0.75,
  -Math.PI * 0.75,
  Math.PI * 0.25,
  -Math.PI * 0.25,
];

const PROTECTED: ReadonlySet<number> = new Set([Mat.Loot]);
const EMPTY_SET: ReadonlySet<number> = new Set();
