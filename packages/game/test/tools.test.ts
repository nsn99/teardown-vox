import { describe, expect, it } from 'vitest';
import {
  Inventory,
  MAX_TIER,
  Profile,
  TOOLS,
  TOOL_IDS,
  ToolId,
  clampTier,
  toolBySlot,
  toolDef,
  toolStats,
  totalUpgradeCost,
  upgradeCost,
} from '@tvox/game';

describe('каталог инструментов', () => {
  it('ровно семь инструментов из дизайн-документа', () => {
    expect(TOOL_IDS).toEqual([
      'sledge',
      'spraycan',
      'extinguisher',
      'blowtorch',
      'shotgun',
      'explosive',
      'planks',
    ]);
  });

  it('у каждого четыре ступени и три цены', () => {
    for (const id of TOOL_IDS) {
      expect(TOOLS[id].tiers).toHaveLength(MAX_TIER + 1);
      expect(TOOLS[id].upgradeCosts).toHaveLength(MAX_TIER);
    }
  });

  it('характеристики растут монотонно со ступенью', () => {
    for (const id of TOOL_IDS) {
      const t = TOOLS[id].tiers;
      for (let i = 1; i <= MAX_TIER; i++) {
        expect(t[i].range).toBeGreaterThanOrEqual(t[i - 1].range);
        expect(t[i].capacity).toBeGreaterThanOrEqual(t[i - 1].capacity);
        expect(t[i].cooldown).toBeLessThanOrEqual(t[i - 1].cooldown);
      }
    }
  });

  it('цены прокачки растут', () => {
    for (const id of TOOL_IDS) {
      const [a, b, c] = TOOLS[id].upgradeCosts;
      expect(b).toBeGreaterThan(a);
      expect(c).toBeGreaterThan(b);
      expect(totalUpgradeCost(id)).toBe(a + b + c);
    }
  });

  it('слоты уникальны и находятся по номеру', () => {
    const slots = TOOL_IDS.map((id) => TOOLS[id].slot);
    expect(new Set(slots).size).toBe(slots.length);
    expect(toolBySlot(1)).toBe('sledge');
    expect(toolBySlot(99)).toBeNull();
  });

  it('только лампа и заряд поджигают', () => {
    const igniting = TOOL_IDS.filter((id) => TOOLS[id].ignites);
    expect(igniting.sort()).toEqual(['blowtorch', 'explosive']);
  });

  it('кувалда слабее металла, лампа сильнее', () => {
    expect(toolStats('sledge', MAX_TIER).power).toBeLessThan(0.6);
    expect(toolStats('blowtorch', 0).power).toBeGreaterThan(0.6);
  });

  it('неизвестный инструмент — ошибка', () => {
    expect(() => toolDef('nope' as ToolId)).toThrow(RangeError);
  });

  it('ступень зажимается в допустимый диапазон', () => {
    expect(clampTier(-5)).toBe(0);
    expect(clampTier(99)).toBe(MAX_TIER);
    expect(clampTier(1.9)).toBe(1);
    expect(clampTier(NaN)).toBe(0);
  });

  it('на максимуме цена прокачки отсутствует', () => {
    expect(upgradeCost('sledge', MAX_TIER)).toBeNull();
    expect(upgradeCost('sledge', 0)).toBe(TOOLS.sledge.upgradeCosts[0]);
  });
});

describe('инвентарь', () => {
  it('стартует с кувалдой и нулевыми ступенями', () => {
    const inv = new Inventory();
    expect(inv.active).toBe('sledge');
    for (const id of TOOL_IDS) expect(inv.tier(id)).toBe(0);
  });

  it('выбор по слоту и по колесу', () => {
    const inv = new Inventory();
    expect(inv.selectSlot(5)).toBe(true);
    expect(inv.active).toBe('shotgun');
    expect(inv.selectSlot(5)).toBe(false);
    expect(inv.selectSlot(42)).toBe(false);
    inv.select('sledge');
    expect(inv.cycle(-1)).toBe('planks');
    expect(inv.cycle(1)).toBe('sledge');
  });

  it('расходник тратится и кончается', () => {
    const inv = new Inventory();
    const cap = inv.capacity('shotgun');
    inv.select('shotgun');
    for (let i = 0; i < cap; i++) {
      expect(inv.consume('shotgun')).toBe(true);
      inv.tick(10);
    }
    expect(inv.ammo('shotgun')).toBe(0);
    expect(inv.consume('shotgun')).toBe(false);
  });

  it('откат блокирует повторное применение', () => {
    const inv = new Inventory();
    expect(inv.consume('sledge')).toBe(true);
    expect(inv.canUse('sledge')).toBe(false);
    inv.tick(0.2);
    expect(inv.canUse('sledge')).toBe(false);
    inv.tick(0.5);
    expect(inv.canUse('sledge')).toBe(true);
  });

  it('безлимитный режим песочницы не тратит расходники', () => {
    const inv = new Inventory({ unlimited: true });
    const before = inv.ammo('explosive');
    inv.consume('explosive');
    expect(inv.ammo('explosive')).toBe(before);
  });

  it('прокачка доливает боезапас до нового потолка', () => {
    const inv = new Inventory();
    inv.select('shotgun');
    inv.consume('shotgun');
    inv.setTier('shotgun', 2);
    expect(inv.ammo('shotgun')).toBe(toolStats('shotgun', 2).capacity);
    expect(inv.canUpgrade('shotgun')).toBe(true);
    inv.setTier('shotgun', MAX_TIER);
    expect(inv.canUpgrade('shotgun')).toBe(false);
  });

  it('пополнение и добавление патронов не превышает потолок', () => {
    const inv = new Inventory();
    inv.consume('explosive');
    inv.addAmmo('explosive', 999);
    expect(inv.ammo('explosive')).toBe(inv.capacity('explosive'));
    inv.consume('planks');
    inv.refill();
    expect(inv.ammo('planks')).toBe(inv.capacity('planks'));
  });

  it('снимок и восстановление состояния', () => {
    const inv = new Inventory();
    inv.select('blowtorch');
    inv.setTier('blowtorch', 2);
    inv.consume('blowtorch');
    const snap = inv.snapshot();

    const other = new Inventory();
    other.restore(snap);
    expect(other.active).toBe('blowtorch');
    expect(other.tier('blowtorch')).toBe(2);
    expect(other.ammo('blowtorch')).toBe(inv.ammo('blowtorch'));
  });
});

describe('прогрессия', () => {
  it('деньги начисляются и тратятся', () => {
    const p = new Profile();
    const deltas: number[] = [];
    p.events.on('money:changed', (e) => deltas.push(e.delta));
    p.addMoney(5000);
    expect(p.money).toBe(5000);
    expect(p.earned).toBe(5000);
    p.addMoney(0);
    expect(deltas).toEqual([5000]);
  });

  it('прокачка списывает ровно цену и поднимает ступень', () => {
    const p = new Profile({ money: 1000 });
    const res = p.upgrade('sledge');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.tier).toBe(1);
      expect(res.cost).toBe(TOOLS.sledge.upgradeCosts[0]);
      expect(p.money).toBe(1000 - res.cost);
    }
  });

  it('без денег ничего не списывается', () => {
    const p = new Profile({ money: 10 });
    const res = p.upgrade('sledge');
    expect(res).toEqual({ ok: false, reason: 'insufficient-funds' });
    expect(p.money).toBe(10);
    expect(p.tier('sledge')).toBe(0);
    expect(p.canAfford('sledge')).toBe(false);
  });

  it('на максимуме прокачка отклоняется', () => {
    const p = new Profile({ money: 1e9, tiers: { sledge: MAX_TIER } });
    expect(p.upgrade('sledge')).toEqual({ ok: false, reason: 'maxed' });
    expect(p.nextUpgradeCost('sledge')).toBeNull();
  });

  it('успешный заход платит и обновляет рекорд', () => {
    const p = new Profile();
    const rec = p.applyResult({
      missionId: 'port',
      success: true,
      reason: 'extracted',
      alarmTime: 44.2,
      totalTime: 300,
      payout: 68000,
      delivered: ['safe', 'docs'],
      requiredDelivered: 2,
      requiredTotal: 2,
      valuablesDelivered: 1,
    });
    expect(p.money).toBe(68000);
    expect(rec.wins).toBe(1);
    expect(rec.bestAlarmTime).toBeCloseTo(44.2, 6);
  });

  it('провал считается заходом, но не платит и не бьёт рекорды', () => {
    const p = new Profile();
    p.applyResult({
      missionId: 'port',
      success: false,
      reason: 'timeout',
      alarmTime: 60,
      totalTime: 120,
      payout: 0,
      delivered: [],
      requiredDelivered: 0,
      requiredTotal: 2,
      valuablesDelivered: 0,
    });
    expect(p.money).toBe(0);
    const rec = p.record('port')!;
    expect(rec.runs).toBe(1);
    expect(rec.wins).toBe(0);
    expect(rec.bestAlarmTime).toBe(Infinity);
  });

  it('рекорд обновляется только при улучшении', () => {
    const p = new Profile();
    const win = (alarmTime: number) =>
      p.applyResult({
        missionId: 'port',
        success: true,
        reason: 'extracted',
        alarmTime,
        totalTime: alarmTime + 100,
        payout: 1000,
        delivered: ['safe'],
        requiredDelivered: 1,
        requiredTotal: 1,
        valuablesDelivered: 0,
      });
    win(50);
    const beaten: string[] = [];
    p.events.on('record:beaten', (e) => beaten.push(e.missionId));
    win(55);
    expect(beaten).toHaveLength(0);
    win(40);
    expect(beaten).toEqual(['port']);
    expect(p.record('port')!.bestAlarmTime).toBe(40);
  });

  it('нет записи о непройденной миссии', () => {
    expect(new Profile().record('nope')).toBeNull();
  });

  it('сохранение переживает круговой рейс через JSON', () => {
    const p = new Profile({ money: 1234 });
    p.upgrade('spraycan');
    p.applyResult({
      missionId: 'port',
      success: true,
      reason: 'extracted',
      alarmTime: 33,
      totalTime: 200,
      payout: 500,
      delivered: ['safe'],
      requiredDelivered: 1,
      requiredTotal: 1,
      valuablesDelivered: 0,
    });
    const back = Profile.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
    expect(back.money).toBe(p.money);
    expect(back.tier('spraycan')).toBe(1);
    expect(back.record('port')!.bestAlarmTime).toBe(33);
  });

  it('битое или чужое сохранение даёт чистый профиль', () => {
    expect(Profile.fromJSON(null).money).toBe(0);
    expect(Profile.fromJSON('мусор').money).toBe(0);
    expect(Profile.fromJSON({ version: 999, money: 5 }).money).toBe(0);
    const partial = Profile.fromJSON({ version: 1, money: 7, missions: { a: null } });
    expect(partial.money).toBe(7);
    expect(partial.record('a')).toBeNull();
  });

  it('бесконечные рекорды переживают JSON (Infinity → null → Infinity)', () => {
    const p = new Profile();
    p.applyResult({
      missionId: 'port',
      success: false,
      reason: 'aborted',
      alarmTime: 0,
      totalTime: 10,
      payout: 0,
      delivered: [],
      requiredDelivered: 0,
      requiredTotal: 1,
      valuablesDelivered: 0,
    });
    const back = Profile.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
    expect(back.record('port')!.bestAlarmTime).toBe(Infinity);
  });
});
