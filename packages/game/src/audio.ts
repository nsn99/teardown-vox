import { Mat, Vec3, VoxelWorld, distance, makeRng } from '@tvox/core';

/**
 * Звуковой режиссёр.
 *
 * Здесь нет ни Web Audio, ни файлов — только правила: что и как громко
 * должно прозвучать. Синтез живёт в приложении, а правила лежат тут,
 * потому что «удар по стали звучит не как удар по дереву» — это игровое
 * решение, и проверяться оно должно тестом, а не ухом.
 */

export type SoundId =
  | 'hit-wood'
  | 'hit-stone'
  | 'hit-metal'
  | 'hit-glass'
  | 'explosion'
  | 'collapse'
  | 'siren'
  | 'rotor'
  | 'fire'
  | 'splash'
  | 'pickup';

export interface SoundCue {
  id: SoundId;
  /** Громкость 0..1 — уже с учётом расстояния и материала. */
  gain: number;
  /** Множитель высоты тона. */
  pitch: number;
  /** Точка в мире; null — звук «в голове»: сирена, интерфейс. */
  at: Vec3 | null;
  /** Тянущийся звук: его надо держать, а не дёргать заново каждый кадр. */
  loop?: boolean;
}

export interface AudioOptions {
  /** Больше этого числа разовых звуков за кадр не выпускаем. */
  maxPerFrame?: number;
  /** Один и тот же звук не чаще, чем раз в столько секунд. */
  cooldown?: number;
  /** Расстояние, дальше которого звук уже не слышен, м. */
  maxDistance?: number;
  /** Ближе этого расстояния громкость не растёт, м. */
  refDistance?: number;
  seed?: number;
}

const DEFAULTS = {
  maxPerFrame: 6,
  cooldown: 0.06,
  maxDistance: 70,
  refDistance: 4,
  seed: 0xa1d10,
} satisfies Required<AudioOptions>;

/** Материал → как это звучит. */
export function soundOfMaterial(mat: number): SoundId {
  switch (mat) {
    case Mat.Glass:
      return 'hit-glass';
    case Mat.Metal:
    case Mat.HeavyMetal:
    case Mat.Cable:
      return 'hit-metal';
    case Mat.Wood:
    case Mat.Plank:
    case Mat.Foliage:
    case Mat.Charred:
    case Mat.Plastic:
      return 'hit-wood';
    default:
      return 'hit-stone';
  }
}

/** Базовая высота тона материала: сталь звенит выше, бетон глуше. */
const PITCH: Record<SoundId, number> = {
  'hit-wood': 1,
  'hit-stone': 0.8,
  'hit-metal': 1.35,
  'hit-glass': 1.7,
  explosion: 0.6,
  collapse: 0.5,
  siren: 1,
  rotor: 1,
  fire: 1,
  splash: 1.1,
  pickup: 1.2,
};

export interface MissionAudioState {
  alarmActive: boolean;
  /** Секунд до вертолёта. */
  timeLeft: number;
  alarmSeconds: number;
  /** Близость преследователя, 0..1. Единица — прямо над головой. */
  pursuit?: number;
}

interface Pending {
  id: SoundId;
  gain: number;
  pitch: number;
  at: Vec3 | null;
}

export class AudioDirector {
  private cfg: Required<AudioOptions>;
  private queue: Pending[] = [];
  private lastPlayed = new Map<SoundId, number>();
  private rng: () => number;
  private time = 0;
  private burning = 0;
  private burningCount: (() => number) | null = null;
  private _muted = false;
  private detach: Array<() => void> = [];

  constructor(opts: AudioOptions = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    this.rng = makeRng(this.cfg.seed);
  }

  get muted(): boolean {
    return this._muted;
  }

  /** Выключить/включить звук одной кнопкой. */
  toggleMute(): boolean {
    this._muted = !this._muted;
    if (this._muted) this.queue.length = 0;
    return this._muted;
  }

  setMuted(value: boolean): void {
    this._muted = value;
    if (value) this.queue.length = 0;
  }

  /** Подписаться на события мира. Возвращает отписку. */
  listen(world: VoxelWorld, burningCount?: () => number): () => void {
    this.burning = 0;
    this.burningCount = burningCount ?? null;
    const off: Array<() => void> = [];

    off.push(
      world.events.on('voxels:removed', (e) => {
        if (e.count <= 0) return;
        // Звучит самый заметный материал в этой порции, а не первый попавшийся.
        let best = Mat.Concrete;
        let bestCount = 0;
        for (const [mat, n] of e.materials) {
          if (n > bestCount) {
            best = mat;
            bestCount = n;
          }
        }
        const id = e.cause === 'explosive' || e.cause === 'explosion'
          ? 'explosion'
          : soundOfMaterial(best);
        const gain = clamp01(0.25 + Math.log10(1 + e.count) * 0.3);
        this.push(id, gain, e.center);
      }),
    );

    off.push(
      world.events.on('body:split', (e) => {
        let mass = 0;
        for (const b of e.fragments) mass += b.mass();
        if (mass <= 0) return;
        // Соразмерно массе, но не линейно: тонна не должна быть в сто раз
        // громче десяти килограммов, иначе всё остальное пропадёт.
        const gain = clamp01(0.2 + Math.log10(1 + mass) * 0.22);
        const at = e.fragments[0]?.transform.position ?? null;
        this.push('collapse', gain, at);
      }),
    );

    off.push(
      world.events.on('impact', (e) => {
        const gain = clamp01(0.15 + Math.log10(1 + e.impulse) * 0.16);
        this.push('collapse', gain, e.point);
      }),
    );

    off.push(
      world.events.on('fire:ignited', () => {
        this.burning++;
      }),
    );
    off.push(
      world.events.on('fire:burnedOut', () => {
        this.burning = Math.max(0, this.burning - 1);
      }),
    );

    const stop = () => {
      for (const f of off) f();
    };
    this.detach.push(stop);
    return stop;
  }

  dispose(): void {
    for (const f of this.detach) f();
    this.detach.length = 0;
    this.queue.length = 0;
    this.burning = 0;
    this.burningCount = null;
    this.lastPlayed.clear();
  }

  /** Ручной звук — интерфейс, подбор цели, всплеск. */
  push(id: SoundId, gain: number, at: Vec3 | null): void {
    if (this._muted) return;
    this.queue.push({ id, gain: clamp01(gain), pitch: PITCH[id], at });
  }

  /**
   * Реплики этого кадра.
   *
   * Разовые звуки прижимаются расстоянием и режутся по числу: сто
   * вокселей, осыпавшихся за кадр, — это один шорох, а не сто щелчков.
   * Сирена и огонь идут отдельно, они тянущиеся.
   */
  update(dt: number, listener: Vec3, mission?: MissionAudioState): SoundCue[] {
    this.time += dt;
    if (this._muted) {
      this.queue.length = 0;
      return [];
    }

    const out: SoundCue[] = [];
    const byId = new Map<SoundId, Pending>();
    for (const p of this.queue) {
      const prev = byId.get(p.id);
      if (!prev || p.gain > prev.gain) byId.set(p.id, p);
    }
    this.queue.length = 0;

    const ranked = [...byId.values()].sort((a, b) => b.gain - a.gain);
    for (const p of ranked) {
      if (out.length >= this.cfg.maxPerFrame) break;
      const last = this.lastPlayed.get(p.id) ?? -Infinity;
      if (this.time - last < this.cfg.cooldown) continue;

      const gain = p.at ? p.gain * this.attenuation(listener, p.at) : p.gain;
      if (gain <= 0.01) continue;
      this.lastPlayed.set(p.id, this.time);
      out.push({
        id: p.id,
        gain: clamp01(gain),
        // Небольшой разброс высоты: иначе серия ударов звучит как автомат.
        pitch: p.pitch * (0.92 + this.rng() * 0.16),
        at: p.at,
      });
    }

    const burning = this.burningCount?.() ?? this.burning;
    if (burning > 0) {
      out.push({
        id: 'fire',
        gain: clamp01(0.15 + Math.log10(1 + burning) * 0.25),
        pitch: 1,
        at: null,
        loop: true,
      });
    }

    if (mission?.alarmActive) {
      // Сирена слышна отовсюду и к концу таймера давит сильнее: это
      // единственный способ сообщить про время, не глядя на цифры.
      const spent = clamp01(1 - mission.timeLeft / Math.max(1e-6, mission.alarmSeconds));
      out.push({
        id: 'siren',
        gain: clamp01(0.45 + spent * 0.5),
        pitch: 1 + spent * 0.35,
        at: null,
        loop: true,
      });
    }

    // Винт слышно раньше, чем видно, и это единственное предупреждение,
    // которое игрок получает вовремя. Высота тона растёт с приближением:
    // так «он ещё далеко» и «он уже над тобой» различаются на слух.
    const near = mission?.pursuit ?? 0;
    if (near > 0.02) {
      out.push({
        id: 'rotor',
        gain: clamp01(0.12 + near * 0.75),
        pitch: 0.8 + near * 0.5,
        at: null,
        loop: true,
      });
    }

    return out;
  }

  /** Затухание с расстоянием: до refDistance — в полный голос. */
  private attenuation(listener: Vec3, at: Vec3): number {
    const d = distance(listener, at);
    if (d <= this.cfg.refDistance) return 1;
    if (d >= this.cfg.maxDistance) return 0;
    const t = (d - this.cfg.refDistance) / (this.cfg.maxDistance - this.cfg.refDistance);
    return (1 - t) * (1 - t);
  }
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
