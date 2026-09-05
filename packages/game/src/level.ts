import { Body, EventBus, Simulation, Vec3, aabbContains, v3 } from '@tvox/core';
import { MissionConfig } from './mission.js';
import { VehicleKind } from './vehicles.js';

export type TriggerKind = 'alarm-cable' | 'extraction' | 'checkpoint' | 'hazard';

export interface TriggerDef {
  id: string;
  kind: TriggerKind;
  center: Vec3;
  halfExtents: Vec3;
  /** Срабатывает один раз и больше не мешает. */
  once?: boolean;
  label?: string;
}

export interface VehicleSpawnDef {
  id: string;
  kind: VehicleKind;
  position: Vec3;
  yaw?: number;
}

export interface SpawnPoint {
  position: Vec3;
  yaw: number;
}

/**
 * Формат карты. Сразу поддерживает всё, что нужно ограблению:
 * воксельную геометрию, триггеры (сигнализация при краже цели),
 * зоны эвакуации, точки спавна техники.
 */
export interface LevelSource {
  id: string;
  name: string;
  brief: string;
  voxelSize: number;
  /** Уровень воды по Y, м. Ниже — вода. */
  waterLevel: number;
  spawn: SpawnPoint;
  triggers: TriggerDef[];
  vehicles: VehicleSpawnDef[];
  mission: MissionConfig;
  /** Создаёт тела уровня и возвращает их. */
  build(sim: Simulation): Body[];
}

export interface TriggerEvents extends Record<string, unknown> {
  'trigger:entered': { trigger: TriggerDef; who: string; point: Vec3 };
  'trigger:exited': { trigger: TriggerDef; who: string };
}

/**
 * Триггеры-объёмы. Никакого ИИ и никаких охранников — вся «охранная
 * система» уровня сводится к тому, кто и когда вошёл в объём.
 */
export class TriggerSystem {
  readonly events = new EventBus<TriggerEvents>();
  private defs: TriggerDef[];
  private inside = new Map<string, Set<string>>();
  private spent = new Set<string>();

  constructor(defs: TriggerDef[] = []) {
    this.defs = [...defs];
  }

  add(def: TriggerDef): void {
    this.defs.push(def);
  }

  get triggers(): readonly TriggerDef[] {
    return this.defs;
  }

  byId(id: string): TriggerDef | undefined {
    return this.defs.find((t) => t.id === id);
  }

  contains(def: TriggerDef, p: Vec3): boolean {
    return aabbContains(
      {
        min: v3(
          def.center.x - def.halfExtents.x,
          def.center.y - def.halfExtents.y,
          def.center.z - def.halfExtents.z,
        ),
        max: v3(
          def.center.x + def.halfExtents.x,
          def.center.y + def.halfExtents.y,
          def.center.z + def.halfExtents.z,
        ),
      },
      p,
    );
  }

  /** Проверить положение сущности. Возвращает сработавшие триггеры. */
  update(who: string, point: Vec3): TriggerDef[] {
    let set = this.inside.get(who);
    if (!set) {
      set = new Set();
      this.inside.set(who, set);
    }
    const fired: TriggerDef[] = [];

    for (const def of this.defs) {
      const isInside = this.contains(def, point);
      const wasInside = set.has(def.id);
      if (isInside && !wasInside) {
        set.add(def.id);
        if (def.once && this.spent.has(def.id)) continue;
        if (def.once) this.spent.add(def.id);
        fired.push(def);
        this.events.emit('trigger:entered', { trigger: def, who, point });
      } else if (!isInside && wasInside) {
        set.delete(def.id);
        this.events.emit('trigger:exited', { trigger: def, who });
      }
    }
    return fired;
  }

  isInside(who: string, triggerId: string): boolean {
    return this.inside.get(who)?.has(triggerId) ?? false;
  }

  reset(): void {
    this.inside.clear();
    this.spent.clear();
  }
}
