import { Heist, TOOLS, TOOL_IDS, ToolId } from '@tvox/game';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Нет элемента #${id}`);
  return el as T;
};

const money = (n: number): string => `${Math.round(n).toLocaleString('ru-RU')} ₽`;

/** Интерфейс во время миссии: таймер, цели, инструмент, подсказки. */
export class Hud {
  private root = $('hud');
  private alarm = $('alarm');
  private alarmTime = $('alarm-time');
  private targets = $<HTMLUListElement>('targets');
  private toolName = $('tool-name');
  private toolTier = $('tool-tier');
  private toolAmmo = $('tool-ammo');
  private belt = $<HTMLUListElement>('belt');
  private chase = $('chase');
  private chaseFill = $('chase-fill');
  private hint = $('hint');
  private stats = $('stats');
  private hintTimer = 0;

  constructor() {
    this.belt.innerHTML = TOOL_IDS.map(
      (id) => `<li data-tool="${id}">${TOOLS[id].slot}</li>`,
    ).join('');
  }

  show(): void {
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  message(text: string, seconds = 2.2): void {
    this.hint.textContent = text;
    this.hint.classList.add('is-on');
    this.hintTimer = seconds;
  }

  update(heist: Heist, dt: number, extra: string): void {
    const m = heist.mission;

    const alarmOn = m.alarmActive;
    this.alarm.classList.toggle('alarm--on', alarmOn);
    if (alarmOn) {
      const left = m.timeLeft;
      this.alarmTime.textContent = left.toFixed(1);
      this.alarm.classList.toggle('alarm--critical', left <= 10);
    }

    // Погоня: полоса растёт по мере приближения. Точных метров игроку не
    // нужно — нужно понимать, успевает он или уже нет.
    const near = heist.pursuit.proximity(heist.eye);
    this.chase.hidden = near <= 0.01;
    if (!this.chase.hidden) {
      this.chaseFill.style.width = `${Math.round(near * 100)}%`;
      this.chase.classList.toggle('alarm--critical', near > 0.75);
    }

    // Список целей: обязательные сверху, вынесенные зачёркнуты.
    const rows = [...m.targets.values()]
      .sort((a, b) => Number(b.spec.required) - Number(a.spec.required))
      .map((t) => {
        const cls = [
          t.spec.required ? 'is-required' : '',
          t.state === 'delivered' ? 'is-done' : '',
          t.state === 'carried' ? 'is-carried' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return `<li class="${cls}"><span>${t.spec.name}</span><span>${money(t.spec.value)}</span></li>`;
      })
      .join('');
    if (this.targets.innerHTML !== rows) this.targets.innerHTML = rows;

    const active = heist.inventory.active;
    const def = TOOLS[active];
    const tier = heist.inventory.tier(active);
    this.toolName.textContent = def.name;
    this.toolTier.textContent = tier > 0 ? `ур. ${tier + 1}` : '';
    const ammo = heist.inventory.ammo(active);
    this.toolAmmo.textContent = Number.isFinite(ammo) ? String(Math.round(ammo)) : '∞';

    for (const li of Array.from(this.belt.children) as HTMLElement[]) {
      const id = li.dataset.tool as ToolId;
      li.classList.toggle('is-active', id === active);
      li.classList.toggle('is-empty', !heist.inventory.canUse(id));
    }

    this.stats.textContent = extra;

    if (this.hintTimer > 0) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0) this.hint.classList.remove('is-on');
    }
  }
}

export interface MenuHandlers {
  onMission(): void;
  onSandbox(): void;
  onUpgrade(tool: ToolId): void;
}

/** Хаб: брифинг, деньги, магазин ступеней. */
export class Menu {
  private root = $('menu');
  private brief = $('menu-brief');
  private moneyEl = $('menu-money');
  private shop = $('shop');

  constructor(private handlers: MenuHandlers) {
    $('btn-mission').addEventListener('click', () => handlers.onMission());
    $('btn-sandbox').addEventListener('click', () => handlers.onSandbox());
    this.shop.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-tool]');
      if (!btn) return;
      handlers.onUpgrade((btn as HTMLElement).dataset.tool as ToolId);
    });
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  show(): void {
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  render(profile: { money: number; tier(id: ToolId): number; nextUpgradeCost(id: ToolId): number | null }, brief: string): void {
    this.brief.textContent = brief;
    this.moneyEl.textContent = money(profile.money);
    this.shop.innerHTML = TOOL_IDS.map((id) => {
      const def = TOOLS[id];
      const tier = profile.tier(id);
      const cost = profile.nextUpgradeCost(id);
      const label = cost === null ? 'максимум' : money(cost);
      const disabled = cost === null || profile.money < cost ? 'disabled' : '';
      return `
        <div class="shop__item">
          <span>${def.name}</span>
          <span class="shop__tier">ур. ${tier + 1}/4</span>
          <button class="btn" data-tool="${id}" ${disabled}>${label}</button>
          <span class="shop__desc">${def.description}</span>
        </div>`;
    }).join('');
  }
}

export interface ResultHandlers {
  onAgain(): void;
  onHub(): void;
}

/** Экран итога захода. */
export class ResultScreen {
  private root = $('result');
  private title = $('result-title');
  private text = $('result-text');

  constructor(handlers: ResultHandlers) {
    $('btn-again').addEventListener('click', () => handlers.onAgain());
    $('btn-hub').addEventListener('click', () => handlers.onHub());
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  hide(): void {
    this.root.hidden = true;
  }

  show(success: boolean, lines: string[]): void {
    this.title.textContent = success ? 'Ушли' : 'Провал';
    this.text.textContent = lines.join('\n');
    this.root.hidden = false;
  }
}

export { money };
