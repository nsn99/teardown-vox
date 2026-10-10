import { Body, EventBus, Mat, Simulation, Vec3, VoxelShape, solveBodyStructure, v3 } from '@tvox/core';

export interface HydroDef {
  critical: { volume: string; minIntegrity: number }[];
  water: { body: string; initial: number; final: number }[];
  bridge: { volume: string; scourBox: [number, number, number, number, number, number];
    deckCuts?: [number, number, number, number, number, number][]; failLevel: number };
  warningSeconds: number;
  floodSeconds: number;
}
export type HydroPhase = 'intact' | 'warning' | 'flooding' | 'stable';
export interface HydroState { phase: HydroPhase; elapsed: number; powered: boolean; bridgeCollapsed: boolean }
interface HydroEvents extends Record<string, unknown> {
  'hydro:failed': { volume: string };
  'hydro:flooding': { level: number };
  'hydro:bridge': { fragments: number };
  'hydro:stable': { level: number };
}

/** Scripted inflow from the upstream catchment, with shared finite water physics.
 * All clocks advance only through update(), never Date.now() or a browser timer. */
export class Hydropower {
  readonly events = new EventBus<HydroEvents>();
  phase: HydroPhase = 'intact';
  elapsed = 0;
  powered = true;
  bridgeCollapsed = false;
  private critical: { body: Body; shape: VoxelShape; initial: number; minimum: number }[];
  private waters: { body: Body; initialY: number; initial: number; final: number }[];
  private bridge: { body: Body; shape: VoxelShape };

  constructor(private sim: Simulation, readonly def: HydroDef) {
    const volumes = [...sim.world.bodies.values()].flatMap(body => body.shapes.map(shape => ({ body, shape })));
    this.critical = def.critical.map(c => {
      const volume = volumes.find(v => v.shape.name === c.volume);
      if (!volume) throw new Error(`ГЭС: нет объёма ${c.volume}`);
      return { ...volume, initial: volume.shape.solidVoxels, minimum: c.minIntegrity };
    });
    const bridge = volumes.find(v => v.shape.name === def.bridge.volume);
    if (!bridge) throw new Error(`ГЭС: нет моста ${def.bridge.volume}`);
    this.bridge = bridge;
    this.waters = def.water.map(w => {
      const body = [...sim.world.bodies.values()].find(b => b.name === w.body && b.tags.has('water'));
      if (!body) throw new Error(`ГЭС: нет воды ${w.body}`);
      return { body, initialY: body.transform.position.y, initial: w.initial, final: w.final };
    });
    sim.world.waterSurface = position => this.surfaceAt(position);
    sim.fire.setWaterSurface(sim.world.waterSurface);
  }

  get level(): number { return this.waters[0].initial + (this.waters[0].final - this.waters[0].initial) * this.progress; }
  get progress(): number {
    const t = Math.max(0, Math.min(1, (this.elapsed - this.def.warningSeconds) / this.def.floodSeconds));
    return t * t * (3 - 2 * t);
  }
  surfaceAt(position: Vec3): number | null {
    let surface: number | null = null;
    for (const w of this.waters) {
      if (w.body.destroyed) continue;
      for (const s of w.body.shapes) {
        const x = w.body.transform.position.x + s.transform.position.x;
        const z = w.body.transform.position.z + s.transform.position.z;
        if (position.x < x || position.x >= x + s.sx * s.voxelSize ||
            position.z < z || position.z >= z + s.sz * s.voxelSize) continue;
        const y = w.initial + (w.final - w.initial) * this.progress;
        surface = surface === null ? y : Math.max(surface, y);
      }
    }
    return surface;
  }

  snapshot(): HydroState { return { phase: this.phase, elapsed: this.elapsed, powered: this.powered, bridgeCollapsed: this.bridgeCollapsed }; }
  restore(state: HydroState): void {
    if (!['intact', 'warning', 'flooding', 'stable'].includes(state.phase) ||
        !Number.isFinite(state.elapsed) || state.elapsed < 0 ||
        typeof state.powered !== 'boolean' || typeof state.bridgeCollapsed !== 'boolean') throw new Error('Некорректное состояние ГЭС');
    this.phase = state.phase; this.elapsed = state.elapsed;
    this.powered = state.powered; this.bridgeCollapsed = state.bridgeCollapsed;
    this.moveWater();
  }

  update(dt: number): void {
    if (this.phase === 'intact') {
      const broken = this.critical.find(c => c.body.destroyed || !c.body.shapes.includes(c.shape) ||
        c.shape.solidVoxels < c.initial * c.minimum);
      if (!broken) return;
      this.powered = false; this.phase = 'warning';
      this.events.emit('hydro:failed', { volume: broken.shape.name });
    }
    if (this.phase === 'stable') return;
    this.elapsed = Math.min(this.def.warningSeconds + this.def.floodSeconds, this.elapsed + Math.max(0, dt));
    if (this.phase === 'warning' && this.elapsed >= this.def.warningSeconds) {
      this.phase = 'flooding'; this.events.emit('hydro:flooding', { level: this.level });
    }
    this.moveWater();
    if (!this.bridgeCollapsed && this.level >= this.def.bridge.failLevel) this.scourBridge();
    if (this.elapsed >= this.def.warningSeconds + this.def.floodSeconds) {
      this.phase = 'stable'; this.events.emit('hydro:stable', { level: this.level });
    }
  }

  private moveWater(): void {
    for (const w of this.waters) w.body.transform.position.y = w.initialY + (w.final - w.initial) * this.progress;
  }

  private scourBridge(): void {
    this.bridgeCollapsed = true;
    const { body, shape } = this.bridge;
    if (body.destroyed || !body.shapes.includes(shape)) return;
    const removed = new Map<number, number>();
    for (const [x0, y0, z0, x1, y1, z1] of [this.def.bridge.scourBox, ...(this.def.bridge.deckCuts ?? [])]) {
      for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
        const m = shape.get(x, y, z);
        if (m !== Mat.Air) { removed.set(m, (removed.get(m) ?? 0) + 1); shape.set(x, y, z, Mat.Air); }
      }
    }
    body.collidersDirty = true; body.collidersImmediate = true;
    const [x0, y0, z0, x1, y1, z1] = this.def.bridge.scourBox;
    this.sim.world.events.emit('voxels:removed', { body, shape, count: [...removed.values()].reduce((a, b) => a + b, 0),
      center: shape.voxelCenterWorld((x0 + x1 - 1) / 2, (y0 + y1 - 1) / 2, (z0 + z1 - 1) / 2, body.transform),
      materials: removed, cause: 'flood' });
    // Connectivity, not a cosmetic disappearance: the deck becomes real debris.
    const result = solveBodyStructure(body, { stress: false, incremental: false });
    for (const { body: fragment } of result.fragments) {
      fragment.velocity = v3(0.6, -0.3, -1.4); fragment.velocityDirty = true;
      this.sim.world.addBody(fragment); this.sim.physics.sync(fragment);
    }
    this.sim.physics.sync(body);
    this.sim.world.events.emit('body:split', { source: body, fragments: result.fragments.map(f => f.body), reason: 'disconnected' });
    this.events.emit('hydro:bridge', { fragments: result.fragments.length });
  }
}
