import { afterEach, describe, expect, it } from 'vitest';
import { Body, Mat, VoxelShape, carve, transformPoint, v3 } from '@tvox/core';
import { DEFAULT_INPUT, Heist, NEUTRAL_INPUT, SessionCheckpoint, portLevel } from '@tvox/game';

const scenes: Heist[] = [];
function scene(sandbox = true) {
  const h = new Heist({ level: portLevel, sandbox }); h.start(); scenes.push(h);
  return { h, checkpoint: new SessionCheckpoint(h) };
}
afterEach(() => { for (const h of scenes.splice(0)) h.sim.dispose(); });

describe('сохранение сессии', () => {
  it('восстанавливает разрушения, новый груз, удалённое тело, машину и настройки без копии нетронутой карты', () => {
    const { h, checkpoint } = scene();
    const clean = checkpoint.capture();
    expect(clean.bodies.flatMap(b => b.shapes).every(s => !s.json)).toBe(true);
    const wall = [...h.sim.world.bodies.values()].flatMap(b => b.shapes).find(s => s.name === 'warehouse')!;
    const result = carve(h.sim.world, { kind: 'sphere', center: v3(12, 1.5, 14.2), radius: 0.7 },
      { power: 1.4, damage: 0, instant: true, falloff: 'none' });
    expect(result.removed).toBeGreaterThan(0);
    const index = wall.data.findIndex(m => m === Mat.Brick); wall.damage[index] = 23;
    const truck = h.vehicles.get('cargo-truck')!;
    truck.speedLimit = 0.4; h.drivingId = 'cargo-truck'; h.yaw = .8; h.pitch = -.2;
    const shape = new VoxelShape({ sx: 6, sy: 6, sz: 6, name: 'saved-cargo' }); shape.fill({}, Mat.Wood);
    shape.transform.position = v3(-.3, 0, -.3);
    const cargo = h.sim.world.addBody(new Body({ name: 'saved-cargo', kind: 'dynamic', shapes: [shape], tags: ['cargo'],
      transform: { position: transformPoint(truck.body.transform, v3(-1.7, 1.22, 0)), rotation: truck.orientation } }));
    expect(truck.deck!.toggle(h.sim)).toBe('secured');
    h.sim.fire.ignite(cargo, shape, 0);
    const removed = h.vehicles.get('car')!.body; h.sim.world.removeBody(removed);
    h.sim.destruction.enqueue({ kind: 'sphere', center: v3(12, 2, 14), radius: .2 },
      { power: 1.4, damage: 0, instant: true, ignoreBodies: new Set([truck.body.id]) });
    const save = checkpoint.capture();
    const expectedWall = wall.data.slice(), count = h.sim.world.totalSolidVoxels();
    const { h: restored, checkpoint: loader } = scene();
    loader.restore(save);
    expect(restored.sim.world.totalSolidVoxels()).toBe(count);
    const loadedWall = [...restored.sim.world.bodies.values()].flatMap(b => b.shapes).find(s => s.name === 'warehouse')!;
    expect(loadedWall.data).toEqual(expectedWall); expect(loadedWall.damage[index]).toBe(23);
    expect(restored.sim.world.bodies.has(restored.vehicles.get('car')!.body.id)).toBe(false);
    expect(restored.sim.destruction.pending).toBe(1);
    expect(restored.sim.destruction.snapshot()[0].opts.ignoreBodies).toEqual(new Set([restored.driving!.body.id]));
    expect(restored.drivingId).toBe('cargo-truck'); expect(restored.driving!.speedLimit).toBe(.4);
    expect(restored.driving!.deck!.count).toBe(1); expect(restored.yaw).toBe(.8); expect(restored.pitch).toBe(-.2);
    expect(restored.sim.fire.burningCount).toBe(h.sim.fire.burningCount);
    expect(restored.driving!.deck!.release(restored.sim)).toBe(1);
    const loadedCargo = [...restored.sim.world.bodies.values()].find(b => b.name === 'saved-cargo')!;
    expect(loadedCargo.id).not.toBe(cargo.id); expect(loadedCargo.kinematic).toBe(false);
    restored.update(1 / 60, DEFAULT_INPUT, NEUTRAL_INPUT);
    expect(restored.driving).not.toBeNull(); expect(loadedWall.solidVoxels).toBeLessThan(wall.sx * wall.sy * wall.sz);
    // A checkpoint remains independent of subsequent gameplay and round-trips again.
    wall.fill({}, Mat.Air); expect(save.bodies.flatMap(b => b.shapes).find(s => s.id === wall.id)!.json!.rle.length).toBeGreaterThan(1);
    const again = loader.capture(); expect(again.drivingId).toBe('cargo-truck');
  }, 30_000);

  it('сохраняет таймер миссии, заряд с бесконечным фитилём, ворота, триггеры и позицию крановщика', () => {
    const { h, checkpoint } = scene(false);
    h.mission.triggerAlarm('test');
    h.update(.1); h.update(.1);
    h.inventory.select('explosive');
    h.charges.restore([{ id: 7, position: v3(1, 2, 3), blastCenter: v3(1, 2, 3), radius: 2, power: 1.2, fuse: Infinity, armed: true }]);
    const c = h.cranes.get('port-crane')!;
    h.character.teleport(c.exit); expect(h.toggleCrane()).toBe('port-crane');
    c.update({ slew: .5, hoist: 1, luff: .2 }, .1);
    h.gates[0].update(h.gates[0].body.aabb(), .1);
    const save = checkpoint.capture();
    const { h: restored, checkpoint: loader } = scene(false); loader.restore(save);
    expect(restored.mission.snapshot()).toEqual(h.mission.snapshot());
    expect(restored.inventory.snapshot()).toEqual(h.inventory.snapshot());
    expect(restored.charges.list()).toEqual(h.charges.list());
    expect(restored.triggers.snapshot()).toEqual(h.triggers.snapshot());
    expect(restored.gates[0].snapshot()).toEqual(h.gates[0].snapshot());
    expect(restored.operating!.yaw).toBe(c.yaw); expect(restored.operating!.ropeLength).toBe(c.ropeLength);
    expect(restored.toggleCrane()).toBe('port-crane');
    expect(restored.operatingId).toBeNull();
    const before = restored.mission.timeLeft; restored.update(.1);
    expect(restored.mission.timeLeft).toBeLessThan(before);
  }, 30_000);

  it('отклоняет сохранение другой карты до изменения мира', () => {
    const { h, checkpoint } = scene(); const saved = checkpoint.capture();
    saved.fingerprint += 'changed';
    const count = h.sim.world.totalSolidVoxels();
    expect(() => checkpoint.restore(saved)).toThrow('Несовместимое');
    expect(h.sim.world.totalSolidVoxels()).toBe(count);
  });
});

it('сохраняет предмет в руках и позволяет отпустить его после загрузки', () => {
  const {h,checkpoint}=scene();
  h.character.teleport(v3(45,0,37)); h.yaw=0; h.pitch=0;
  const s=new VoxelShape({sx:3,sy:3,sz:3});s.fill({},Mat.Wood);
  const b=new Body({name:'hand-test',kind:'dynamic',shapes:[s]});
  b.transform.position=v3(44.85,h.eye.y-.15,35.8);h.sim.world.addBody(b);
  expect(h.interact()).toBe(`body:${b.id}`); expect(h.hands.body).toBe(b);
  const save=checkpoint.capture();const {h:other,checkpoint:loader}=scene();loader.restore(save);
  expect(other.hands.body?.name).toBe('hand-test');expect(other.hands.body?.id).not.toBe(b.id);
  const held=other.hands.body!;expect(other.interact()).toBe(`body:${held.id}`);
  expect(held.kinematic).toBe(false);expect(other.hands.body).toBeNull();
});
