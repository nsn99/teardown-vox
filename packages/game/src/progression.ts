import { EventBus } from '@tvox/core';
import { MAX_TIER, TOOL_IDS, ToolId, clampTier, upgradeCost } from './tools.js';
import { MissionResult } from './mission.js';

export interface MissionRecord {
  /** Лучшее время под тревогой, с. Меньше — лучше. */
  bestAlarmTime: number;
  /** Лучшее полное время, с. */
  bestTotalTime: number;
  /** Максимум вынесенных ценностей за один заход. */
  bestValuables: number;
  runs: number;
  wins: number;
}

export interface ProfileData {
  version: number;
  money: number;
  earned: number;
  tiers: Record<ToolId, number>;
  missions: Record<string, MissionRecord>;
}

export interface ProfileEvents extends Record<string, unknown> {
  'money:changed': { money: number; delta: number };
  'tool:upgraded': { tool: ToolId; tier: number; cost: number };
  'record:beaten': { missionId: string; record: MissionRecord };
}

export const PROFILE_VERSION = 1;

export type UpgradeFailure = 'maxed' | 'insufficient-funds';

export type UpgradeOutcome =
  | { ok: true; tier: number; cost: number; money: number }
  | { ok: false; reason: UpgradeFailure };

function emptyTiers(): Record<ToolId, number> {
  const t = {} as Record<ToolId, number>;
  for (const id of TOOL_IDS) t[id] = 0;
  return t;
}

/**
 * Прогрессия: деньги за вынесенные ценности и покупка ступеней в хабе.
 * Отдельно от миссии, потому что песочница трогать её не должна.
 */
export class Profile {
  readonly events = new EventBus<ProfileEvents>();
  private data: ProfileData;

  constructor(data?: Partial<ProfileData>) {
    this.data = {
      version: PROFILE_VERSION,
      money: data?.money ?? 0,
      earned: data?.earned ?? 0,
      tiers: { ...emptyTiers(), ...(data?.tiers ?? {}) },
      missions: { ...(data?.missions ?? {}) },
    };
    for (const id of TOOL_IDS) this.data.tiers[id] = clampTier(this.data.tiers[id]);
  }

  get money(): number {
    return this.data.money;
  }

  get earned(): number {
    return this.data.earned;
  }

  tier(id: ToolId): number {
    return this.data.tiers[id];
  }

  tiers(): Record<ToolId, number> {
    return { ...this.data.tiers };
  }

  record(missionId: string): MissionRecord | null {
    return this.data.missions[missionId] ? { ...this.data.missions[missionId] } : null;
  }

  addMoney(amount: number): number {
    if (amount === 0) return this.data.money;
    this.data.money += amount;
    if (amount > 0) this.data.earned += amount;
    this.events.emit('money:changed', { money: this.data.money, delta: amount });
    return this.data.money;
  }

  nextUpgradeCost(id: ToolId): number | null {
    return upgradeCost(id, this.tier(id));
  }

  canAfford(id: ToolId): boolean {
    const cost = this.nextUpgradeCost(id);
    return cost !== null && this.data.money >= cost;
  }

  /** Покупка следующей ступени. Никаких частичных списаний при отказе. */
  upgrade(id: ToolId): UpgradeOutcome {
    const tier = this.tier(id);
    if (tier >= MAX_TIER) return { ok: false, reason: 'maxed' };
    const cost = upgradeCost(id, tier)!;
    if (this.data.money < cost) return { ok: false, reason: 'insufficient-funds' };

    this.data.money -= cost;
    this.data.tiers[id] = tier + 1;
    this.events.emit('money:changed', { money: this.data.money, delta: -cost });
    this.events.emit('tool:upgraded', { tool: id, tier: tier + 1, cost });
    return { ok: true, tier: tier + 1, cost, money: this.data.money };
  }

  /**
   * Учёт результата захода. Деньги начисляются только за успех:
   * провал по таймеру не приносит ничего, и это делает 60 секунд
   * настоящей ставкой, а не декорацией.
   */
  applyResult(result: MissionResult): MissionRecord {
    const prev = this.data.missions[result.missionId] ?? {
      bestAlarmTime: Infinity,
      bestTotalTime: Infinity,
      bestValuables: 0,
      runs: 0,
      wins: 0,
    };

    const next: MissionRecord = {
      bestAlarmTime: prev.bestAlarmTime,
      bestTotalTime: prev.bestTotalTime,
      bestValuables: prev.bestValuables,
      runs: prev.runs + 1,
      wins: prev.wins + (result.success ? 1 : 0),
    };

    let beaten = false;
    if (result.success) {
      this.addMoney(result.payout);
      if (result.alarmTime < next.bestAlarmTime) {
        next.bestAlarmTime = result.alarmTime;
        beaten = true;
      }
      if (result.totalTime < next.bestTotalTime) {
        next.bestTotalTime = result.totalTime;
        beaten = true;
      }
      if (result.valuablesDelivered > next.bestValuables) {
        next.bestValuables = result.valuablesDelivered;
        beaten = true;
      }
    }

    this.data.missions[result.missionId] = next;
    if (beaten) {
      this.events.emit('record:beaten', { missionId: result.missionId, record: { ...next } });
    }
    return { ...next };
  }

  toJSON(): ProfileData {
    return {
      version: PROFILE_VERSION,
      money: this.data.money,
      earned: this.data.earned,
      tiers: { ...this.data.tiers },
      missions: JSON.parse(JSON.stringify(this.data.missions)),
    };
  }

  /** Разбор сохранения. Мусор и старые версии не роняют игру. */
  static fromJSON(raw: unknown): Profile {
    if (!raw || typeof raw !== 'object') return new Profile();
    const d = raw as Partial<ProfileData>;
    if (d.version !== PROFILE_VERSION) return new Profile();
    const missions: Record<string, MissionRecord> = {};
    for (const [k, v] of Object.entries(d.missions ?? {})) {
      if (!v || typeof v !== 'object') continue;
      missions[k] = {
        bestAlarmTime: numberOr(v.bestAlarmTime, Infinity),
        bestTotalTime: numberOr(v.bestTotalTime, Infinity),
        bestValuables: numberOr(v.bestValuables, 0),
        runs: numberOr(v.runs, 0),
        wins: numberOr(v.wins, 0),
      };
    }
    return new Profile({
      money: numberOr(d.money, 0),
      earned: numberOr(d.earned, 0),
      tiers: d.tiers,
      missions,
    });
  }
}

function numberOr(v: unknown, fallback: number): number {
  if (v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isNaN(n) ? fallback : n;
}

/** Ключ, под которым профиль лежит в localStorage. */
export const PROFILE_STORAGE_KEY = 'tvox.profile.v1';
