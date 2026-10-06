import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Aabb, Body, Mat, RapierPhysics, Simulation, VoxelShape, v3 } from '@tvox/core';
import { AutomaticGate, DEFAULT_INPUT, Heist, NEUTRAL_INPUT, Vehicle, VehicleKind, buildPlank, portLevel } from '@tvox/game';
import { overlapsSolid } from '../src/character.js';

const DT = 1 / 60;
const visitor = (z: number): Aabb => ({ min: v3(-0.4, 0.1, z - 0.4), max: v3(0.4, 1.8, z + 0.4) });

function fixture(): { sim: Simulation; gate: AutomaticGate; support: VoxelShape } {
  const sim = new Simulation();
  const floor = new VoxelShape({ sx: 60, sy: 4, sz: 100, voxelSize: 0.1 });
  floor.structural = false;
  floor.fill({}, Mat.Foundation);
  floor.transform.position = v3(-3, -0.4, -5);
  const support = new VoxelShape({ sx: 2, sy: 2, sz: 2, voxelSize: 0.1, name: 'housing' });
  support.structural = false;
  support.fill({}, Mat.HeavyMetal);
  support.transform.position = v3(0, 8.2, 0);
  sim.world.addBody(new Body({ kind: 'static', shapes: [floor, support] }));
  const panel = new VoxelShape({ sx: 40, sy: 40, sz: 3, voxelSize: 0.1 });
  panel.structural = false;
  panel.fill({}, Mat.Metal);
  panel.transform.position = v3(-2, 0, -0.15);
  sim.world.addBody(new Body({ name: 'gate', kind: 'dynamic', kinematic: true, shapes: [panel] }));
  const gate = new AutomaticGate(sim, {
    id: 'gate', body: 'gate', rise: 4.1, speed: 4, approachRadius: 8, closeDelay: 2,
    support: { volume: 'housing', voxel: v3() },
  });
  return { sim, gate, support };
}

function tick(gate: AutomaticGate, box: Aabb, seconds: number): void {
  for (let i = 0; i < Math.ceil(seconds / DT); i++) gate.update(box, DT);
}

describe('подъёмные ворота', () => {
  it.each([-6, 6])('открываются при приближении с z=%s и закрываются с задержкой', z => {
    const { sim, gate } = fixture();
    try {
      expect(sim.world.raycast(v3(0, 1, -2), v3(0, 0, 1), { maxDistance: 4 })?.body).toBe(gate.body);
      tick(gate, visitor(z), 1.1);
      expect(gate.opening).toBe(1);
      expect(sim.world.raycast(v3(0, 1, -2), v3(0, 0, 1), { maxDistance: 4 })).toBeNull();
      tick(gate, visitor(30), 1.5);
      expect(gate.opening).toBe(1);
      tick(gate, visitor(30), 2);
      expect(gate.opening).toBe(0);
    } finally { sim.dispose(); }
  });

  it('не закрываются на оставленную в проёме машину', () => {
    const { sim, gate } = fixture();
    // Машина въезжает через уже открытые ворота, а не появляется внутри закрытой створки.
    tick(gate, visitor(-6), 1.1);
    const shape = new VoxelShape({ sx: 10, sy: 10, sz: 30, voxelSize: 0.1 });
    shape.fill({}, Mat.Metal);
    const parked = sim.world.addBody(new Body({ kind: 'dynamic', kinematic: true, shapes: [shape],
      transform: { position: v3(-0.5, 0.1, -1.5), rotation: { x: 0, y: 0, z: 0, w: 1 } } }));
    try {
      tick(gate, visitor(30), 5);
      expect(gate.opening).toBe(1);
      sim.world.removeBody(parked);
      tick(gate, visitor(30), 4);
      expect(gate.opening).toBe(0);
    } finally { sim.dispose(); }
  });

  it.each([0, 0.4])('упираются в поперечную доску при закрытии и отходят назад, уклон=%s', slope => {
    const { sim, gate } = fixture();
    try {
      tick(gate, visitor(-6), 1.1);
      const plank = buildPlank(sim.world, v3(-1.9, 1.5, 0), v3(1.9, 1.5 + slope, 0))!;
      const intact = plank.solidVoxels;
      const plankTop = plank.aabb().max.y;
      let contact = 0;
      let previous = gate.body.transform.position.y;
      for (let i = 0; i < 300; i++) {
        gate.update(visitor(30), DT);
        const height = gate.body.transform.position.y;
        expect(height).toBeGreaterThanOrEqual(plankTop - 0.001);
        if (height < previous && height - plankTop < 0.02) { contact = height; break; }
        previous = height;
      }
      expect(contact).toBeGreaterThan(0);
      tick(gate, visitor(30), 0.2);
      expect(gate.body.transform.position.y).toBeGreaterThan(contact + 0.1);
      tick(gate, visitor(30), 5);
      expect(gate.body.transform.position.y).toBeGreaterThanOrEqual(plankTop - 0.001);
      expect(plank.solidVoxels).toBe(intact);
      // Убираем воксели, сохраняя пустое тело: оно больше не мешает механизму.
      plank.shapes[0].fill({}, Mat.Air);
      tick(gate, visitor(30), 5);
      expect(gate.opening).toBe(0);
    } finally { sim.dispose(); }
  });

  it.each(['static', 'dynamic'] as const)('не проходят сквозь %s доску при открытии', kind => {
    const { sim, gate } = fixture();
    try {
      const plank = buildPlank(sim.world, v3(-2.2, 5, 0), v3(2.2, 5, 0))!;
      plank.kind = kind;
      plank.kinematic = kind === 'dynamic';
      const intact = sim.world.totalSolidVoxels();
      tick(gate, visitor(-6), 5);
      expect(gate.body.aabb().max.y).toBeLessThanOrEqual(plank.aabb().min.y + 0.001);
      expect(gate.opening).toBeGreaterThan(0);
      expect(sim.world.totalSolidVoxels()).toBe(intact);
      sim.world.removeBody(plank);
      tick(gate, visitor(-6), 5);
      expect(gate.opening).toBe(1);
    } finally { sim.dispose(); }
  });

  it('проверяют весь путь: большой шаг не перескакивает через тонкую доску', () => {
    const { sim, gate } = fixture();
    try {
      const plank = buildPlank(sim.world, v3(-2.2, 4.05, 0), v3(2.2, 4.05, 0), 4, 1, 0.01)!;
      gate.update(visitor(-6), 2);
      expect(gate.body.aabb().max.y).toBeLessThanOrEqual(plank.aabb().min.y + 0.001);
      expect(gate.opening).toBeLessThan(0.02);
    } finally { sim.dispose(); }
  });

  it('не протаскивают створку через доску, поставленную внутри её текущего положения', () => {
    const { sim, gate } = fixture();
    try {
      const plank = buildPlank(sim.world, v3(-1.9, 1.5, 0), v3(1.9, 1.5, 0))!;
      tick(gate, visitor(-6), 5);
      expect(gate.opening).toBe(0);
      sim.world.removeBody(plank);
      tick(gate, visitor(-6), 5);
      expect(gate.opening).toBe(1);
    } finally { sim.dispose(); }
  });

  it('учитывают выбитый проём в самой створке', () => {
    const { sim, gate } = fixture();
    try {
      tick(gate, visitor(-6), 1.1);
      const panel = gate.body.shapes[0];
      panel.fill({ x0: 10, x1: 30 }, Mat.Air);
      buildPlank(sim.world, v3(-0.4, 1.5, 0), v3(0.4, 1.5, 0));
      tick(gate, visitor(30), 5);
      expect(gate.opening).toBe(0);
    } finally { sim.dispose(); }
  });

  it('не упираются в воду или пассивный объект на пути створки', () => {
    const { sim, gate } = fixture();
    try {
      const water = buildPlank(sim.world, v3(-1.9, 5, 0), v3(1.9, 5, 0))!;
      water.shapes[0].fill({}, Mat.Water);
      const decorative = buildPlank(sim.world, v3(-1.9, 6, 0), v3(1.9, 6, 0))!;
      decorative.passive = true;
      tick(gate, visitor(-6), 1.1);
      expect(gate.opening).toBe(1);
      tick(gate, visitor(30), 4);
      expect(gate.opening).toBe(0);
    } finally { sim.dispose(); }
  });

  it('в Rapier останавливаются перед доской, не проталкивая её и не повреждая крепление', async () => {
    const { sim, gate } = fixture();
    sim.setPhysics(await RapierPhysics.create(sim.world));
    try {
      for (let i = 0; i < 70; i++) { gate.update(visitor(-6), DT); sim.physics.step(DT); }
      const plank = buildPlank(sim.world, v3(-1.9, 1.5, 0), v3(1.9, 1.5, 0))!;
      const position = { ...plank.transform.position };
      const intact = sim.world.totalSolidVoxels();
      for (let i = 0; i < 360; i++) {
        gate.update(visitor(30), DT);
        sim.physics.step(DT);
        expect(gate.body.aabb().min.y).toBeGreaterThanOrEqual(plank.aabb().max.y - 0.001);
      }
      expect(plank.transform.position).toEqual(position);
      expect(sim.world.totalSolidVoxels()).toBe(intact);
    } finally { sim.dispose(); }
  });

  it('после разрушения крепления открытая створка падает в Rapier', async () => {
    const { sim, gate, support } = fixture();
    sim.setPhysics(await RapierPhysics.create(sim.world));
    try {
      for (let i = 0; i < 70; i++) { gate.update(visitor(-6), DT); sim.physics.step(DT); }
      const raised = gate.body.transform.position.y;
      expect(raised).toBeCloseTo(4.1);
      support.set(0, 0, 0, Mat.Air);
      gate.update(visitor(-6), DT);
      expect(gate.body.kinematic).toBe(false);
      expect(gate.body.tags.has('debris')).toBe(true);
      for (let i = 0; i < 30; i++) sim.physics.step(DT);
      expect(gate.body.transform.position.y).toBeLessThan(raised - 0.5);
    } finally { sim.dispose(); }
  });

  it.each([false, true])('коллайдер Rapier пропускает груз только при открытии=%s', async open => {
    const { sim, gate } = fixture();
    sim.world.gravity = v3();
    sim.setPhysics(await RapierPhysics.create(sim.world));
    const shape = new VoxelShape({ sx: 4, sy: 4, sz: 4, voxelSize: 0.1 });
    shape.fill({}, Mat.Wood);
    const cargo = sim.world.addBody(new Body({ kind: 'dynamic', shapes: [shape],
      transform: { position: v3(-0.2, 1, -1.5), rotation: { x: 0, y: 0, z: 0, w: 1 } } }));
    try {
      if (open) tick(gate, visitor(-6), 1.1);
      sim.physics.step(DT);
      sim.physics.applyImpulse(cargo, v3(0, 0, cargo.mass() * 3));
      for (let i = 0; i < 90; i++) sim.physics.step(DT);
      if (open) expect(cargo.transform.position.z).toBeGreaterThan(1);
      else expect(cargo.transform.position.z).toBeLessThan(0);
    } finally { sim.dispose(); }
  });
});

describe('проезд в склад порта', () => {
  let h: Heist;
  beforeAll(() => {
    h = new Heist({ level: { ...portLevel, vehicles: [] }, sandbox: true });
    h.start();
  }, 60_000);
  afterEach(() => {
    for (const vehicle of h.vehicles.values()) h.sim.world.removeBody(vehicle.body);
    h.vehicles.clear();
    h.drivingId = null;
    h.character.teleport(portLevel.spawn.position);
  });
  afterAll(() => h.sim.dispose());
  it.each<VehicleKind>(['car', 'pickup', 'bulldozer', 'excavator'])('%s въезжает и выезжает целым корпусом без тарана', kind => {
    const vehicle = new Vehicle(kind, { position: v3(16, 0.1, 10.5), yaw: Math.PI, waterLevel: portLevel.waterLevel });
    vehicle.spawn(h.sim);
    h.vehicles.set('driver', vehicle);
    h.drivingId = 'driver';
    const before = h.sim.world.totalSolidVoxels();
    const intact = vehicle.body.solidVoxels;
    const checkClear = () => {
      vehicle.body.destroyed = true;
      try {
        expect(overlapsSolid(h.sim.world, vehicle.body.aabb()), `препятствие при z=${vehicle.position.z}`).toBe(false);
        const box = vehicle.body.aabb();
        for (const x of [box.min.x, box.max.x]) for (const z of [box.min.z, box.max.z]) {
          const floor = h.sim.world.raycast(v3(x, 0.05, z), v3(0, -1, 0), { maxDistance: 1 });
          expect(floor, `опора (${x}, ${z})`).not.toBeNull();
          expect(floor!.point.y).toBeCloseTo(0, 5);
        }
      } finally { vehicle.body.destroyed = false; }
    };
    try {
      for (let i = 0; i < 70; i++) h.update(DT);
      expect(h.gates[0].opening).toBe(1);
      for (let i = 0; i < 800 && vehicle.position.z < 20; i++) {
        h.update(DT, DEFAULT_INPUT, { ...NEUTRAL_INPUT, throttle: 0.2 });
        if (i % 30 === 0) checkClear();
      }
      expect(vehicle.position.z).toBeGreaterThan(20);
      checkClear();
      vehicle.yaw = 0;
      vehicle.speed = 0;
      for (let i = 0; i < 800 && vehicle.position.z > 10; i++) {
        h.update(DT, DEFAULT_INPUT, { ...NEUTRAL_INPUT, throttle: 0.2 });
        if (i % 30 === 0) checkClear();
      }
      expect(vehicle.position.z).toBeLessThan(10);
      checkClear();
      expect(vehicle.body.solidVoxels).toBe(intact);
      expect(h.sim.world.totalSolidVoxels()).toBe(before);
    } finally { vehicle.body.destroyed = false; }
  }, 60_000);

  it('на настоящей карте порта доска поперёк рамы удерживает створку', () => {
    const gate = h.gates[0];
    const near = { min: v3(15.5, 0.1, 10), max: v3(16.5, 1.8, 11) };
    const far = { min: v3(-30, 0.1, -30), max: v3(-29, 1.8, -29) };
    tick(gate, near, 1.1);
    expect(gate.opening).toBe(1);
    const plank = buildPlank(h.sim.world, v3(13.9, 1.5, 13.75), v3(18.1, 1.5, 13.75))!;
    try {
      for (let i = 0; i < 360; i++) {
        gate.update(far, DT);
        expect(gate.body.aabb().min.y).toBeGreaterThanOrEqual(plank.aabb().max.y - 0.001);
      }
      expect(gate.opening).toBeLessThan(1);
      h.sim.world.removeBody(plank);
      tick(gate, far, 5);
      expect(gate.opening).toBe(0);
    } finally { h.sim.world.removeBody(plank); }
  }, 60_000);
});
