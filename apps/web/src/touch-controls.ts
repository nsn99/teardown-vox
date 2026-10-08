import { Input } from './input.js';
import { TOOLS, TOOL_IDS } from '@tvox/game';

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

export function touchLookDelta(dx: number, dy: number): { yaw: number; pitch: number } {
  return { yaw: -dx * 0.003, pitch: -dy * 0.003 };
}

export function stickSprint(mode: TouchMode | null, forward: number): boolean {
  return mode === 'foot' && forward > 0.9;
}

/** Each finger owns one gesture. Cancellation never leaves an action held. */
export class TouchControls {
  private root = document.createElement('div');
  private stick: HTMLElement;
  private knob: HTMLElement;
  private mode: TouchMode | null = null;
  private panel: string | null = null;
  private pointers = new Map<number, { element: HTMLElement; kind: 'stick' | 'look' | 'key'; code?: string; x: number; y: number }>();
  private off: Array<() => void> = [];

  constructor(private input: Input, canvas: HTMLCanvasElement) {
    this.root.id = 'touch-controls';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="touch-toolbar" aria-label="Настройки игры">
        <button data-code="Escape" aria-label="Пауза и меню">Ⅱ</button>
        <button data-panel="tools" class="touch-tool-picker" aria-expanded="false">Инструмент ▾</button>
        <button data-panel="settings" aria-label="Дополнительные действия и настройки" aria-expanded="false">•••</button>
      </div>
      <div class="touch-panel" data-drawer="tools" aria-label="Выбор инструмента" hidden>
        <button data-panel="tools" class="touch-panel-close">Закрыть ×</button>
        ${TOOL_IDS.map(id => `<button data-code="Digit${TOOLS[id].slot}" data-select-tool>${TOOLS[id].name}</button>`).join('')}
      </div>
      <div class="touch-panel" data-drawer="settings" aria-label="Дополнительные действия" hidden>
        <button data-panel="settings" class="touch-panel-close">Закрыть ×</button>
        <button data-code="KeyV">Камера</button><button data-code="KeyQ">Качество</button>
        <button data-code="KeyN">Свет</button><button data-code="KeyM">Звук</button>
        <button data-code="ControlLeft" data-extra data-held>Присесть</button>
        <button data-code="Mouse2" data-extra>Подрыв</button>
        <button data-code="KeyG" data-extra>Выгрузить</button>
        <button data-code="KeyU" data-extra>На колёса</button>
      </div>
      <div class="touch-stick" aria-label="Джойстик движения"><span></span><small>Движение</small></div>
      <div class="touch-speed" hidden><button data-code="BracketLeft" aria-label="Медленнее">−</button><span>Скорость</span><button data-code="BracketRight" aria-label="Быстрее">+</button></div>
      <div class="touch-lift" hidden><button data-code="KeyT">Ковш ↑</button><button data-code="KeyY">Ковш ↓</button></div>
      <div class="touch-actions" aria-label="Действия">
        <button data-code="KeyF">Сесть</button>
        <button data-code="KeyE">Взять</button>
        <button data-code="Mouse0" class="touch-primary">Удар</button>
        <button data-code="Space">Прыжок</button>
        <button data-code="ControlLeft" data-main-brake hidden>Тормоз</button>
      </div>
      <div class="touch-look-tip">Левый палец — движение · правый — обзор и действие</div>`;
    document.body.append(this.root);
    document.body.classList.add('touch-ui');
    this.stick = this.root.querySelector('.touch-stick')!;
    this.knob = this.stick.querySelector('span')!;
    const listen = (el: EventTarget, type: string, fn: (e: Event) => void) => {
      el.addEventListener(type, fn);
      this.off.push(() => el.removeEventListener(type, fn));
    };
    listen(this.root, 'pointerdown', e => this.begin(e as PointerEvent));
    listen(this.root, 'click', e => {
      const button = (e.target as HTMLElement).closest<HTMLElement>('button');
      if (!button || this.root.hidden || !this.input.active) return;
      if (button.dataset.panel) {
        const next = this.panel === button.dataset.panel ? null : button.dataset.panel;
        this.reset();
        this.closePanel();
        if (next) {
          this.panel = next;
          this.root.querySelector<HTMLElement>(`[data-drawer="${next}"]`)!.hidden = false;
          this.root.querySelector<HTMLElement>(`.touch-toolbar [data-panel="${next}"]`)!.setAttribute('aria-expanded', 'true');
        }
      } else if (button.closest('.touch-panel') && !button.hasAttribute('data-held') && button.dataset.code) {
        this.input.state.pressed.add(button.dataset.code);
        if (button.hasAttribute('data-select-tool')) this.closePanel();
      }
    });
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
    this.closePanel();
    this.root.hidden = !visible;
  }

  setMode(mode: TouchMode): void {
    if (this.mode === mode) return;
    this.reset();
    this.mode = mode;
    this.closePanel();
    this.root.dataset.mode = mode;
    const foot = mode === 'foot';
    const crane = mode === 'crane';
    const set = (code: string, label: string, visible = true) => {
      const button = this.root.querySelector<HTMLButtonElement>(`[data-code="${code}"]:not([data-main-brake])`)!;
      button.textContent = label;
      button.hidden = !visible;
    };
    set('KeyF', foot ? 'Сесть' : 'Выйти');
    set('KeyE', crane ? 'Зацепить' : mode === 'truck' ? 'Закрепить' : 'Взять');
    set('Mouse0', 'Действие', foot);
    set('Mouse2', 'Подрыв', foot);
    set('Space', crane ? 'Крюк ↑' : 'Прыжок', foot || crane);
    set('ControlLeft', 'Присесть', foot);
    const brake = this.root.querySelector<HTMLButtonElement>('[data-main-brake]')!;
    brake.hidden = foot;
    brake.textContent = crane ? 'Крюк ↓' : 'Тормоз';
    set('KeyG', 'Выгрузить', mode === 'truck');
    set('KeyU', 'На колёса', !foot && !crane && mode !== 'boat');
    this.root.querySelector<HTMLElement>('.touch-tool-picker')!.hidden = !foot;
    this.root.querySelector<HTMLElement>('.touch-speed')!.hidden = foot || crane;
    this.root.querySelector<HTMLElement>('.touch-lift')!.hidden = mode !== 'blade';
    this.stick.querySelector('small')!.textContent = crane ? 'Поворот / стрела' : foot ? 'Движение' : 'Руль / газ';
  }

  setTool(name: string): void {
    const button = this.root.querySelector<HTMLElement>('.touch-tool-picker')!;
    const label = `${name} ▾`;
    if (button.textContent !== label) button.textContent = label;
  }

  setCarrying(holding: boolean): void {
    if (this.mode !== 'foot') return;
    this.root.querySelector<HTMLElement>('.touch-actions [data-code="KeyE"]')!.textContent = holding ? 'Положить' : 'Взять';
    this.root.querySelector<HTMLButtonElement>('.touch-primary')!.hidden = holding;
  }

  setSpeed(kmh: number, limit: number): void {
    const label = this.root.querySelector<HTMLElement>('.touch-speed span')!;
    label.textContent = `${kmh.toFixed(0)} км/ч · ${Math.round(limit * 100)}%`;
  }

  private closePanel(): void {
    this.panel = null;
    for (const drawer of this.root.querySelectorAll<HTMLElement>('[data-drawer]')) drawer.hidden = true;
    for (const button of this.root.querySelectorAll<HTMLElement>('[data-panel]')) button.setAttribute('aria-expanded', 'false');
  }

  private begin(e: PointerEvent, canvas?: HTMLCanvasElement): void {
    if (this.root.hidden || !this.input.active || e.pointerType === 'mouse') return;
    const target = canvas ?? (e.target as HTMLElement).closest<HTMLElement>('button, .touch-stick');
    if (!target) return;
    // Lists use native taps/scrolling. Firing and driving still act on pointerdown.
    if (target.dataset.panel || (target.closest('.touch-panel') && !target.hasAttribute('data-held'))) return;
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
      this.input.setTouchKey('ShiftLeft', stickSprint(this.mode, axes.forward));
      this.knob.style.transform = `translate(${axes.right * radius}px, ${-axes.forward * radius}px)`;
    } else if (p.kind === 'look' || p.code === 'Mouse0') {
      const look = touchLookDelta(e.clientX - p.x, e.clientY - p.y);
      this.input.state.dYaw += look.yaw;
      this.input.state.dPitch += look.pitch;
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
      this.input.setTouchKey('ShiftLeft', false);
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
