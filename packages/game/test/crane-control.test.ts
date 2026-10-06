import { afterEach, describe, expect, it } from 'vitest';
import { Mat, RapierPhysics, carve, transformPoint, v3 } from '@tvox/core';
import {
  ChargeSystem, Heist, Inventory, NEUTRAL_CRANE_INPUT, PortCrane, docFromLevel,
  levelFromDoc, parseLevelDoc, portLevel,
} from '@tvox/game';
import PORT_DOC from '../src/levels/port.json';
import { overlapsSolid } from '../src/character.js';

let h: Heist;
function scene(): PortCrane {
  h = new Heist({ level: portLevel, sandbox: true,
    simulation: { structure: { timeBudgetMs: 0 }, structureEveryNSteps: 1, structureBudgetMs: 0 } });
  h.start();
  const crane = h.cranes.get('port-crane')!;
  crane.update(NEUTRAL_CRANE_INPUT, 0);
  return crane;
}
function turnTo(crane: PortCrane, target: number): void {
  for (let i = 0; i < 200; i++) {
    const error = Math.atan2(Math.sin(target - crane.yaw), Math.cos(target - crane.yaw));
    if (Math.abs(error) < 1e-6) break;
    crane.update({ slew: -Math.sign(error) * Math.min(1, Math.abs(error) / (crane.def.slewSpeed * .1)), luff: 0, hoist: 0 }, .1);
  }
  expect(Math.abs(Math.atan2(Math.sin(target - crane.yaw), Math.cos(target - crane.yaw)))).toBeLessThan(1e-6);
}
function takeYardCrate(crane: PortCrane): void {
  for (let i = 0; i < 25; i++) crane.update({ slew: 0, luff: 0, hoist: 1 }, .1);
  turnTo(crane, -11 * Math.PI / 18);
  for (let i = 0; i < 80 && crane.grip.y > 2; i++) crane.update({ slew: 0, luff: 0, hoist: -1 }, .1);
  expect(crane.toggleLoad()).toBe('attached');
  expect(crane.load?.name).toBe('Ящик на поддоне');
  expect(crane.load!.aabb().max.y).toBeCloseTo(crane.hook.aabb().min.y, 6);
}
afterEach(() => h?.sim.dispose());

describe('управление портовым краном', () => {
  it('пульт доступен в кабине; посадка, выход и камера согласованы с поворотом', () => {
    const c = scene();
    expect(h.toggleCrane()).toBeNull();
    h.character.teleport(c.exit);
    expect(h.nearbyCrane).toBe(c);
    expect(h.toggleCrane()).toBe('port-crane');
    expect(h.toggleVehicle()).toBeNull();
    const eye = { ...h.eye };
    for (let i = 0; i < 60; i++) h.update(1 / 60, undefined, undefined, { slew: 1, luff: 0, hoist: 0 });
    expect(c.yaw).toBeCloseTo(-c.def.slewSpeed);
    expect(h.yaw).toBeCloseTo(c.yaw);
    expect(h.eye.x).not.toBeCloseTo(eye.x);
    expect(h.eye.y).toBeCloseTo(eye.y);
    expect(h.character.position).toEqual(c.seat);
    expect(h.toggleCrane()).toBe('port-crane');
    expect(h.operating).toBeNull();
    expect(overlapsSolid(h.sim.world, h.character.aabbAt(h.character.position))).toBe(false);
  });

  it('стрела и лебёдка движут настоящие тела и не восстанавливают вырезанные воксели', () => {
    const c = scene();
    const shape = c.house.shapes[0];
    const damaged = shape.idx(0, 25, 15);
    expect(shape.data[damaged]).not.toBe(Mat.Air);
    shape.setAt(damaged, Mat.Air);
    const start = c.tip;
    const hookY = c.grip.y;
    for (let i = 0; i < 30; i++) c.update({ slew: .5, luff: 1, hoist: 1 }, .1);
    expect(c.tip.y).toBeGreaterThan(start.y + 2);
    expect(c.grip.y).toBeGreaterThan(hookY + 5);
    expect(c.ropeLength).toBeLessThan(c.def.ropes.length - 5);
    expect(shape.data[damaged]).toBe(Mat.Air);
    const before = { yaw: c.yaw, angle: c.angle, length: c.ropeLength };
    c.update(NEUTRAL_CRANE_INPUT, 1);
    expect({ yaw: c.yaw, angle: c.angle, length: c.ropeLength }).toEqual(before);
    for (let i = 0; i < 100; i++) c.update({ slew: 0, luff: 1, hoist: 1 }, .1);
    expect(c.angle).toBe(c.def.maxAngle);
    expect(c.ropeLength).toBe(c.def.ropes.min);
  });

  it('поднимает ящик, переносит поворотом и возвращает его в физику при отпускании', async () => {
    const c = scene();
    h.sim.setPhysics(await RapierPhysics.create(h.sim.world));
    takeYardCrate(c);
    const box = c.load!;
    const initial = box.aabb();
    for (let i = 0; i < 20; i++) c.update({ slew: 0, luff: 0, hoist: 1 }, .1);
    expect(box.aabb().min.y).toBeGreaterThan(initial.min.y + 3.9);
    turnTo(c, -Math.PI / 2);
    expect(box.aabb().min.x).toBeGreaterThan(40);
    expect(box.kinematic).toBe(true);
    for (let i = 0; i < 12; i++) { c.update(NEUTRAL_CRANE_INPUT, 1 / 60); h.sim.step(1 / 60); }
    const before = box.aabb().min.y;
    expect(c.toggleLoad()).toBe('released');
    expect(box.kinematic).toBe(false);
    expect(box.tags.has('crane-load')).toBe(false);
    for (let i = 0; i < 45; i++) h.sim.step(1 / 60);
    expect(box.aabb().min.y).toBeLessThan(before - .5);
  }, 45_000);

  it('останавливает груз над землёй и позволяет поднять его после остановки', () => {
    const c = scene();
    takeYardCrate(c);
    for (let i = 0; i < 60; i++) c.update({ slew: 0, luff: 0, hoist: -1 }, .1);
    expect(c.blocked).toBe(true);
    expect(c.load!.aabb().min.y).toBeGreaterThanOrEqual(-1e-6);
    const before = { ...c.load!.transform.position };
    c.update({ slew: 0, luff: 0, hoist: -1 }, .1);
    expect(c.load!.transform.position).toEqual(before);
    c.update({ slew: 0, luff: 0, hoist: 1 }, .1);
    expect(c.blocked).toBe(false);
    expect(c.load!.aabb().min.y).toBeGreaterThan(.1);
  });

  it('настоящий заряд обрывает тросы и роняет поднятый груз; привод не чинит обрыв', () => {
    const c = scene();
    takeYardCrate(c);
    for (let i = 0; i < 12; i++) c.update({ slew: 0, luff: 0, hoist: 1 }, .1);
    const box = c.load!;
    const rope = c.ropes.shapes[0];
    const point = transformPoint(c.ropes.transform, transformPoint(rope.transform, v3(.05, 4, .05)));
    const charges = new ChargeSystem({ fuse: Infinity });
    const inventory = new Inventory({ unlimited: true });
    inventory.select('explosive');
    expect(charges.place({ sim: h.sim, inventory, origin: v3(point.x, point.y, point.z - .8), direction: v3(0, 0, 1) })).not.toBeNull();
    expect(charges.detonateAll(h.sim)).toBe(1);
    c.update(NEUTRAL_CRANE_INPUT, 0);
    expect(c.hoistIntact).toBe(false);
    expect(c.hook.kinematic).toBe(false);
    expect(box.kinematic).toBe(false);
    expect(c.load).toBeNull();
    const voxels = rope.solidVoxels;
    c.update({ slew: 0, luff: 0, hoist: 1 }, .1);
    expect(rope.solidVoxels).toBe(voxels);
  });

  it('разрушение тяги освобождает стрелу, а повреждение пульта высаживает игрока', () => {
    const c = scene();
    h.character.teleport(c.exit);
    h.toggleCrane();
    const stay = c.stay.shapes[0];
    const center = transformPoint(c.stay.transform, transformPoint(stay.transform, v3(.15, 3, .15)));
    const ignore = new Set([...h.sim.world.bodies.keys()].filter(id => id !== c.stay.id));
    expect(carve(h.sim.world, { kind: 'sphere', center, radius: .3 }, {
      power: 2, damage: 0, instant: true, falloff: 'none', ignoreBodies: ignore,
    }).removed).toBeGreaterThan(0);
    c.update(NEUTRAL_CRANE_INPUT, 0);
    expect(c.boom.kinematic).toBe(false);
    expect(c.hook.kinematic).toBe(false);
    const house = c.house.shapes[0];
    const local = v3((28.7 - 28) / .1, (11.65 - 10.4) / .1, (4.15 - 3.5) / .1);
    house.set(Math.floor(local.x), Math.floor(local.y), Math.floor(local.z), Mat.Air);
    h.update(1 / 60);
    expect(h.operatingId).toBeNull();
  });

  it('оторванный крюк оставляет подвесной блок, но захват в пустом месте отключён', () => {
    const c = scene();
    const charges = new ChargeSystem({ fuse: Infinity });
    const inventory = new Inventory({ unlimited: true }); inventory.select('explosive');
    expect(charges.place({ sim: h.sim, inventory, origin: v3(31.8, 3.9, -5.8), direction: v3(0, 0, 1) })).not.toBeNull();
    expect(charges.detonateAll(h.sim)).toBe(1);
    c.update(NEUTRAL_CRANE_INPUT, 0);
    expect(c.hook.kinematic).toBe(true);
    expect(c.hoistIntact).toBe(false);
    expect(c.toggleLoad()).toBe('broken');
  });

  it('перезапуск возвращает исправный кран и не оставляет захваченный груз', () => {
    const c = scene();
    takeYardCrate(c);
    const id = c.house.id;
    h.character.teleport(c.exit);
    h.toggleCrane();
    h.restart();
    const fresh = h.cranes.get('port-crane')!;
    expect(h.operatingId).toBeNull();
    expect(fresh.house.id).not.toBe(id);
    expect(fresh.yaw).toBe(0);
    expect(fresh.hoistIntact).toBe(true);
    expect([...h.sim.world.bodies.values()].some(b => b.tags.has('crane-load'))).toBe(false);
  });
});

describe('описание управляемого крана в карте', () => {
  it('снимок карты сохраняет привод и крепления, восстановленный пульт работает', () => {
    scene();
    // Документ уровня сохраняет параметры механизма наряду с геометрией.
    const sim = new Heist({ level: portLevel, sandbox: true }).sim;
    portLevel.build(sim);
    const doc = parseLevelDoc(docFromLevel(portLevel, sim));
    const restored = levelFromDoc(doc);
    expect(restored.cranes).toEqual(portLevel.cranes);
    sim.dispose();
    const copy = new Heist({ level: restored, sandbox: true });
    copy.start();
    const c = copy.cranes.get('port-crane')!;
    copy.character.teleport(c.exit);
    expect(copy.toggleCrane()).toBe(c.def.id);
    copy.sim.dispose();
  });

  it.each([
    ['cranes', (d: Record<string, unknown>) => { d.cranes = {}; }],
    ['cranes[1].id', (d: Record<string, unknown>) => { (d.cranes as unknown[]).push(structuredClone((d.cranes as unknown[])[0])); }],
    ['cranes[0].boom.body', (d: Record<string, unknown>) => { (d.cranes as typeof PORT_DOC.cranes)[0].boom.body = 'missing'; }],
    ['cranes[0].base.anchors', (d: Record<string, unknown>) => { (d.cranes as typeof PORT_DOC.cranes)[0].base.anchors = [[1000, 0, 0]]; }],
    ['cranes[0].ropes.length', (d: Record<string, unknown>) => { (d.cranes as typeof PORT_DOC.cranes)[0].ropes.length = 50; }],
    ['cranes[0].ropes.columns', (d: Record<string, unknown>) => { (d.cranes as typeof PORT_DOC.cranes)[0].ropes.columns = [0, 0]; }],
    ['cranes[0].angle', (d: Record<string, unknown>) => { (d.cranes as typeof PORT_DOC.cranes)[0].maxAngle = 2; }],
    ['cranes[0].hoistSpeed', (d: Record<string, unknown>) => { (d.cranes as typeof PORT_DOC.cranes)[0].hoistSpeed = 0; }],
  ])('ошибка %s указывает поле карты', (field, mutate) => {
    const doc = structuredClone(PORT_DOC);
    mutate(doc);
    expect(() => parseLevelDoc(doc)).toThrow(field);
  });
});
