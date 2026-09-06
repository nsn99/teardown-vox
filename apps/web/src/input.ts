import { CharacterInput } from '@tvox/game';

export interface InputState extends CharacterInput {
  /** Накопленное смещение мыши с прошлого кадра, радианы. */
  dYaw: number;
  dPitch: number;
  firing: boolean;
  /** Однократные нажатия, которые обработчик обязан «съесть». */
  pressed: Set<string>;
  wheel: number;
}

export interface InputOptions {
  sensitivity?: number;
  canvas: HTMLCanvasElement;
}

/**
 * Ввод: клавиатура по физическим кодам (раскладка не важна), мышь через
 * захват указателя. Никакой игровой логики — только состояние.
 */
export class Input {
  readonly state: InputState = {
    forward: 0,
    right: 0,
    jump: false,
    sprint: false,
    crouch: false,
    dYaw: 0,
    dPitch: 0,
    firing: false,
    pressed: new Set(),
    wheel: 0,
  };

  sensitivity: number;
  private down = new Set<string>();
  private canvas: HTMLCanvasElement;
  private detachers: Array<() => void> = [];

  constructor(opts: InputOptions) {
    this.canvas = opts.canvas;
    this.sensitivity = opts.sensitivity ?? 0.0022;
    this.attach();
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  requestLock(): void {
    void this.canvas.requestPointerLock();
  }

  releaseLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  private on<K extends keyof WindowEventMap>(
    target: Window | Document | HTMLElement,
    type: K | string,
    fn: (e: Event) => void,
    opts?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, fn as EventListener, opts);
    this.detachers.push(() => target.removeEventListener(type, fn as EventListener));
  }

  private attach(): void {
    this.on(window, 'keydown', (e) => {
      const ev = e as KeyboardEvent;
      if (ev.repeat) return;
      this.down.add(ev.code);
      this.state.pressed.add(ev.code);
      // Пробел и стрелки не должны прокручивать страницу под игрой.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(ev.code)) {
        ev.preventDefault();
      }
    });

    this.on(window, 'keyup', (e) => this.down.delete((e as KeyboardEvent).code));
    this.on(window, 'blur', () => {
      this.down.clear();
      this.state.firing = false;
    });

    this.on(this.canvas, 'mousedown', (e) => {
      const ev = e as MouseEvent;
      if (!this.locked) return;
      if (ev.button === 0) this.state.firing = true;
      if (ev.button === 2) this.state.pressed.add('Mouse2');
    });
    this.on(window, 'mouseup', (e) => {
      if ((e as MouseEvent).button === 0) this.state.firing = false;
    });
    this.on(this.canvas, 'contextmenu', (e) => e.preventDefault());

    this.on(window, 'mousemove', (e) => {
      if (!this.locked) return;
      const ev = e as MouseEvent;
      this.state.dYaw -= ev.movementX * this.sensitivity;
      this.state.dPitch -= ev.movementY * this.sensitivity;
    });

    this.on(
      window,
      'wheel',
      (e) => {
        if (!this.locked) return;
        const ev = e as WheelEvent;
        this.state.wheel += Math.sign(ev.deltaY);
        ev.preventDefault();
      },
      { passive: false },
    );
  }

  /** Собирает состояние осей на текущий кадр. */
  sample(): InputState {
    const s = this.state;
    const held = (...codes: string[]) => codes.some((c) => this.down.has(c));
    s.forward = (held('KeyW', 'ArrowUp') ? 1 : 0) - (held('KeyS', 'ArrowDown') ? 1 : 0);
    s.right = (held('KeyD', 'ArrowRight') ? 1 : 0) - (held('KeyA', 'ArrowLeft') ? 1 : 0);
    s.jump = held('Space');
    s.sprint = held('ShiftLeft', 'ShiftRight');
    s.crouch = held('ControlLeft', 'ControlRight', 'KeyC');
    return s;
  }

  /** Проверяет однократное нажатие и сбрасывает его. */
  take(code: string): boolean {
    if (!this.state.pressed.has(code)) return false;
    this.state.pressed.delete(code);
    return true;
  }

  takeWheel(): number {
    const w = this.state.wheel;
    this.state.wheel = 0;
    return w;
  }

  /** Сбрасывает накопленный поворот. Вызывать после применения к камере. */
  consumeLook(): { yaw: number; pitch: number } {
    const out = { yaw: this.state.dYaw, pitch: this.state.dPitch };
    this.state.dYaw = 0;
    this.state.dPitch = 0;
    return out;
  }

  clearPressed(): void {
    this.state.pressed.clear();
  }

  dispose(): void {
    for (const off of this.detachers) off();
    this.detachers = [];
  }
}
