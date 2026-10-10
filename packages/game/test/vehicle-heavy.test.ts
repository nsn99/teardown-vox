import { describe, expect, it } from 'vitest';
import { Body, Mat, Simulation, VoxelShape, v3 } from '@tvox/core';
import { NEUTRAL_INPUT, Vehicle, portLevel } from '@tvox/game';
import { roadSim } from './helpers/vehicle-world.js';

const drive = { ...NEUTRAL_INPUT, throttle: 0.5, blade: false };

describe('управляемый ковш тяжёлой техники', () => {
  it.each([
    ['bulldozer', Mat.Metal], ['bulldozer', Mat.HeavyMetal], ['bulldozer', Mat.Concrete],
    ['excavator', Mat.Metal], ['excavator', Mat.HeavyMetal], ['excavator', Mat.Concrete],
  ] as const)('%s разрушает препятствие %s автоматическим ковшом при движении', (kind, material) => {
    const sim = roadSim();
    const wall = new VoxelShape({ sx: 80, sy: 12, sz: 4, voxelSize: 0.1, grounded: true });
    wall.fill({}, material); wall.transform.position = v3(-4, 0, -6);
    sim.world.addBody(new Body({ shapes: [wall] }));
    const vehicle = new Vehicle(kind, { position: v3(0, 0.1, 0), waterLevel: -10 }); vehicle.spawn(sim);
    const before = wall.data.slice();
    for (let i = 0; i < 180; i++) vehicle.update(sim, NEUTRAL_INPUT, 1 / 60);
    expect(wall.data).toEqual(before); expect(vehicle.position.z).toBeGreaterThan(-5);
    for (let i = 0; i < 180; i++) vehicle.update(sim, drive, 1 / 60);
    expect(wall.solidVoxels).toBeLessThan(before.filter(mat => mat !== Mat.Air).length - 100);
    expect(vehicle.position.y).toBeCloseTo(0.02, 5);
  });

  it('бульдозер повреждает контейнер порта при движении, сохраняя пол и верх за пределами отвала', () => {
    const sim = new Simulation(); const level = portLevel.build(sim)[0];
    const container = level.shapes.find(s => s.name === 'containers')!;
    const road = level.shapes.find(s => s.name === 'vehicle-yard-south')!;
    const roadBefore = road.data.slice(), before = container.solidVoxels;
    const vehicle = new Vehicle('bulldozer', { position: v3(6.9, 0.1, 38.5), waterLevel: portLevel.waterLevel }); vehicle.spawn(sim);
    for (let i = 0; i < 180; i++) vehicle.update(sim, drive, 1 / 60);
    expect(container.solidVoxels).toBeLessThan(before - 300); expect(road.data).toEqual(roadBefore);
    expect(container.get(29, 50, 20)).toBe(Mat.Metal); // верхний контейнер не затронут
    expect(container.get(29, 25, 20)).toBe(Mat.Metal); // отвал не превращается в резак высотой с кабину
    const chips = sim.world.dynamicBodies.filter(body => body.tags.has('carved-debris'));
    expect(chips.some(body => body.shapes.some(shape => [...shape.paint.values()].some(color => color >= 0x1000000)))).toBe(true);
    expect(vehicle.position.y).toBeCloseTo(0.02, 5);
  }, 120_000);

  it('бульдозер режет склад на высоте ковша, но кабина останавливается перед оставшейся стеной', () => {
    const sim = new Simulation(); const level = portLevel.build(sim)[0];
    const warehouse = level.shapes.find(s => s.name === 'warehouse')!; const before = warehouse.solidVoxels;
    const above = warehouse.data.slice(warehouse.sx * warehouse.sz * 25);
    const vehicle = new Vehicle('bulldozer', { position: v3(29, 0.1, 24), yaw: Math.PI / 2, waterLevel: portLevel.waterLevel });
    vehicle.spawn(sim); vehicle.speed = 8;
    for (let i = 0; i < 180; i++) vehicle.update(sim, { ...drive, blade: false }, 1 / 60);
    expect(warehouse.solidVoxels).toBeLessThan(before);
    expect(warehouse.data.slice(warehouse.sx * warehouse.sz * 25)).toEqual(above); expect(vehicle.position.x).toBeGreaterThan(26);
    expect(vehicle.position.y).toBeGreaterThanOrEqual(0.02);
    expect(vehicle.position.y).toBeLessThan(0.4);
  }, 120_000);
});
