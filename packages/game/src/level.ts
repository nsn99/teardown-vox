import { Body, EventBus, Simulation, Vec3, aabbContains, v3 } from '@tvox/core';
import { MissionConfig } from './mission.js';
import { ChaserSpec } from './pursuit.js';
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

export type Daylight = 'day' | 'dusk' | 'night';

/**
 * Источник света уровня: прожектор на кране, лампа над воротами.
 *
 * Живёт в карте, а не в коде рендера, по той же причине, что и всё
 * остальное: своя карта не должна играться в темноте только потому, что
 * свет кто-то захардкодил под «Порт».
 */
export interface LightDef {
  kind: 'point' | 'spot';
  position: Vec3;
  /** Куда светит прожектор. Точечной лампе не нужно. */
  target?: Vec3;
  /** Цвет в формате #rrggbb. */
  color: string;
  intensity: number;
  /** Дальность, м. */
  range: number;
  /** Раствор конуса, рад. */
  angle?: number;
  /** Прожектор отбрасывает тень — иначе он светит сквозь стены. */
  shadow?: boolean;
}

export interface EnvironmentDef {
  daylight: Daylight;
  lights: LightDef[];
}

/**
 * Формат карты. Сразу поддерживает всё, что нужно ограблению:
 * воксельную геометрию, триггеры (сигнализация при краже цели),
 * зоны эвакуации, точки спавна техники.
 */
/**
 * Чем маршрут отхода берётся.
 *
 * Это не запрет, а честное описание задумки: карта заявляет, что вот
 * этот путь нельзя пройти пешком, и тест проверяет, что так и есть.
 * Игрок волен пробить стену и уйти третьим способом — на то и Тирдаун.
 */
export type RouteNeeds = 'foot' | 'planks' | 'vehicle' | 'boat';

/**
 * Маршрут отхода: путь от места, где взяли ценность, до эвакуации.
 *
 * Маршруты живут в карте, а не в голове автора, ровно по одной причине:
 * иначе «на карте есть три пути отхода» — это утверждение, которое никто
 * не проверяет. Точки задают путь, а тест проходит его настоящим
 * контроллером игрока и меряет время. Карта, где отход перестал
 * проходиться после правки геометрии, падает в CI, а не у игрока.
 */
export interface EscapeRoute {
  id: string;
  name: string;
  /** Чем берётся. Пешие проверяются ходьбой, остальные — своими тестами. */
  needs: RouteNeeds;
  /** Точки пути. Первая — где начался отход, последняя — зона эвакуации. */
  waypoints: Vec3[];
  /** Какие ценности лежат на этом пути. */
  collects?: string[];
}

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
  /** Кто приходит по концу таймера тревоги. Пусто — умолчания погони. */
  pursuit?: ChaserSpec[];
  /** Время суток и свет уровня. */
  environment?: EnvironmentDef;
  /** Заявленные пути отхода. */
  routes?: EscapeRoute[];
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
