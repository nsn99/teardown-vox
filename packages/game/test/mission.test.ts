import { beforeEach, describe, expect, it } from 'vitest';
import { v3 } from '@tvox/core';
import { Mission, MissionConfig, MissionResult, TargetSpec } from '@tvox/game';

const target = (over: Partial<TargetSpec> = {}): TargetSpec => ({
  id: 'safe',
  name: 'Сейф',
  kind: 'safe',
  wired: true,
  required: true,
  value: 10000,
  position: v3(0, 0, 0),
  ...over,
});

const ZONE = { center: v3(50, 0, 0), halfExtents: v3(2, 2, 2) };
const INSIDE = v3(50, 0, 0);
const OUTSIDE = v3(0, 0, 0);

function makeMission(over: Partial<MissionConfig> = {}): Mission {
  return new Mission({
    id: 'test',
    name: 'Тест',
    brief: '',
    alarmSeconds: 60,
    targets: [target()],
    extraction: ZONE,
    ...over,
  });
}

describe('фазы миссии', () => {
  it('стартует в брифинге и переходит в разведку', () => {
    const m = makeMission();
    expect(m.phase).toBe('briefing');
    const phases: string[] = [];
    m.events.on('phase:changed', (e) => phases.push(e.to));
    m.begin();
    expect(m.phase).toBe('recon');
    m.begin();
    expect(phases).toEqual(['recon']);
  });

  it('в разведке таймера нет', () => {
    const m = makeMission();
    m.begin();
    m.update(1000, OUTSIDE);
    expect(m.phase).toBe('recon');
    expect(m.alarmActive).toBe(false);
    expect(m.timeLeft).toBe(60);
  });

  it('нулевой или отрицательный таймер отвергается', () => {
    expect(() => makeMission({ alarmSeconds: 0 })).toThrow(RangeError);
    expect(() => makeMission({ alarmSeconds: -5 })).toThrow(RangeError);
  });
});

describe('сигнализация', () => {
  it('взятие проводной цели запускает тревогу', () => {
    const m = makeMission();
    m.begin();
    let started = 0;
    m.events.on('alarm:started', (e) => {
      started++;
      expect(e.seconds).toBe(60);
      expect(e.trigger).toBe('safe');
    });
    expect(m.pickUp('safe')).toBe(true);
    expect(m.phase).toBe('alarm');
    expect(started).toBe(1);
  });

  it('непроводная ценность тревогу не поднимает', () => {
    const m = makeMission({
      targets: [target({ id: 'painting', wired: false, required: false })],
    });
    m.begin();
    m.pickUp('painting');
    expect(m.phase).toBe('recon');
  });

  it('таймер ровно 60 секунд: на 59.99 ещё живы, на 60.0 — провал', () => {
    const m = makeMission();
    m.begin();
    m.pickUp('safe');
    for (let i = 0; i < 5999; i++) m.update(0.01, OUTSIDE);
    expect(m.phase).toBe('alarm');
    expect(m.timeLeft).toBeCloseTo(0.01, 6);
    m.update(0.01, OUTSIDE);
    expect(m.phase).toBe('failed');
    expect(m.result!.reason).toBe('timeout');
  });

  it('провал по таймеру не платит ни рубля', () => {
    const m = makeMission({
      targets: [target(), target({ id: 'cash', wired: false, required: false, value: 5000 })],
    });
    m.begin();
    m.pickUp('cash');
    m.update(0.1, INSIDE); // ценность сдана
    m.pickUp('safe');
    m.update(61, OUTSIDE);
    expect(m.result!.success).toBe(false);
    expect(m.result!.payout).toBe(0);
  });

  it('тревогу можно поднять вручную — перебитый кабель', () => {
    const m = makeMission();
    m.begin();
    expect(m.triggerAlarm('cable')).toBe(true);
    expect(m.phase).toBe('alarm');
    expect(m.triggerAlarm('cable')).toBe(false);
  });

  it('шлёт тик таймера каждый апдейт', () => {
    const m = makeMission();
    m.begin();
    m.pickUp('safe');
    const ticks: number[] = [];
    m.events.on('alarm:tick', (e) => ticks.push(e.timeLeft));
    m.update(1, OUTSIDE);
    m.update(1, OUTSIDE);
    expect(ticks).toHaveLength(2);
    expect(ticks[0]).toBeCloseTo(59, 6);
    expect(ticks[1]).toBeCloseTo(58, 6);
  });
});

describe('переноска целей', () => {
  it('несёт не больше maxCarried', () => {
    const m = makeMission({
      maxCarried: 1,
      targets: [target(), target({ id: 'docs' })],
    });
    m.begin();
    expect(m.pickUp('safe')).toBe(true);
    expect(m.pickUp('docs')).toBe(false);
    expect(m.carriedIds).toEqual(['safe']);
  });

  it('несомая цель едет за игроком', () => {
    const m = makeMission();
    m.begin();
    m.pickUp('safe');
    m.update(0.1, v3(7, 1, 8));
    expect(m.targets.get('safe')!.position).toEqual(v3(7, 1, 8));
  });

  it('брошенная цель остаётся на месте', () => {
    const m = makeMission();
    m.begin();
    m.pickUp('safe');
    const dropped: string[] = [];
    m.events.on('target:dropped', (e) => dropped.push(e.target.id));
    expect(m.drop('safe', v3(3, 0, 3))).toBe(true);
    expect(m.targets.get('safe')!.state).toBe('idle');
    m.update(0.1, v3(99, 0, 99));
    expect(m.targets.get('safe')!.position).toEqual(v3(3, 0, 3));
    expect(dropped).toEqual(['safe']);
  });

  it('нельзя взять несуществующую или уже сданную цель', () => {
    const m = makeMission();
    m.begin();
    expect(m.pickUp('nope')).toBe(false);
    m.pickUp('safe');
    m.update(0.1, INSIDE);
    expect(m.pickUp('safe')).toBe(false);
    expect(m.drop('nope', OUTSIDE)).toBe(false);
  });

  it('первое взятие само выводит из брифинга', () => {
    const m = makeMission();
    expect(m.pickUp('safe')).toBe(true);
    expect(m.phase).toBe('alarm');
  });
});

describe('эвакуация', () => {
  it('доставка всех обязательных целей + игрок в зоне = успех', () => {
    const m = makeMission();
    let result: MissionResult | null = null;
    m.events.on('mission:success', (r) => (result = r));
    m.begin();
    m.pickUp('safe');
    m.update(1, INSIDE);
    expect(m.phase).toBe('success');
    expect(result!.payout).toBe(10000);
    expect(result!.requiredDelivered).toBe(1);
  });

  it('цель в зоне, но игрок снаружи — успеха нет', () => {
    const m = makeMission({ requirePlayerInZone: true });
    m.begin();
    m.pickUp('safe');
    m.drop('safe', INSIDE);
    m.update(1, OUTSIDE);
    expect(m.targets.get('safe')!.state).toBe('delivered');
    expect(m.phase).toBe('alarm');
  });

  it('без требования присутствия хватает самой цели', () => {
    const m = makeMission({ requirePlayerInZone: false });
    m.begin();
    m.pickUp('safe');
    m.drop('safe', INSIDE);
    m.update(1, OUTSIDE);
    expect(m.phase).toBe('success');
  });

  it('доставка на последней десятой секунды засчитывается', () => {
    const m = makeMission();
    m.begin();
    m.pickUp('safe');
    for (let i = 0; i < 599; i++) m.update(0.1, OUTSIDE);
    expect(m.phase).toBe('alarm');
    m.update(0.1, INSIDE);
    expect(m.phase).toBe('success');
  });

  it('ценности идут в кассу сверх обязательных целей', () => {
    const m = makeMission({
      targets: [
        target(),
        target({ id: 'painting', wired: false, required: false, value: 4000 }),
      ],
    });
    m.begin();
    m.pickUp('painting');
    m.update(0.1, INSIDE);
    m.pickUp('safe');
    m.update(0.1, INSIDE);
    expect(m.result!.payout).toBe(14000);
    expect(m.result!.valuablesDelivered).toBe(1);
  });

  it('миссия без обязательных целей не завершается сама', () => {
    const m = makeMission({
      targets: [target({ id: 'cash', required: false, wired: false })],
    });
    m.begin();
    m.update(1, INSIDE);
    expect(m.phase).toBe('recon');
  });

  it('после финала обновления игнорируются', () => {
    const m = makeMission();
    m.begin();
    m.pickUp('safe');
    m.update(1, INSIDE);
    const t = m.totalTime;
    m.update(10, OUTSIDE);
    expect(m.totalTime).toBe(t);
    expect(m.pickUp('safe')).toBe(false);
  });
});

describe('досрочный выход и рестарт', () => {
  it('abort = провал без денег', () => {
    const m = makeMission();
    let failed: MissionResult | null = null;
    m.events.on('mission:failed', (r) => (failed = r));
    m.begin();
    m.pickUp('safe');
    m.abort();
    expect(m.phase).toBe('failed');
    expect(failed!.reason).toBe('aborted');
    m.abort();
    expect(m.phase).toBe('failed');
  });

  it('рестарт возвращает всё в исходное', () => {
    const m = makeMission();
    m.begin();
    m.pickUp('safe');
    m.update(30, OUTSIDE);
    m.restart();
    expect(m.phase).toBe('briefing');
    expect(m.timeLeft).toBe(60);
    expect(m.totalTime).toBe(0);
    expect(m.result).toBeNull();
    expect(m.carriedIds).toHaveLength(0);
    expect(m.targets.get('safe')!.state).toBe('idle');
  });
});

describe('зона эвакуации', () => {
  let m: Mission;
  beforeEach(() => {
    m = makeMission();
  });

  it('определяет попадание точки', () => {
    expect(m.inExtractionZone(v3(50, 0, 0))).toBe(true);
    expect(m.inExtractionZone(v3(51.9, 1.9, 1.9))).toBe(true);
    expect(m.inExtractionZone(v3(53, 0, 0))).toBe(false);
  });
});
