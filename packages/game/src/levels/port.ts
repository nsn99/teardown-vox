import { LevelSource, TriggerDef, VehicleSpawnDef } from '../level.js';
import { LevelDoc, levelFromDoc } from '../level-doc.js';
import { MissionConfig, TargetSpec } from '../mission.js';
import doc from './port.json';

/**
 * Стартовая карта M: индустриальная зона, порт.
 *
 * Геометрия живёт в `port.json` — том же формате, который читает игра из
 * файла и пишет редактор. Здесь остались только имена: код, который хочет
 * «зону эвакуации порта», не должен для этого лазить в JSON руками.
 *
 * Реиграбельность идёт от вариантов маршрута и времени, а не от лабиринта:
 * без многоуровневых подвалов, зато с водой, краном и тремя выездами.
 */
export const portLevel: LevelSource = levelFromDoc(doc);

/** Документ карты — для редактора, тестов и сохранения. */
export const PORT_DOC: LevelDoc = (portLevel as LevelSource & { doc: LevelDoc }).doc;

export const VOXEL = portLevel.voxelSize;
/** Уровень воды в гавани, м. Причал и набережная — на нуле. */
export const WATER_LEVEL = portLevel.waterLevel;

export const PORT_MISSION: MissionConfig = portLevel.mission;
export const PORT_TARGETS: TargetSpec[] = portLevel.mission.targets;
export const PORT_EXTRACTION = portLevel.mission.extraction;
export const PORT_TRIGGERS: TriggerDef[] = portLevel.triggers;
export const PORT_VEHICLES: VehicleSpawnDef[] = portLevel.vehicles;
