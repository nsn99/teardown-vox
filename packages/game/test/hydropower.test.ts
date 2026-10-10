import { afterEach, describe, expect, it } from 'vitest';
import { Body, Mat, RapierPhysics, VoxelShape, carve, v3 } from '@tvox/core';
import { Heist, NEUTRAL_INPUT, RING_ROAD, SessionCheckpoint, cameraUnderwater, expandedPortLevel, portLevel } from '@tvox/game';
import { slideGate } from './helpers/manual-gate.js';

const scenes: Heist[] = [];
function scene(sandbox = true) { const h = new Heist({ level: expandedPortLevel, sandbox }); h.start(); scenes.push(h); return h; }
afterEach(() => { for (const h of scenes.splice(0)) h.sim.dispose(); });
function breach(h: Heist): void {
  const result = carve(h.sim.world, { kind: 'sphere', center: v3(-37, 3.9, 51), radius: 4 },
    { power: 1.4, damage: 0, instant: true, falloff: 'none' });
  expect(result.removed).toBeGreaterThan(0); h.update(0);
}

describe('ГЭС, электропитание и реальный паводок', () => {
  it('машина едет по сухой дороге без питания ГЭС, вода глушит низкую технику, ворота и сигнализация сохраняют работу', () => {
    const h = scene(false); h.mission.triggerAlarm('test'); breach(h); h.hydro!.update(98);
    const vehicle = h.vehicles.get('van')!;
    vehicle.position = v3(179, 2.42, -30); vehicle.yaw = 0;
    for (let i = 0; i < 120; i++) vehicle.update(h.sim, { ...NEUTRAL_INPUT, throttle: 1 }, 1 / 60);
    expect(vehicle.position.z).toBeLessThan(-33); expect(vehicle.wrecked).toBe(false);
    const low = h.vehicles.get('car')!;
    for (let i = 0; i < 120; i++) low.update(h.sim, NEUTRAL_INPUT, 1 / 60);
    expect(low.wrecked).toBe(true);
    slideGate(h.gates[0], h.gates[0].def.rise);
    expect(h.gates[0].opening).toBeGreaterThan(.8);
    const remaining = h.mission.timeLeft; h.update(.1);
    expect(h.mission.timeLeft).toBeLessThan(remaining); expect(h.mission.alarmActive).toBe(true);
    h.pursuit.reset(h.sim);
    h.pursuit.update(h.sim, .1, { alarmActive: true, timeLeft: 10, finished: false }, v3(179, 2.4, -30));
    expect(h.pursuit.chasers.find(c => c.spec.kind === 'boat')!.active).toBe(false);
    h.pursuit.update(h.sim, .1, { alarmActive: true, timeLeft: 10, finished: false }, v3(60, 1.4, -30));
    const patrol = h.pursuit.chasers.find(c => c.spec.kind === 'boat')!;
    expect(patrol.active).toBe(true); expect(patrol.position.y).toBeCloseTo(1.4);
  }, 30_000);

  it('центральный пролёт падает в канал в Rapier, образуя реальный разрыв дороги', async () => {
    const h = scene(); h.sim.setPhysics(await RapierPhysics.create(h.sim.world));
    breach(h); h.hydro!.update(98);
    const spans = h.sim.world.dynamicBodies.filter(b => b.shapes.some(s => s.name.startsWith('hydro-service-bridge:frag')));
    expect(spans.length).toBeGreaterThanOrEqual(3);
    const center = spans.find(b => b.aabb().min.x > -60 && b.aabb().max.x < -48)!;
    expect(center).toBeDefined(); const initial = center.aabb().min.y;
    for (let i = 0; i < 60; i++) h.sim.step(1 / 60);
    expect(center.aabb().min.y).toBeLessThan(initial - .5);
    const road = h.sim.world.raycast(v3(-54, 1.5, 38), v3(0, -1, 0), { maxDistance: 1, filter: m => m !== Mat.Water });
    expect(road).toBeNull();
  }, 30_000);

  it('потеря рабочего узла отключает мотор крана; тормоз, выход и ручные ворота работают', () => {
    const h = scene(); const c = h.cranes.get('port-crane')!;
    h.character.teleport(c.exit); expect(h.toggleCrane()).toBe('port-crane');
    breach(h); expect(h.hydro!.phase).toBe('warning'); expect(h.hydro!.powered).toBe(false);
    const pose = c.snapshot();
    h.update(.1, undefined, undefined, { slew: 1, luff: 1, hoist: 1 });
    expect(c.yaw).toBe(pose.yaw); expect(c.angle).toBe(pose.angle); expect(c.ropeLength).toBe(pose.ropeLength);
    expect(c.operable).toBe(true); h.toggleCrane(); expect(h.operating).toBeNull();
    expect(h.gates.every(g => g.def.manual)).toBe(true);
    expect(h.hydro!.level).toBeCloseTo(-.4);
  }, 30_000);

  it('поднимает катер, затапливает берег, тушит огонь и физически отделяет мост, сохраняя дорогу', () => {
    const h = scene(); const boat = h.vehicles.get('boat')!;
    const wood = new VoxelShape({ sx: 2, sy: 2, sz: 2, voxelSize: .1 }); wood.fill({}, Mat.Wood);
    const fire = h.sim.world.addBody(new Body({ kind: 'static', shapes: [wood],
      transform: { position: v3(82, .4, 20), rotation: { x: 0, y: 0, z: 0, w: 1 } } }));
    expect(h.sim.fire.ignite(fire, wood, 0)).toBe(true);
    let fragments = 0; h.hydro!.events.on('hydro:bridge', e => { fragments = e.fragments; });
    breach(h); h.hydro!.update(98); boat.update(h.sim, NEUTRAL_INPUT, .1);
    expect(h.hydro!.phase).toBe('stable'); expect(h.hydro!.level).toBeCloseTo(1.4);
    expect(boat.position.y).toBeCloseTo(1.4); expect(boat.inWater).toBe(true);
    expect(cameraUnderwater(h.sim.world, v3(82, .8, 20))).toBe(true);
    expect(cameraUnderwater(h.sim.world, v3(179, .8, 20))).toBe(false);
    h.character.teleport(v3(84, .1, 20)); h.character.update(h.sim.world, { forward: 0, right: 0, jump: true, sprint: false, crouch: false }, 0, .1);
    expect(h.character.inWater).toBe(true); expect(h.character.velocity.y).toBeGreaterThan(0);
    h.sim.fire.step(h.sim.world, .1); expect(h.sim.fire.burningCount).toBe(0);
    expect(h.hydro!.bridgeCollapsed).toBe(true); expect(fragments).toBeGreaterThan(0);
    expect(h.sim.world.dynamicBodies.some(b => !b.kinematic && b.shapes.some(s => s.name.startsWith('hydro-service-bridge:frag')))).toBe(true);
    for (const p of RING_ROAD) {
      expect(h.hydro!.surfaceAt(p)).toBeNull();
      const hit = h.sim.world.raycast(v3(p.x, 3, p.z), v3(0, -1, 0), { maxDistance: 1, filter: m => m !== Mat.Water });
      expect(hit?.point.y).toBeCloseTo(2.4);
    }
  }, 30_000);

  it('сохраняет ход паводка и обломки, не продвигает время при загрузке или паузе', () => {
    const h = scene(), checkpoint = new SessionCheckpoint(h);
    breach(h); h.hydro!.update(64);
    const saved = checkpoint.capture(), state = h.hydro!.snapshot();
    const copy = scene(); new SessionCheckpoint(copy).restore(saved);
    expect(copy.hydro!.snapshot()).toEqual(state); expect(copy.hydro!.level).toBeCloseTo(h.hydro!.level);
    expect(copy.hydro!.bridgeCollapsed).toBe(true);
    copy.update(0); expect(copy.hydro!.elapsed).toBe(state.elapsed);
    copy.update(.1); expect(copy.hydro!.elapsed).toBeCloseTo(state.elapsed + .1);
    expect(copy.cranes.get('port-crane')!.powered).toBe(false);
    const legacy = new Heist({ level: portLevel, sandbox: true }); legacy.start(); scenes.push(legacy);
    const count = legacy.sim.world.totalSolidVoxels();
    expect(() => new SessionCheckpoint(legacy).restore(saved)).toThrow('Несовместимое');
    expect(legacy.sim.world.totalSolidVoxels()).toBe(count);
  }, 30_000);
});
