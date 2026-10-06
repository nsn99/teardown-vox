import { describe, expect, it } from 'vitest';
import { Body, Mat, RapierPhysics, Simulation, VoxelShape, quatFromEulerYXZ, v3 } from '@tvox/core';
import { NEUTRAL_INPUT, Vehicle } from '@tvox/game';
import { dentVehicle } from '../src/vehicle-contact.js';
import { addRoad, addWater, roadSim } from './helpers/vehicle-world.js';

const drive = { ...NEUTRAL_INPUT, throttle: 1 };
function run(sim: Simulation, vehicles: Vehicle[], seconds: number, input = NEUTRAL_INPUT): void {
  for (let i = 0; i < Math.ceil(seconds * 60); i++) for (const vehicle of vehicles) vehicle.update(sim, input, 1 / 60);
}

describe('аварии транспорта', () => {
  it('сломанный двигатель не закрепляет разбитую машину на месте при ударе', () => {
    const sim = roadSim();
    const moving = new Vehicle('car', { position: v3(0, 0.1, 0) });
    const wreck = new Vehicle('car', { position: v3(0, 0.1, -4) });
    const hull = wreck.body.shapes[0];
    hull.fill({ x0: 0, x1: Math.floor(hull.sx * 0.7) }, Mat.Air);
    moving.spawn(sim); wreck.spawn(sim); moving.speed = 15;
    moving.update(sim, drive, 0.1);
    run(sim, [wreck], 0.25);
    expect(wreck.wrecked).toBe(true);
    expect(wreck.canDrive()).toBe(false);
    expect(wreck.position.z).toBeLessThan(-5);
  });
  it('лобовой удар мнёт оба кузова и отбрасывает машины, теряя энергию', () => {
    const sim = roadSim();
    const a = new Vehicle('car', { position: v3(0, 0.1, 0) });
    const b = new Vehicle('car', { position: v3(0, 0.1, -4), yaw: Math.PI });
    a.spawn(sim); b.spawn(sim); a.speed = b.speed = 12;
    const before = [a, b].map(v => v.body.shapes[0].data.slice());
    const impacts: number[] = [];
    sim.world.events.on('impact', event => impacts.push(event.impulse));
    a.update(sim, NEUTRAL_INPUT, 0.1);
    expect(impacts).toHaveLength(1);
    expect(a.speed).toBeLessThan(-2);
    expect(b.speed).toBeLessThan(-2);
    expect(a.speed ** 2 + b.speed ** 2).toBeLessThan(12 ** 2 * 2 * 0.3);
    for (const [i, vehicle] of [a, b].entries()) {
      expect(vehicle.body.shapes[0].data).not.toEqual(before[i]);
      expect(vehicle.hullIntegrity).toBeGreaterThan(0.8);
    }
    run(sim, [a, b], 0.3);
    expect(a.position.z - b.position.z).toBeGreaterThan(3.8);
    expect(impacts).toHaveLength(1);
  });

  it('боковой удар за пределами центрального щупа повреждает и сдвигает припаркованную машину', () => {
    const sim = roadSim();
    const moving = new Vehicle('pickup', { position: v3(0.9, 0.1, 0) });
    const parked = new Vehicle('car', { position: v3(0, 0.1, -3.35), yaw: Math.PI / 2 });
    moving.spawn(sim); parked.spawn(sim); moving.speed = 16;
    const before = parked.body.shapes[0].data.slice();
    moving.update(sim, drive, 0.1);
    expect(parked.body.shapes[0].data).not.toEqual(before);
    expect(parked.body.velocity.z).toBeLessThan(-2);
    expect(moving.position.z).toBeGreaterThan(-0.5);
    const start = parked.position.z;
    run(sim, [moving, parked], 0.3);
    expect(parked.position.z).toBeLessThan(start - 0.3);
  });

  it('длинный кадр не пропускает быстро едущую машину сквозь припаркованную', () => {
    const sim = roadSim();
    const moving = new Vehicle('car', { position: v3(0, 0.1, 0) });
    const parked = new Vehicle('car', { position: v3(0, 0.1, -4.2) });
    moving.spawn(sim); parked.spawn(sim); moving.speed = 22;
    moving.update(sim, drive, 0.1);
    expect(moving.position.z).toBeGreaterThan(-0.5);
    expect(parked.body.velocity.z).toBeLessThan(-8);
    expect(moving.body.velocity.z).toBeGreaterThan(-10);
  });

  it('тяжёлый бульдозер толкает легковую, сохраняя массу и не вырезая из неё проход', () => {
    const sim = roadSim();
    const heavy = new Vehicle('bulldozer', { position: v3(0, 0.1, 0) });
    const light = new Vehicle('car', { position: v3(0, 0.1, -5.1) });
    heavy.spawn(sim); light.spawn(sim); heavy.speed = 8;
    const before = light.initialVoxels;
    heavy.update(sim, drive, 0.1);
    expect(heavy.speed).toBeGreaterThan(5);
    expect(light.body.velocity.z).toBeLessThan(-5);
    expect(light.body.solidVoxels).toBeGreaterThan(before * 0.75);
    expect(heavy.position.z).toBeGreaterThan(-0.3);
  });

  it('лёгкое касание передаёт движение без вмятины', () => {
    const sim = roadSim();
    const a = new Vehicle('car', { position: v3(0, 0.1, 0) });
    const b = new Vehicle('car', { position: v3(0, 0.1, -3.9) });
    a.spawn(sim); b.spawn(sim); a.speed = 1.5;
    const before = [a.body.solidVoxels, b.body.solidVoxels];
    a.update(sim, drive, 0.1);
    expect(b.speed).toBeGreaterThan(0);
    expect([a.body.solidVoxels, b.body.solidVoxels]).toEqual(before);
  });

  it('не сталкивает машины, проезжающие рядом или на разных высотах', () => {
    const sim = roadSim();
    const a = new Vehicle('car', { position: v3(0, 0.1, 0) });
    const beside = new Vehicle('car', { position: v3(2.2, 0.1, -3.8) });
    const above = new Vehicle('car', { position: v3(0, 3, -3.8) });
    a.spawn(sim); beside.spawn(sim); above.spawn(sim); a.speed = 16;
    a.update(sim, drive, 0.1);
    expect(a.position.z).toBeLessThan(-1.5);
    expect(beside.speed).toBe(0);
    expect(above.speed).toBe(0);
  });

  it('вмятина перемещает окрашенный металл внутрь, а стекло разбивается с верным событием', () => {
    const sim = new Simulation();
    const shape = new VoxelShape({ sx: 10, sy: 10, sz: 10, voxelSize: 0.1 });
    shape.fill({ x0: 0, x1: 1 }, Mat.Metal);
    shape.set(0, 5, 5, Mat.Glass);
    shape.paint.set(shape.idx(0, 4, 5), 0x1ff6600);
    const body = sim.world.addBody(new Body({ kind: 'dynamic', shapes: [shape] }));
    const events: Map<number, number>[] = [];
    sim.world.events.on('voxels:removed', event => events.push(event.materials));
    dentVehicle(sim, body, v3(0, 0.5, 0.5), v3(1, 0, 0), 10);
    expect(shape.get(0, 4, 5)).toBe(Mat.Air);
    expect(shape.get(2, 4, 5)).toBe(Mat.Metal);
    expect(shape.paint.get(shape.idx(2, 4, 5))).toBe(0x1ff6600);
    expect(shape.get(2, 5, 5)).toBe(Mat.Air);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(new Map([[Mat.Glass, 1]]));
    expect(body.collidersDirty).toBe(true);
    shape.fill({}, Mat.Air);
    shape.fill({ x0: 0, x1: 1 }, Mat.HeavyMetal);
    const before = shape.data.slice();
    dentVehicle(sim, body, v3(0, 0.5, 0.5), v3(1, 0, 0), 8);
    expect(shape.data).toEqual(before);
  });

  it('Rapier сохраняет отдачу управляемых кузовов после столкновения', async () => {
    const sim = roadSim();
    const physics = await RapierPhysics.create(sim.world);
    sim.setPhysics(physics);
    try {
      const a = new Vehicle('car', { position: v3(0, 0.1, 0) });
      const b = new Vehicle('car', { position: v3(0, 0.1, -4), yaw: Math.PI });
      a.spawn(sim); b.spawn(sim); a.speed = b.speed = 12;
      a.update(sim, NEUTRAL_INPUT, 0.1);
      for (let i = 0; i < 12; i++) {
        a.update(sim, NEUTRAL_INPUT, 1 / 60); b.update(sim, NEUTRAL_INPUT, 1 / 60);
        physics.step(1 / 60);
      }
      expect(a.position.z).toBeGreaterThan(0.3);
      expect(b.position.z).toBeLessThan(-4.3);
      expect(a.body.transform.position.z).toBeCloseTo(a.position.z, 4);
    } finally { physics.dispose(); }
  });
});

describe('опора, падение и вода', () => {
  it('колонна под одним углом не поднимает машину в воздух', () => {
    const sim = roadSim();
    const column = new VoxelShape({ sx: 3, sy: 30, sz: 3, voxelSize: 0.1 });
    column.fill({}, Mat.Concrete); column.transform.position = v3(0.45, 0, -1.35);
    sim.world.addBody(new Body({ kind: 'static', shapes: [column] }));
    const car = new Vehicle('car', { position: v3(0, 0.1, 0), waterLevel: -10 });
    car.spawn(sim);
    run(sim, [car], 1);
    expect(car.grounded).toBe(true);
    expect(car.position.y).toBeCloseTo(0.02, 5);
  });
  it('машина едет с покрытия в воду, тонет и продолжает опускаться после остановки двигателя', () => {
    const sim = new Simulation();
    addRoad(sim, v3(-5, -0.5, -3), v3(10, 0.5, 6));
    addWater(sim, v3(-10, -20, -100), v3(20, 20, 100));
    const car = new Vehicle('pickup', { position: v3(0, 0.1, 0), waterLevel: 0 });
    car.spawn(sim);
    run(sim, [car], 3, drive);
    expect(car.position.z).toBeLessThan(-3);
    expect(car.position.y).toBeLessThan(-1);
    expect(car.wrecked).toBe(true);
    expect(car.canDrive()).toBe(false);
    const y = car.position.y;
    run(sim, [car], 0.5, drive);
    expect(car.position.y).toBeLessThan(y - 1);
    expect(car.speed).toBe(0);
  });

  it('за краем карты нет невидимого пола или бесконечной воды', () => {
    const sim = new Simulation();
    addWater(sim, v3(-5, -5, -5), v3(10, 5, 10));
    const car = new Vehicle('pickup', { position: v3(20, 0.1, 0) });
    car.spawn(sim);
    run(sim, [car], 2, drive);
    expect(car.position.y).toBeLessThan(-10);
    expect(car.position.z).toBe(0);
    expect(car.inWater).toBe(false);
    const y = car.position.y;
    run(sim, [car], 1);
    expect(car.position.y).toBeLessThan(y - 10);
  });

  it('машина садится на существующий пол и падает после разрушения опоры', () => {
    const sim = roadSim();
    const floor = [...sim.world.bodies.values()][0].shapes[0];
    const car = new Vehicle('car', { position: v3(0, 3, 0), waterLevel: -20 });
    car.spawn(sim);
    run(sim, [car], 2);
    expect(car.grounded).toBe(true);
    expect(car.position.y).toBeCloseTo(0.02, 5);
    floor.fill({}, Mat.Air);
    run(sim, [car], 0.5);
    expect(car.grounded).toBe(false);
    expect(car.position.y).toBeLessThan(-1);
  });

  it('катер за границей водоёма не висит на прежнем уровне воды', () => {
    const sim = new Simulation();
    addWater(sim, v3(-10, -5, -10), v3(20, 5, 20));
    const boat = new Vehicle('boat', { position: v3(0, 0, 0) });
    boat.spawn(sim);
    run(sim, [boat], 0.5, drive);
    expect(boat.position.y).toBe(0);
    boat.position = v3(25, 0, 0);
    run(sim, [boat], 1, drive);
    expect(boat.inWater).toBe(false);
    expect(boat.position.y).toBeLessThan(-3);
  });

  it('повёрнутая машина на твёрдом берегу не считается утонувшей', () => {
    const sim = roadSim();
    const car = new Vehicle('car', { position: v3(0, 0.1, 0), yaw: 1.2 });
    car.spawn(sim);
    run(sim, [car], 2, drive);
    expect(car.body.transform.rotation).toEqual(quatFromEulerYXZ(car.yaw + Math.PI / 2, 0));
    expect(car.grounded).toBe(true);
    expect(car.inWater).toBe(false);
    expect(car.wrecked).toBe(false);
  });
});
