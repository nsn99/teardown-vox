import { SoundCue, SoundId } from '@tvox/game';

/**
 * Синтез звука в браузере.
 *
 * Ни одного файла: всё собирается из шума и осцилляторов прямо в Web
 * Audio. Причина простая — звуковая библиотека весит больше, чем вся
 * игра, а разрушению нужен не оркестр, а удар нужного тембра в нужный
 * момент. Тембр задаётся фильтром и огибающей, а решает, что и когда
 * играть, AudioDirector в игровом слое.
 */

interface Voice {
  gain: GainNode;
  stop: () => void;
}

/** Настройки тембра разовых ударов. */
const HIT: Record<string, { freq: number; q: number; decay: number; tone: number }> = {
  'hit-wood': { freq: 420, q: 2.2, decay: 0.16, tone: 0.35 },
  'hit-stone': { freq: 260, q: 1.4, decay: 0.22, tone: 0.15 },
  'hit-metal': { freq: 1500, q: 9, decay: 0.5, tone: 0.75 },
  'hit-glass': { freq: 3200, q: 14, decay: 0.35, tone: 0.9 },
  explosion: { freq: 90, q: 0.9, decay: 1.1, tone: 0.05 },
  collapse: { freq: 150, q: 1.1, decay: 0.7, tone: 0.1 },
  splash: { freq: 900, q: 1.6, decay: 0.3, tone: 0.4 },
  pickup: { freq: 1200, q: 6, decay: 0.12, tone: 0.8 },
};

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private loops = new Map<SoundId, Voice>();
  private muted = false;

  /** Слышимость зависит от жеста пользователя: браузер иначе не пустит. */
  resume(): void {
    if (!this.ctx) this.init();
    void this.ctx?.resume();
  }

  setMuted(value: boolean): void {
    this.muted = value;
    if (!this.master || !this.ctx) return;
    this.master.gain.setTargetAtTime(value ? 0 : 1, this.ctx.currentTime, 0.05);
    if (value) this.stopLoops();
  }

  /** Отыграть реплики кадра. */
  play(cues: SoundCue[]): void {
    if (this.muted) return;
    if (!this.ctx) return;

    const wanted = new Set<SoundId>();
    for (const cue of cues) {
      if (cue.loop) {
        wanted.add(cue.id);
        this.updateLoop(cue);
      } else {
        this.oneShot(cue);
      }
    }
    for (const [id, voice] of this.loops) {
      if (wanted.has(id)) continue;
      voice.stop();
      this.loops.delete(id);
    }
  }

  dispose(): void {
    this.stopLoops();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }

  // -------------------------------------------------------------------

  private init(): void {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(this.ctx.destination);
    this.noise = makeNoise(this.ctx, 1.2);
  }

  private oneShot(cue: SoundCue): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;

    const spec = HIT[cue.id] ?? HIT['hit-stone'];
    const now = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = cue.pitch;

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = spec.freq * cue.pitch;
    band.Q.value = spec.q;

    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.value = 400 + spec.tone * 6000;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, cue.gain), now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + spec.decay);

    src.connect(band).connect(body).connect(gain).connect(master);
    src.start(now);
    src.stop(now + spec.decay + 0.05);
  }

  private updateLoop(cue: SoundCue): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    const existing = this.loops.get(cue.id);
    if (existing) {
      existing.gain.gain.setTargetAtTime(cue.gain, ctx.currentTime, 0.08);
      return;
    }
    const voice = cue.id === 'siren' ? this.makeSiren(cue) : this.makeFire(cue);
    if (voice) this.loops.set(cue.id, voice);
  }

  /** Сирена: две пилы в расстройке плюс медленное качание высоты. */
  private makeSiren(cue: SoundCue): Voice | null {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return null;

    const gain = ctx.createGain();
    gain.gain.value = cue.gain;
    gain.connect(master);

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc2.type = 'sawtooth';
    osc1.frequency.value = 520 * cue.pitch;
    osc2.frequency.value = 524 * cue.pitch;

    const sweep = ctx.createOscillator();
    sweep.frequency.value = 0.55;
    const sweepDepth = ctx.createGain();
    sweepDepth.gain.value = 110;
    sweep.connect(sweepDepth);
    sweepDepth.connect(osc1.frequency);
    sweepDepth.connect(osc2.frequency);

    const shape = ctx.createBiquadFilter();
    shape.type = 'bandpass';
    shape.frequency.value = 900;
    shape.Q.value = 1.2;

    osc1.connect(shape);
    osc2.connect(shape);
    shape.connect(gain);
    osc1.start();
    osc2.start();
    sweep.start();

    return {
      gain,
      stop: () => {
        gain.gain.setTargetAtTime(0, ctx.currentTime, 0.12);
        osc1.stop(ctx.currentTime + 0.4);
        osc2.stop(ctx.currentTime + 0.4);
        sweep.stop(ctx.currentTime + 0.4);
      },
    };
  }

  /** Огонь: розоватый шум, слегка колышущийся по громкости. */
  private makeFire(cue: SoundCue): Voice | null {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return null;

    const gain = ctx.createGain();
    gain.gain.value = cue.gain;
    gain.connect(master);

    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;

    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 1400;

    const flicker = ctx.createOscillator();
    flicker.frequency.value = 7;
    const flickerDepth = ctx.createGain();
    flickerDepth.gain.value = 300;
    flicker.connect(flickerDepth).connect(low.frequency);

    src.connect(low).connect(gain);
    src.start();
    flicker.start();

    return {
      gain,
      stop: () => {
        gain.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
        src.stop(ctx.currentTime + 0.5);
        flicker.stop(ctx.currentTime + 0.5);
      },
    };
  }

  private stopLoops(): void {
    for (const voice of this.loops.values()) voice.stop();
    this.loops.clear();
  }
}

/** Буфер белого шума — основа всех ударов. */
function makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let seed = 0x2f6e2b1;
  for (let i = 0; i < len; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    data[i] = (seed / 0xffffffff) * 2 - 1;
  }
  return buf;
}
