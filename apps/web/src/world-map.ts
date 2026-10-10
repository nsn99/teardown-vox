import { Heist, RING_ROAD, TUNNEL_BRANCH } from '@tvox/game';

/** Exact plan view in metres, rotated so the original port is on the right. */
export class WorldMap {
  private root = document.createElement('section');
  constructor(private onClose: () => void) {
    this.root.className = 'world-map'; this.root.hidden = true;
    this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-label', 'Схема карты');
    const line = (points: typeof RING_ROAD) => points.map(p => `${p.z},${-p.x}`).join(' ');
    this.root.innerHTML = `<div class="world-map__panel">
      <div class="world-map__header"><div><small>ПОРТ И ОКРЕСТНОСТИ</small><h2>Озеро и ГЭС</h2></div><button class="btn" data-close>Закрыть · B</button></div>
      <svg viewBox="-266 -230 374 378" role="img" aria-label="Кольцевая дорога вокруг озера; тоннель ответвляется в гору; ГЭС и служебный мост сбоку от дороги">
        <rect x="-266" y="-230" width="374" height="378" rx="10" fill="#26382f"/>
        <g fill="#607060"><path d="M-254 16 L-254 -110 L-208 -119 L-183 -90 L-183 16 Z"/><path d="M-224 -211 L-136 -219 L-92 -190 L-155 -195 Z"/><path d="M-155 105 L-100 139 L-53 100 Z"/></g>
        <rect x="-158" y="-168" width="168" height="256" fill="#4e859a" rx="5"/>
        <rect data-flood x="10" y="-168" width="64" height="256" fill="#83c0ce" opacity="0"/>
        <polyline points="${line(RING_ROAD)}" fill="none" stroke="#9ca49c" stroke-width="10" stroke-linejoin="round"/>
        <polyline points="${line(RING_ROAD)}" fill="none" stroke="#e9deac" stroke-width="0.7" stroke-dasharray="5 4"/>
        <polyline points="64,-45 85,-45" fill="none" stroke="#c3c8b9" stroke-width="7"/>
        <rect x="0" y="-76" width="64" height="76" fill="#a19d87" rx="2"/>
        <rect x="14" y="-26" width="16" height="20" fill="#74695d"/><rect x="14" y="-40" width="10" height="10" fill="#c4bc9d"/>
        <rect x="42" y="-74" width="20" height="24" fill="#737d76"/>
        <rect x="-12" y="-76" width="22" height="56" fill="#aaa58f"/><circle cx="-6" cy="-32" r="3" fill="#e7d080"/>
        <rect x="-158" y="-108" width="21" height="12" fill="#c99f73"/>
        <path d="M-169 -102 L-158 -102" stroke="#c3c8b9" stroke-width="7"/>
        <circle cx="-145" cy="-112" r="3" fill="#f3deb0"/>
        <rect x="10" y="48" width="48" height="12" fill="#4e859a"/>
        <rect x="58" y="40" width="16" height="32" fill="#608eac"/>
        <rect x="54" y="48" width="4" height="12" fill="#d2cfb9"/>
        <rect x="44" y="28" width="14" height="16" fill="#b4aa8d"/>
        <path d="M85 82 L38 82 L38 36 L44 36" stroke="#c3c8b9" stroke-width="5" fill="none"/>
        <path data-bridge d="M38 64 L38 44" stroke="#dfc19d" stroke-width="6"/>
        <polyline points="${line(TUNNEL_BRANCH)}" stroke="#d2ccba" stroke-width="8" fill="none"/>
        <path d="M-186 -46 L-240 -46 M-186 -34 L-240 -34" stroke="#28332b" stroke-width="2"/>
        <g fill="#e3eadc" font-size="8" font-family="system-ui,sans-serif">
          <text x="-95" y="-40" text-anchor="middle" font-size="13">ОЗЕРО</text>
          <text x="32" y="-83" text-anchor="middle">ПОРТ</text><text x="34" y="12" text-anchor="middle">Склад · офис · гараж</text>
          <text x="-153" y="-123">ДАЛЬНИЙ ПРИЧАЛ</text><text x="48" y="24">ГЭС</text>
          <text x="84" y="107" text-anchor="end">Служебный мост</text><text x="-244" y="-61">ГОРНЫЙ ТОННЕЛЬ</text>
          <text x="-253" y="-14">Будущий переход</text><text x="-90" y="-190">Кольцевая дорога</text>
        </g>
        <circle data-player cx="33" cy="-45" r="3.5" fill="#fff7b5" stroke="#161d18" stroke-width="1.5"/>
      </svg>
      <p data-status></p><p class="world-map__note">Кольцевая дорога выше паводка. При аварии ГЭС затопляется низкий берег и разрушается только служебный мост. Тоннель — отдельная ветка к будущей карте.</p>
    </div>`;
    this.root.querySelector('[data-close]')!.addEventListener('click', () => this.close());
    document.body.append(this.root);
  }
  get visible(): boolean { return !this.root.hidden; }
  show(h: Heist | null): void {
    this.root.hidden = false;
    const p = h?.playerPosition;
    const marker = this.root.querySelector('[data-player]')!;
    marker.setAttribute('visibility', !h || h.level.id === 'port-expanded' ? 'visible' : 'hidden');
    if (p) { marker.setAttribute('cx', String(p.z)); marker.setAttribute('cy', String(-p.x)); }
    const hydro = h?.level.id === 'port-expanded' ? h.hydro : null;
    this.root.querySelector('[data-flood]')!.setAttribute('opacity', String((hydro?.progress ?? 0) * 0.7));
    this.root.querySelector('[data-bridge]')!.setAttribute('stroke', hydro?.bridgeCollapsed ? '#af5444' : '#dfc19d');
    this.root.querySelector('[data-status]')!.textContent = hydro ?
      `Вода ${hydro.level.toFixed(1)} м · ${hydro.powered ? 'ГЭС работает' : 'Питание отключено'} · ${hydro.bridgeCollapsed ? 'Мост разрушен' : 'Мост цел'}` : 'Схема расширенной карты · масштаб в игровых метрах';
  }
  close(): void { this.root.hidden = true; this.onClose(); }
}
