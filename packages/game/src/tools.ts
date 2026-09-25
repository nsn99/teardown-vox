/**
 * Каталог инструментов. Расширение каталога вне текущего объёма —
 * здесь ровно семь позиций из дизайн-документа, но каждая обязана
 * корректно работать с физическим движком.
 *
 * Прокачка: базовый уровень 0 плюс три покупаемые ступени.
 */

export type ToolId =
  | 'sledge'
  | 'spraycan'
  | 'extinguisher'
  | 'blowtorch'
  | 'shotgun'
  | 'explosive'
  | 'planks';

export const MAX_TIER = 3;

export type AmmoKind = 'none' | 'shells' | 'charges' | 'planks' | 'foam' | 'gas' | 'paint';

export interface ToolTierStats {
  /** Сила против прочности материала, 0..1. Ниже toughness — не берёт. */
  power: number;
  /** Радиус/полудлина эффекта, м. */
  radius: number;
  /** Дальность применения, м. */
  range: number;
  /** Урон за применение (для накопительных инструментов). */
  damage: number;
  /** Запас расходника. Infinity — безлимитный. */
  capacity: number;
  /** Секунд между применениями. */
  cooldown: number;
}

export interface ToolDef {
  id: ToolId;
  name: string;
  /** Как инструмент воздействует на мир. */
  action: 'carve' | 'paint' | 'extinguish' | 'cut' | 'spread' | 'place' | 'build';
  ammo: AmmoKind;
  /** Клавиша быстрого выбора. */
  slot: number;
  /** Поджигает горючее при применении. */
  ignites: boolean;
  /** Ослабление силы к краю эффекта. */
  falloff: 'none' | 'linear' | 'quadratic';
  tiers: [ToolTierStats, ToolTierStats, ToolTierStats, ToolTierStats];
  /** Цена ступени n (индекс 0 — переход с базы на ступень 1). */
  upgradeCosts: [number, number, number];
  description: string;
}

const INF = Number.POSITIVE_INFINITY;

export const TOOLS: Record<ToolId, ToolDef> = {
  sledge: {
    id: 'sledge',
    name: 'Кувалда',
    action: 'carve',
    ammo: 'none',
    slot: 1,
    ignites: false,
    falloff: 'linear',
    description: 'Базовый снос кирпича и дерева. Бетон и сталь не пробивает.',
    tiers: [
      { power: 0.35, radius: 0.22, range: 2.0, damage: 60, capacity: INF, cooldown: 0.45 },
      { power: 0.42, radius: 0.28, range: 2.2, damage: 85, capacity: INF, cooldown: 0.4 },
      { power: 0.48, radius: 0.34, range: 2.4, damage: 120, capacity: INF, cooldown: 0.34 },
      { power: 0.55, radius: 0.42, range: 2.6, damage: 170, capacity: INF, cooldown: 0.28 },
    ],
    upgradeCosts: [900, 2200, 5000],
  },
  spraycan: {
    id: 'spraycan',
    name: 'Баллончик',
    action: 'paint',
    ammo: 'paint',
    slot: 2,
    ignites: false,
    falloff: 'none',
    description: 'Разметка маршрута. Не трогает ни материал, ни прочность.',
    tiers: [
      { power: 0, radius: 0.3, range: 6, damage: 0, capacity: 300, cooldown: 0.05 },
      { power: 0, radius: 0.4, range: 8, damage: 0, capacity: 480, cooldown: 0.05 },
      { power: 0, radius: 0.5, range: 10, damage: 0, capacity: 720, cooldown: 0.04 },
      { power: 0, radius: 0.65, range: 14, damage: 0, capacity: 1200, cooldown: 0.03 },
    ],
    upgradeCosts: [300, 700, 1400],
  },
  extinguisher: {
    id: 'extinguisher',
    name: 'Огнетушитель',
    action: 'extinguish',
    ammo: 'foam',
    slot: 3,
    ignites: false,
    falloff: 'linear',
    description: 'Сбивает жар и оставляет влагу: пожар не возвращается.',
    tiers: [
      { power: 1, radius: 1.1, range: 5, damage: 0, capacity: 240, cooldown: 0.05 },
      { power: 1.3, radius: 1.4, range: 6, damage: 0, capacity: 360, cooldown: 0.05 },
      { power: 1.6, radius: 1.8, range: 7.5, damage: 0, capacity: 520, cooldown: 0.04 },
      { power: 2, radius: 2.3, range: 9, damage: 0, capacity: 800, cooldown: 0.04 },
    ],
    upgradeCosts: [500, 1200, 2600],
  },
  blowtorch: {
    id: 'blowtorch',
    name: 'Паяльная лампа',
    action: 'cut',
    ammo: 'gas',
    slot: 4,
    ignites: true,
    falloff: 'none',
    description: 'Единственное, что режет сталь. Горючее рядом вспыхнет.',
    tiers: [
      { power: 0.75, radius: 0.1, range: 1.6, damage: 55, capacity: 300, cooldown: 0.03 },
      { power: 0.8, radius: 0.12, range: 1.8, damage: 80, capacity: 420, cooldown: 0.03 },
      { power: 0.85, radius: 0.15, range: 2.1, damage: 110, capacity: 600, cooldown: 0.025 },
      { power: 0.92, radius: 0.19, range: 2.4, damage: 150, capacity: 900, cooldown: 0.02 },
    ],
    upgradeCosts: [1200, 3000, 6500],
  },
  shotgun: {
    id: 'shotgun',
    name: 'Дробовик',
    action: 'spread',
    ammo: 'shells',
    slot: 5,
    ignites: false,
    falloff: 'linear',
    description: 'Конус на дистанции. Стекло и доски сносит вчистую.',
    tiers: [
      { power: 0.45, radius: 0.3, range: 9, damage: 90, capacity: 24, cooldown: 0.8 },
      { power: 0.5, radius: 0.34, range: 12, damage: 130, capacity: 36, cooldown: 0.7 },
      { power: 0.56, radius: 0.38, range: 16, damage: 180, capacity: 48, cooldown: 0.6 },
      { power: 0.59, radius: 0.44, range: 20, damage: 240, capacity: 64, cooldown: 0.5 },
    ],
    upgradeCosts: [1500, 3500, 7000],
  },
  explosive: {
    id: 'explosive',
    name: 'Взрывчатка',
    action: 'place',
    ammo: 'charges',
    slot: 6,
    ignites: true,
    falloff: 'quadratic',
    description: 'Заряд с задержкой. Радиус растёт со ступенью — считай маршрут.',
    tiers: [
      { power: 1.1, radius: 1.6, range: 3, damage: 0, capacity: 3, cooldown: 0.6 },
      { power: 1.2, radius: 2.2, range: 3.5, damage: 0, capacity: 5, cooldown: 0.5 },
      { power: 1.35, radius: 2.9, range: 4, damage: 0, capacity: 7, cooldown: 0.45 },
      { power: 1.5, radius: 3.8, range: 4.5, damage: 0, capacity: 10, cooldown: 0.4 },
    ],
    upgradeCosts: [2000, 4500, 9000],
  },
  planks: {
    id: 'planks',
    name: 'Доски',
    action: 'build',
    ammo: 'planks',
    slot: 7,
    ignites: false,
    falloff: 'none',
    description: 'Мосты и пандусы. Горит — помни об этом.',
    tiers: [
      { power: 0, radius: 0.1, range: 6, damage: 0, capacity: 8, cooldown: 0.35 },
      { power: 0, radius: 0.1, range: 8, damage: 0, capacity: 14, cooldown: 0.3 },
      { power: 0, radius: 0.12, range: 10, damage: 0, capacity: 22, cooldown: 0.25 },
      { power: 0, radius: 0.14, range: 13, damage: 0, capacity: 32, cooldown: 0.2 },
    ],
    upgradeCosts: [600, 1500, 3200],
  },
};

export const TOOL_IDS = Object.keys(TOOLS) as ToolId[];

export function toolDef(id: ToolId): ToolDef {
  const t = TOOLS[id];
  if (!t) throw new RangeError(`Неизвестный инструмент: ${id}`);
  return t;
}

export function clampTier(tier: number): number {
  if (!Number.isFinite(tier)) return 0;
  return Math.max(0, Math.min(MAX_TIER, Math.floor(tier)));
}

export function toolStats(id: ToolId, tier: number): ToolTierStats {
  return toolDef(id).tiers[clampTier(tier)];
}

/** Цена перехода с tier на tier+1. null — дальше некуда. */
export function upgradeCost(id: ToolId, tier: number): number | null {
  const t = clampTier(tier);
  if (t >= MAX_TIER) return null;
  return toolDef(id).upgradeCosts[t];
}

/** Сколько стоит прокачать инструмент с нуля до максимума. */
export function totalUpgradeCost(id: ToolId): number {
  return toolDef(id).upgradeCosts.reduce((a, b) => a + b, 0);
}

export function toolBySlot(slot: number): ToolId | null {
  return TOOL_IDS.find((id) => TOOLS[id].slot === slot) ?? null;
}
