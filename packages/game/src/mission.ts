import { EventBus, Vec3, aabbContains, v3 } from '@tvox/core';

export type MissionPhase = 'briefing' | 'recon' | 'alarm' | 'success' | 'failed';

export type FailReason = 'timeout' | 'aborted' | 'target-lost';

export type TargetKind = 'painting' | 'safe' | 'electronics' | 'documents' | 'cash';

export interface TargetSpec {
  id: string;
  name: string;
  kind: TargetKind;
  /**
   * Подключена к кабелю сигнализации. Взятие ЛЮБОЙ проводной цели
   * запускает таймер. Ценности без провода можно выносить тихо.
   */
  wired: boolean;
  /** Без неё миссия не засчитывается. */
  required: boolean;
  /** Награда, ₽. */
  value: number;
  position: Vec3;
  /** Кг — тяжёлое тащить медленнее. */
  mass?: number;
}

export interface ExtractionZone {
  center: Vec3;
  halfExtents: Vec3;
}

export interface MissionConfig {
  id: string;
  name: string;
  brief: string;
  /** Строго фиксированный таймер тревоги. Сложность — только это число. */
  alarmSeconds: number;
  targets: TargetSpec[];
  extraction: ExtractionZone;
  /** Сколько целей игрок несёт одновременно. */
  maxCarried?: number;
  /**
   * Что игрок в состоянии поднять руками, кг.
   *
   * Без этого числа сейф на сто восемьдесят килограммов носят как папку с
   * документами, и вся техника на карте становится украшением. Тяжёлое не
   * поднимают — его закатывают в кузов, а кузов увозит машина: у карты
   * появляется задача, которую иначе не решить.
   */
  liftMass?: number;
  /** Нужно ли самому оказаться в зоне эвакуации для успеха. */
  requirePlayerInZone?: boolean;
}

export type TargetState = 'idle' | 'carried' | 'stowed' | 'delivered';

export interface TargetRuntime {
  spec: TargetSpec;
  state: TargetState;
  position: Vec3;
  /** id техники, в кузове которой лежит цель. */
  carrier?: string;
}

export interface MissionResult {
  missionId: string;
  success: boolean;
  reason: FailReason | 'extracted';
  /** Секунд от старта тревоги до финала. Без тревоги — 0. */
  alarmTime: number;
  /** Полное время прохождения, с. */
  totalTime: number;
  payout: number;
  delivered: string[];
  requiredDelivered: number;
  requiredTotal: number;
  valuablesDelivered: number;
}

export interface MissionEvents extends Record<string, unknown> {
  'phase:changed': { from: MissionPhase; to: MissionPhase };
  'alarm:started': { seconds: number; trigger: string };
  'alarm:tick': { timeLeft: number };
  'target:taken': { target: TargetSpec };
  'target:dropped': { target: TargetSpec; position: Vec3 };
  'target:delivered': { target: TargetSpec };
  'target:stowed': { target: TargetSpec; carrier: string };
  'mission:success': MissionResult;
  'mission:failed': MissionResult;
}

const DEFAULT_ALARM = 60;
/** Допуск на накопленную ошибку double при суммировании dt. */
const TIME_EPS = 1e-9;

/**
 * Конечный автомат ограбления.
 *
 *   briefing → recon → (взяли проводную цель) → alarm → success | failed
 *
 * В разведке таймера нет: ходи, ломай, ставь технику, размечай маршрут.
 * Как только снята первая проводная цель, идут ровно alarmSeconds секунд.
 * По истечении — вертолёт, и это мгновенный провал без вариантов.
 */
export class Mission {
  readonly config: Required<MissionConfig>;
  readonly events = new EventBus<MissionEvents>();
  readonly targets = new Map<string, TargetRuntime>();

  private _phase: MissionPhase = 'briefing';
  private _totalTime = 0;
  private _alarmTime = 0;
  private _result: MissionResult | null = null;
  private carried: string[] = [];

  constructor(config: MissionConfig) {
    this.config = {
      maxCarried: 1,
      requirePlayerInZone: true,
      liftMass: 60,
      ...config,
      alarmSeconds: config.alarmSeconds ?? DEFAULT_ALARM,
    };
    if (this.config.alarmSeconds <= 0) {
      throw new RangeError('Таймер тревоги должен быть положительным');
    }
    this.resetTargets();
  }

  private resetTargets(): void {
    this.targets.clear();
    for (const spec of this.config.targets) {
      this.targets.set(spec.id, {
        spec,
        state: 'idle',
        position: { ...spec.position },
      });
    }
  }

  get phase(): MissionPhase {
    return this._phase;
  }

  /**
   * Остаток тревоги. Считается вычитанием из константы, а не накоплением
   * «сколько осталось»: суммировать dt тысячи раз и надеяться на точный
   * ноль — верный способ подарить игроку лишний кадр или отнять его.
   */
  get timeLeft(): number {
    if (this._phase !== 'alarm') return this.config.alarmSeconds;
    return Math.max(0, this.config.alarmSeconds - this._alarmTime);
  }

  get alarmActive(): boolean {
    return this._phase === 'alarm';
  }

  get totalTime(): number {
    return this._totalTime;
  }

  get alarmTime(): number {
    return this._alarmTime;
  }

  get result(): MissionResult | null {
    return this._result;
  }

  get finished(): boolean {
    return this._phase === 'success' || this._phase === 'failed';
  }

  /** Все цели миссии с текущим состоянием. */
  allTargets(): TargetRuntime[] {
    return [...this.targets.values()].map((t) => ({ ...t }));
  }

  /** Состояние конкретной цели. */
  target(id: string): TargetRuntime | null {
    const t = this.targets.get(id);
    return t ? { ...t } : null;
  }

  get carriedIds(): readonly string[] {
    return this.carried;
  }

  requiredTargets(): TargetRuntime[] {
    return [...this.targets.values()].filter((t) => t.spec.required);
  }

  deliveredTargets(): TargetRuntime[] {
    return [...this.targets.values()].filter((t) => t.state === 'delivered');
  }

  /** Начать прохождение: из брифинга в разведку. */
  begin(): void {
    if (this._phase !== 'briefing') return;
    this.setPhase('recon');
  }

  private setPhase(to: MissionPhase): void {
    const from = this._phase;
    if (from === to) return;
    this._phase = to;
    this.events.emit('phase:changed', { from, to });
  }

  /** Поднимается ли цель руками. Тяжёлое возят, а не носят. */
  canLift(id: string): boolean {
    const t = this.targets.get(id);
    if (!t) return false;
    return (t.spec.mass ?? 0) <= this.config.liftMass;
  }

  /** Взять цель в руки. Проводная цель поднимает тревогу. */
  pickUp(id: string): boolean {
    if (this.finished) return false;
    const t = this.targets.get(id);
    if (!t) return false;
    if (t.state !== 'idle') return false;
    if (this.carried.length >= this.config.maxCarried) return false;
    // Вес проверяем до начала миссии: попытка поднять неподъёмное ничего
    // в мире не меняет — ни таймера, ни тревоги. Провод рвут кувалдой или
    // руками, а не безуспешным подёргиванием сейфа.
    if (!this.canLift(id)) return false;
    if (this._phase === 'briefing') this.begin();

    t.state = 'carried';
    this.carried.push(id);
    this.events.emit('target:taken', { target: t.spec });

    if (t.spec.wired && this._phase === 'recon') this.triggerAlarm(id);
    return true;
  }

  /** Поднять тревогу принудительно — например, сломали кабель. */
  triggerAlarm(trigger = 'manual'): boolean {
    if (this._phase !== 'recon' && this._phase !== 'briefing') return false;
    this.setPhase('alarm');
    this._alarmTime = 0;
    this.events.emit('alarm:started', { seconds: this.config.alarmSeconds, trigger });
    return true;
  }

  /**
   * Переложить цель из рук в кузов.
   *
   * Груз в кузове — это не «в руках»: руки освобождаются, цель едет с
   * машиной и засчитывается, когда машина въезжает в зону. Выпав на
   * ходу, она остаётся лежать в мире, а не исчезает.
   */
  stow(id: string, carrier: string, position: Vec3): boolean {
    const t = this.targets.get(id);
    if (!t) return false;
    if (t.state !== 'carried' && t.state !== 'idle') return false;
    t.state = 'stowed';
    t.carrier = carrier;
    t.position = { ...position };
    this.carried = this.carried.filter((c) => c !== id);
    this.events.emit('target:stowed', { target: t.spec, carrier });
    return true;
  }

  /** Выгрузить цель из кузова на землю. */
  unstow(id: string, position: Vec3): boolean {
    const t = this.targets.get(id);
    if (!t || t.state !== 'stowed') return false;
    t.state = 'idle';
    t.carrier = undefined;
    t.position = { ...position };
    this.events.emit('target:dropped', { target: t.spec, position: t.position });
    return true;
  }

  /** Что лежит в кузове этой машины. */
  stowedIn(carrier: string): TargetRuntime[] {
    return [...this.targets.values()].filter(
      (t) => t.state === 'stowed' && t.carrier === carrier,
    );
  }

  /** Двигать груз вместе с машиной. */
  moveStowed(carrier: string, position: Vec3): number {
    let n = 0;
    for (const t of this.targets.values()) {
      if (t.state !== 'stowed' || t.carrier !== carrier) continue;
      t.position = { ...position };
      n++;
    }
    return n;
  }

  /** Положить цель. Она остаётся там, где её бросили. */
  drop(id: string, position: Vec3): boolean {
    const t = this.targets.get(id);
    if (!t || t.state !== 'carried') return false;
    t.state = 'idle';
    t.position = { ...position };
    this.carried = this.carried.filter((c) => c !== id);
    this.events.emit('target:dropped', { target: t.spec, position: t.position });
    return true;
  }

  private zoneAabb() {
    const { center, halfExtents } = this.config.extraction;
    return {
      min: v3(center.x - halfExtents.x, center.y - halfExtents.y, center.z - halfExtents.z),
      max: v3(center.x + halfExtents.x, center.y + halfExtents.y, center.z + halfExtents.z),
    };
  }

  inExtractionZone(p: Vec3): boolean {
    return aabbContains(this.zoneAabb(), p);
  }

  /**
   * Шаг миссии. playerPos нужен и для переноски (цель едет с игроком),
   * и для проверки эвакуации.
   */
  update(dt: number, playerPos: Vec3): void {
    if (this.finished || this._phase === 'briefing') return;
    this._totalTime += dt;

    for (const id of this.carried) {
      const t = this.targets.get(id)!;
      t.position = { ...playerPos };
    }

    // Всё, что оказалось в зоне, считается вынесенным.
    for (const t of this.targets.values()) {
      if (t.state === 'delivered') continue;
      if (!this.inExtractionZone(t.position)) continue;
      t.state = 'delivered';
      this.carried = this.carried.filter((c) => c !== t.spec.id);
      this.events.emit('target:delivered', { target: t.spec });
    }

    if (this._phase === 'alarm') {
      this._alarmTime += dt;
      this.events.emit('alarm:tick', { timeLeft: this.timeLeft });
    }

    if (this.checkSuccess(playerPos)) {
      this.finish(true, 'extracted');
      return;
    }

    // Проверка провала строго после успеха: доставка на 59.99 секунде
    // засчитывается, и это принципиально — таймер обязан быть честным.
    if (this._phase === 'alarm' && this._alarmTime >= this.config.alarmSeconds - TIME_EPS) {
      this.finish(false, 'timeout');
    }
  }

  private checkSuccess(playerPos: Vec3): boolean {
    const required = this.requiredTargets();
    if (required.length === 0) return false;
    if (!required.every((t) => t.state === 'delivered')) return false;
    if (this.config.requirePlayerInZone && !this.inExtractionZone(playerPos)) return false;
    return true;
  }

  private finish(success: boolean, reason: MissionResult['reason']): void {
    const delivered = this.deliveredTargets();
    const required = this.requiredTargets();
    this._result = {
      missionId: this.config.id,
      success,
      reason,
      alarmTime: this._alarmTime,
      totalTime: this._totalTime,
      payout: success ? delivered.reduce((sum, t) => sum + t.spec.value, 0) : 0,
      delivered: delivered.map((t) => t.spec.id),
      requiredDelivered: required.filter((t) => t.state === 'delivered').length,
      requiredTotal: required.length,
      valuablesDelivered: delivered.filter((t) => !t.spec.required).length,
    };
    this.setPhase(success ? 'success' : 'failed');
    this.events.emit(success ? 'mission:success' : 'mission:failed', this._result);
  }

  /** Досрочный выход — считается провалом, деньги не платят. */
  abort(): void {
    if (this.finished) return;
    this.finish(false, 'aborted');
  }

  restart(): void {
    this._phase = 'briefing';
    this._totalTime = 0;
    this._alarmTime = 0;
    this._result = null;
    this.carried = [];
    this.resetTargets();
  }
}
