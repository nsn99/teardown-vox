import { describe, expect, it } from 'vitest';
import { Body, Mat, Simulation, VoxelShape, stepStructure, v3 } from '@tvox/core';
import { NEUTRAL_INPUT, Vehicle, portLevel } from '@tvox/game';
import { roadSim } from './helpers/vehicle-world.js';

const drive = { ...NEUTRAL_INPUT, throttle: 1 };

describe('тяжёлая техника разрушает на ходу', () => {
  it('край отвала ломает колонну, даже когда центр пути свободен', () => {
    const sim = roadSim();
    const column = new VoxelShape({ sx: 3, sy: 40, sz: 3, voxelSize: 0.1, grounded: true });
    column.fill({}, Mat.HeavyMetal); column.transform.position = v3(1.25, 0, -7);
    sim.world.addBody(new Body({ kind: 'static', shapes: [column] }));
    const vehicle = new Vehicle('bulldozer', { position: v3(0, 0.1, 0) });
    vehicle.spawn(sim);
    for (let i = 0; i < 180; i++) vehicle.update(sim, drive, 1 / 60);
    expect(column.get(1, 12, 1)).toBe(Mat.Air);
    expect(vehicle.position.z).toBeLessThan(-8);
  });

  it.each([
    ['bulldozer', Mat.Metal], ['bulldozer', Mat.HeavyMetal], ['bulldozer', Mat.Concrete],
    ['excavator', Mat.Metal], ['excavator', Mat.HeavyMetal], ['excavator', Mat.Concrete],
  ] as const)('%s проходит стену из материала %s без нажатия ковша и очищает место под кабину', (kind, material) => {
    const sim = roadSim();
    const wall = new VoxelShape({ sx: 100, sy: 60, sz: 8, voxelSize: 0.1, grounded: true });
    wall.fill({}, material); wall.transform.position = v3(-5, 0, -8);
    sim.world.addBody(new Body({ kind: 'static', shapes: [wall] }));
    const vehicle = new Vehicle(kind, { position: v3(0, 0.1, 0) });
    vehicle.spawn(sim);
    const before = wall.solidVoxels;
    for (let i = 0; i < 240; i++) vehicle.update(sim, drive, 1 / 60);
    expect(wall.solidVoxels).toBeLessThan(before - 500);
    expect(vehicle.position.z).toBeLessThan(-10);
    expect(vehicle.speed).toBeGreaterThan(3);
    for (let y = 1; y < vehicle.spec.size.y; y++) {
      expect(wall.get(50, y, 4)).toBe(Mat.Air);
    }
    expect([...sim.world.bodies.values()][0].shapes[0].get(40, 0, 240)).toBe(Mat.Foundation);
    expect(vehicle.hullIntegrity).toBe(1);
  });

  it('бульдозер разрушает настоящий окрашенный контейнер порта и проходит его', () => {
    const sim = new Simulation();
    const level = portLevel.build(sim)[0];
    const container = level.shapes.find(s => s.name === 'containers')!;
    const before = container.solidVoxels;
    const vehicle = new Vehicle('bulldozer', { position: v3(6.9, 0.1, 40), waterLevel: portLevel.waterLevel });
    vehicle.spawn(sim);
    for (let i = 0; i < 180; i++) vehicle.update(sim, drive, 1 / 60);
    expect(container.solidVoxels).toBeLessThan(before - 500);
    expect(container.get(29, 15, 20)).toBe(Mat.Air);
    const chips = sim.world.dynamicBodies.filter(body => body.tags.has('carved-debris'));
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.some(body => body.shapes.some(shape => [...shape.paint.values()].some(color => color >= 0x1000000)))).toBe(true);
    expect(vehicle.position.z).toBeLessThan(31);
    expect(vehicle.speed).toBeGreaterThan(2);
  }, 30_000);

  it('бульдозер проходит обе стены и колонны настоящего склада без остановки', () => {
    const sim = new Simulation();
    const level = portLevel.build(sim)[0];
    const warehouse = level.shapes.find(s => s.name === 'warehouse')!;
    const before = warehouse.solidVoxels;
    const vehicle = new Vehicle('bulldozer', { position: v3(29, 0.1, 24), yaw: Math.PI / 2, waterLevel: portLevel.waterLevel });
    vehicle.spawn(sim); vehicle.speed = 8;
    let slowest = 8;
    for (let i = 0; i < 360 && vehicle.position.x > 2.8; i++) {
      vehicle.update(sim, drive, 1 / 60);
      slowest = Math.min(slowest, vehicle.speed);
    }
    expect(warehouse.solidVoxels).toBeLessThan(before - 1000);
    expect(vehicle.position.x).toBeLessThan(2.8);
    expect(slowest).toBeGreaterThan(2);
    expect(vehicle.wrecked).toBe(false);
  }, 30_000);

  it('после сноса опор верх постройки отделяется в физические обломки', () => {
    const sim = roadSim();
    const shed = new VoxelShape({ sx: 30, sy: 40, sz: 40, voxelSize: 0.1, grounded: true, name: 'shed' });
    shed.fill({}, Mat.Brick);
    shed.fill({ x0: 2, x1: 28, y0: 2, y1: 38, z0: 2, z1: 38 }, Mat.Air);
    shed.fill({ y0: 38 }, Mat.Metal);
    shed.transform.position = v3(-1.5, 0, -10);
    sim.world.addBody(new Body({ kind: 'static', shapes: [shed] }));
    const vehicle = new Vehicle('bulldozer', { position: v3(0, 0.1, 0) });
    vehicle.spawn(sim);
    for (let i = 0; i < 180; i++) vehicle.update(sim, drive, 1 / 60);
    const result = stepStructure(sim.world, { stress: true, timeBudgetMs: 0 });
    expect(result.fragments.length).toBeGreaterThan(0);
    expect(result.fragments.some(({ body }) => body.shapes.some(shape => shape.name.startsWith('shed:frag')))).toBe(true);
    expect(result.fragments.every(({ body }) => body.kind === 'dynamic' && !body.kinematic)).toBe(true);
  });
});
