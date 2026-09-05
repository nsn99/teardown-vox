import { MAX_TIER, TOOL_IDS, ToolId, ToolTierStats, clampTier, toolBySlot, toolDef, toolStats } from './tools.js';

export interface InventoryState {
  active: ToolId;
  tiers: Record<ToolId, number>;
  ammo: Record<ToolId, number>;
  cooldown: Record<ToolId, number>;
}

export interface InventoryOptions {
  tiers?: Partial<Record<ToolId, number>>;
  /** Песочница: расходники не тратятся. */
  unlimited?: boolean;
  active?: ToolId;
}

/**
 * Инвентарь: активный инструмент, ступени прокачки, расходники, откаты.
 *
 * Запас расходника задаётся ступенью инструмента, поэтому прокачка
 * «дробовик до 3» одновременно увеличивает и урон, и боезапас — ровно
 * как в дизайн-документе.
 */
export class Inventory {
  private state: InventoryState;
  unlimited: boolean;

  constructor(opts: InventoryOptions = {}) {
    const tiers = {} as Record<ToolId, number>;
    const ammo = {} as Record<ToolId, number>;
    const cooldown = {} as Record<ToolId, number>;
    for (const id of TOOL_IDS) {
      tiers[id] = clampTier(opts.tiers?.[id] ?? 0);
      ammo[id] = toolStats(id, tiers[id]).capacity;
      cooldown[id] = 0;
    }
    this.state = {
      active: opts.active ?? 'sledge',
      tiers,
      ammo,
      cooldown,
    };
    this.unlimited = opts.unlimited ?? false;
  }

  get active(): ToolId {
    return this.state.active;
  }

  get activeStats(): ToolTierStats {
    return toolStats(this.state.active, this.tier(this.state.active));
  }

  tier(id: ToolId): number {
    return this.state.tiers[id];
  }

  ammo(id: ToolId): number {
    return this.state.ammo[id];
  }

  capacity(id: ToolId): number {
    return toolStats(id, this.tier(id)).capacity;
  }

  cooldown(id: ToolId): number {
    return this.state.cooldown[id];
  }

  select(id: ToolId): boolean {
    toolDef(id);
    if (this.state.active === id) return false;
    this.state.active = id;
    return true;
  }

  selectSlot(slot: number): boolean {
    const id = toolBySlot(slot);
    return id ? this.select(id) : false;
  }

  /** Следующий/предыдущий по колесу мыши. */
  cycle(delta: number): ToolId {
    const i = TOOL_IDS.indexOf(this.state.active);
    const n = TOOL_IDS.length;
    const next = TOOL_IDS[(((i + delta) % n) + n) % n];
    this.state.active = next;
    return next;
  }

  /**
   * Устанавливает ступень и доливает расходник до нового потолка.
   * Прокачка в хабе не должна оставлять игрока с пустым дробовиком.
   */
  setTier(id: ToolId, tier: number): void {
    const t = clampTier(tier);
    this.state.tiers[id] = t;
    this.state.ammo[id] = toolStats(id, t).capacity;
  }

  canUpgrade(id: ToolId): boolean {
    return this.tier(id) < MAX_TIER;
  }

  /** Готов ли инструмент к применению: не на откате и есть расходник. */
  canUse(id: ToolId = this.state.active): boolean {
    if (this.state.cooldown[id] > 0) return false;
    if (this.unlimited) return true;
    return this.state.ammo[id] > 0;
  }

  /**
   * Списывает применение. Возвращает false, если инструмент не готов —
   * тогда вызывающий не должен трогать мир.
   */
  consume(id: ToolId = this.state.active, amount = 1): boolean {
    if (!this.canUse(id)) return false;
    if (!this.unlimited) {
      this.state.ammo[id] = Math.max(0, this.state.ammo[id] - amount);
    }
    this.state.cooldown[id] = toolStats(id, this.tier(id)).cooldown;
    return true;
  }

  refill(id?: ToolId): void {
    const ids = id ? [id] : TOOL_IDS;
    for (const t of ids) this.state.ammo[t] = toolStats(t, this.tier(t)).capacity;
  }

  addAmmo(id: ToolId, amount: number): number {
    const cap = this.capacity(id);
    this.state.ammo[id] = Math.min(cap, this.state.ammo[id] + amount);
    return this.state.ammo[id];
  }

  tick(dt: number): void {
    for (const id of TOOL_IDS) {
      if (this.state.cooldown[id] > 0) {
        this.state.cooldown[id] = Math.max(0, this.state.cooldown[id] - dt);
      }
    }
  }

  snapshot(): InventoryState {
    return {
      active: this.state.active,
      tiers: { ...this.state.tiers },
      ammo: { ...this.state.ammo },
      cooldown: { ...this.state.cooldown },
    };
  }

  restore(state: InventoryState): void {
    this.state = {
      active: state.active,
      tiers: { ...state.tiers },
      ammo: { ...state.ammo },
      cooldown: { ...state.cooldown },
    };
  }
}
