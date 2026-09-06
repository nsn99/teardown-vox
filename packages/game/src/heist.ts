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
import { CharacterController, CharacterInput } from './character.js';
import { Inventory } from './inventory.js';
import { LevelSource, TriggerDef, TriggerSystem } from './level.js';
import { Mission, MissionResult } from './mission.js';
import { Profile } from './progression.js';
import { ChargeSystem, PlankBuilder, ToolContext, ToolUseResult, useTool } from './tool-use.js';
import { NEUTRAL_INPUT, Vehicle, VehicleInput } from './vehicles.js';

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
    this.character.teleport(this.level.spawn.position);
    if (!this.sandbox) this.mission.begin();
    this.events.emit('heist:started', { levelId: this.level.id });
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

  /** Сесть за руль ближайшей техники / выйти. */
  toggleVehicle(): string | null {
    if (this.drivingId) {
      const veh = this.vehicles.get(this.drivingId)!;
      const exitAt = add(veh.position, v3(0, 0.2, (veh.spec.size.z / 2 + 6) * this.level.voxelSize));
      this.character.teleport(exitAt);
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

    const pos = this.playerPosition;
    if (!this.sandbox) {
      this.mission.update(dt, pos);
      for (const t of this.triggers.update('player', pos)) {
        this.events.emit('trigger:fired', { trigger: t });
      }
      this.syncTargetPositions();
      this.finishIfNeeded();
    }
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

const PROTECTED: ReadonlySet<number> = new Set([Mat.Loot]);
const EMPTY_SET: ReadonlySet<number> = new Set();
