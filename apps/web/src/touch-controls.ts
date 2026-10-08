import { Input } from './input.js';

export type TouchMode = 'foot' | 'vehicle' | 'blade' | 'truck' | 'boat' | 'crane';

/** Radial dead zone and unit-length diagonal: walking and steering share the same stick. */
export function stickAxes(dx: number, dy: number, radius: number): { forward: number; right: number } {
  const length = Math.hypot(dx, dy);
  const distance = Math.min(1, length / Math.max(1, radius));
  const strength = Math.max(0, (distance - 0.12) / 0.88);
  return length ? { forward: -dy / length * strength, right: dx / length * strength } : { forward: 0, right: 0 };
}

export function prefersTouch(): boolean {
  return navigator.maxTouchPoints > 0 && window.matchMedia('(pointer: coarse)').matches;
}

/** Each finger owns one gesture. Cancellation never leaves an action held. */
export class TouchControls {
  private root = document.createElement('div');
  private stick: HTMLElement;
  private knob: HTMLElement;
  private mode: TouchMode | null = null;
  private pointers = new Map<number, { element: HTMLElement; kind: 'stick' | 'look' | 'key'; code?: string; x: number; y: number }>();
  private off: Array<() => void> = [];

  constructor(private input: Input, canvas: HTMLCanvasElement) {
    this.root.id = 'touch-controls';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="touch-toolbar" aria-label="Настройки игры">
        <button data-code="Escape">Меню</button>
        <button data-code="KeyV">Камера</button>
        <button data-code="KeyQ">Качество</button>
        <button data-code="KeyN">Свет</button>
        <button data-code="KeyM">Звук</button>
      </div>
      <div class="touch-tools" aria-label="Выбор инструмента">
        <button data-cycle="-1" aria-label="Предыдущий инструмент">◀</button>
        <span>Инструмент</span>
        <button data-cycle="1" aria-label="Следующий инструмент">▶</button>
      </div>
      <div class="touch-stick" aria-label="Джойстик движения"><span></span><small>Движение</small></div>
      <div class="touch-actions" aria-label="Действия">
        <button data-code="KeyF">Сесть</button>
        <button data-code="KeyE">Взять</button>
        <button data-code="Mouse0" class="touch-primary">Удар</button>
        <button data-code="Space">Прыжок</button>
        <button data-code="ControlLeft">Присесть</button>
        <button data-code="ShiftLeft">Бег</button>
        <button data-code="Mouse2">Подрыв</button>
        <button data-code="KeyG">Выгрузить</button>
        <button data-code="KeyU">На колёса</button>
      </div>
      <div class="touch-look-tip">Обзор — проведи по свободной части экрана</div>`;
    document.body.append(this.root);
    document.body.classList.add('touch-ui');
    this.stick = this.root.querySelector('.touch-stick')!;
    this.knob = this.stick.querySelector('span')!;
    const listen = (el: EventTarget, type: string, fn: (e: Event) => void) => {
      el.addEventListener(type, fn);
      this.off.push(() => el.removeEventListener(type, fn));
    };
    listen(this.root, 'pointerdown', e => this.begin(e as PointerEvent));
    listen(canvas, 'pointerdown', e => this.begin(e as PointerEvent, canvas));
    listen(window, 'pointermove', e => this.move(e as PointerEvent));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      listen(window, type, e => this.end((e as PointerEvent).pointerId));
    }
    listen(window, 'blur', () => this.reset());
    listen(window, 'resize', () => this.reset());
    listen(document, 'visibilitychange', () => { if (document.hidden) this.reset(); });
    listen(this.root, 'contextmenu', e => e.preventDefault());
    this.setMode('foot');
  }

  setVisible(visible: boolean): void {
    this.reset();
    this.root.hidden = !visible;
  }

  setMode(mode: TouchMode): void {
    if (this.mode === mode) return;
    this.reset();
    this.mode = mode;
    const foot = mode === 'foot';
    const crane = mode === 'crane';
    const set = (code: string, label: string, visible = true) => {
      const button = this.root.querySelector<HTMLButtonElement>(`[data-code="${code}"]`)!;
      button.textContent = label;
      button.hidden = !visible;
    };
    set('KeyF', foot ? 'Сесть' : 'Выйти');
    set('KeyE', crane ? 'Зацепить' : mode === 'truck' ? 'Закрепить' : 'Взять');
    set('Mouse0', 'Применить', foot);
    set('Mouse2', 'Подрыв', foot);
    set('Space', crane ? 'Крюк ↑' : mode === 'blade' ? 'Отвал' : 'Прыжок', foot || crane || mode === 'blade');
    set('ControlLeft', crane ? 'Крюк ↓' : foot ? 'Присесть' : 'Тормоз');
    set('ShiftLeft', 'Бег', foot);
    set('KeyG', 'Выгрузить', mode === 'truck');
    set('KeyU', 'На колёса', !foot && !crane && mode !== 'boat');
    this.root.querySelector<HTMLElement>('.touch-tools')!.hidden = !foot;
    this.stick.querySelector('small')!.textContent = crane ? 'Поворот / стрела' : foot ? 'Движение' : 'Руль / газ';
  }

  private begin(e: PointerEvent, canvas?: HTMLCanvasElement): void {
    if (this.root.hidden || !this.input.active || e.pointerType === 'mouse') return;
    const target = canvas ?? (e.target as HTMLElement).closest<HTMLElement>('button, .touch-stick');
    if (!target) return;
    e.preventDefault();
    const kind = canvas ? 'look' : target === this.stick ? 'stick' : 'key';
    // Two fingers on the same control must not release one another's action.
    if ([...this.pointers.values()].some(p => kind === 'key' ? p.element === target : p.kind === kind)) return;
    target.setPointerCapture(e.pointerId);
    const rect = target.getBoundingClientRect();
    this.pointers.set(e.pointerId, { element: target, kind, code: target.dataset.code,
      x: kind === 'stick' ? rect.left + rect.width / 2 : e.clientX,
      y: kind === 'stick' ? rect.top + rect.height / 2 : e.clientY });
    target.classList.add('is-held');
    if (target.dataset.code) this.input.setTouchKey(target.dataset.code, true);
    if (target.dataset.cycle) this.input.state.wheel += Number(target.dataset.cycle);
    if (kind === 'stick') this.move(e);
  }

  private move(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    if (p.kind === 'stick') {
      const radius = this.stick.clientWidth * 0.36;
      const axes = stickAxes(e.clientX - p.x, e.clientY - p.y, radius);
      this.input.setTouchMove(axes.forward, axes.right);
      this.knob.style.transform = `translate(${axes.right * radius}px, ${-axes.forward * radius}px)`;
    } else if (p.kind === 'look') {
      this.input.state.dYaw -= (e.clientX - p.x) * 0.005;
      this.input.state.dPitch -= (e.clientY - p.y) * 0.005;
      p.x = e.clientX;
      p.y = e.clientY;
    }
  }

  private end(id: number): void {
    const p = this.pointers.get(id);
    if (!p) return;
    this.pointers.delete(id);
    p.element.classList.remove('is-held');
    if (p.code) this.input.setTouchKey(p.code, false);
    if (p.kind === 'stick') {
      this.input.setTouchMove(0, 0);
      this.knob.style.transform = '';
    }
    if (p.element.hasPointerCapture(id)) p.element.releasePointerCapture(id);
  }

  reset(): void {
    for (const id of this.pointers.keys()) this.end(id);
    this.input.reset();
  }

  dispose(): void {
    this.reset();
    for (const off of this.off) off();
    this.root.remove();
    document.body.classList.remove('touch-ui');
  }
}
