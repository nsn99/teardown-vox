import { describe, expect, it } from 'vitest';
import { Body, Mat, RapierPhysics, Simulation, VoxelShape, quatFromAxisAngle, rotateVec, v3 } from '@tvox/core';
import { NEUTRAL_INPUT, Vehicle } from '@tvox/game';

function floor(sim: Simulation, mat = Mat.Concrete) {
  const shape = new VoxelShape({ sx: 120, sy: 4, sz: 260, voxelSize: 0.1, grounded: true });
  shape.fill({}, mat); shape.structural = false; shape.transform.position = v3(-6, -0.4, -20);
  sim.world.addBody(new Body({ shapes: [shape] })); return shape;
}

describe('транспорт не уничтожает свою опору', () => {
  it.each(['car', 'pickup', 'truck', 'bulldozer', 'excavator'] as const)('%s сохраняет покрытие при езде, торможении и работе ковшом', async kind => {
    const sim = new Simulation(); const road = floor(sim);
    const physics = await RapierPhysics.create(sim.world); sim.setPhysics(physics);
    try {
      const vehicle = new Vehicle(kind, { position: v3(0, 0.1, 0), waterLevel: -10 }); vehicle.spawn(sim);
      const before = road.data.slice();
      for (let i = 0; i < 180; i++) {
        vehicle.update(sim, { ...NEUTRAL_INPUT, throttle: i < 120 ? 0.4 : 0, blade: true, brake: i >= 120 }, 1 / 60);
        physics.step(1 / 60); vehicle.afterPhysics();
        expect(vehicle.position.y).toBeGreaterThanOrEqual(-0.01);
      }
      expect(road.data).toEqual(before); expect(vehicle.wrecked).toBe(false);
    } finally { physics.dispose(); }
  });

  it('ковш и падающие стальные обломки контейнера сохраняют бетон под ними и под гусеницами', async () => {
    const sim = new Simulation(); const road = floor(sim);
    const wall = new VoxelShape({ sx: 40, sy: 30, sz: 2, voxelSize: 0.1, grounded: true });
    wall.fill({}, Mat.Metal); wall.transform.position = v3(-2, 0, -4.5);
    sim.world.addBody(new Body({ shapes: [wall] }));
    const v = new Vehicle('bulldozer', { position: v3(0, 0.1, 0), waterLevel: -10 }); v.spawn(sim);
    const before = wall.solidVoxels, surface = road.data.slice();
    const physics = await RapierPhysics.create(sim.world); sim.setPhysics(physics);
    try {
      for (let i = 0; i < 180; i++) {
        v.update(sim, { ...NEUTRAL_INPUT, blade: true }, 1 / 60);
        physics.step(1 / 60); v.afterPhysics();
      }
    } finally { physics.dispose(); }
    expect(wall.solidVoxels).toBeLessThan(before - 500); expect(road.data).toEqual(surface);
    expect(v.position.y).toBeCloseTo(0.02, 5);
  });

  it.each(['car', 'pickup', 'bulldozer', 'excavator'] as const)('%s упирается в прочную стену и не сносит её корпусом', kind => {
    const sim = new Simulation(); floor(sim);
    const wall = new VoxelShape({ sx: 100, sy: 50, sz: 4, voxelSize: 0.1, grounded: true });
    wall.fill({}, Mat.Concrete); wall.transform.position = v3(-5, 0, -7);
    sim.world.addBody(new Body({ shapes: [wall] }));
    const v = new Vehicle(kind, { position: v3(0, 0.1, 0), waterLevel: -10 }); v.spawn(sim); v.speed = v.spec.maxSpeed;
    // A broken bucket cannot cut: verify the chassis collision independently.
    if (v.bladeShape) v.bladeShape.fill({}, Mat.Air);
    const before = wall.data.slice();
    for (let i = 0; i < 180; i++) {
      v.update(sim, { ...NEUTRAL_INPUT, throttle: 1 }, 1 / 60);
      if (v.spec.blade) expect(v.speed).toBeGreaterThanOrEqual(0);
    }
    expect(wall.data).toEqual(before); expect(v.position.z).toBeGreaterThan(-7 + v.spec.size.x * 0.05);
  });
});

describe('рампа и падение с контейнера', () => {
  it.each(['bulldozer', 'excavator', 'truck'] as const)('Rapier ловит падающий %s на бетонной площадке и возвращает управление', async kind => {
    const sim = new Simulation(); const road = floor(sim);
    const physics = await RapierPhysics.create(sim.world); sim.setPhysics(physics);
    try {
      const v = new Vehicle(kind, { position: v3(0, 3, 0), waterLevel: -10 }); v.spawn(sim);
      const before = road.data.slice(); let physical = false;
      for (let i = 0; i < 180; i++) {
        v.update(sim, NEUTRAL_INPUT, 1 / 60); physical ||= !v.body.kinematic;
        physics.step(1 / 60); v.afterPhysics();
      }
      expect(physical).toBe(true); expect(v.body.kinematic).toBe(true); expect(v.grounded).toBe(true);
      expect(v.position.y).toBeCloseTo(0.02, 2); expect(road.data).toEqual(before);
      v.update(sim, { ...NEUTRAL_INPUT, throttle: 1 }, 0.1); expect(v.speed).toBeGreaterThan(0);
    } finally { physics.dispose(); }
  });
  it('поднимается по наклонным доскам, наклоняет корпус и сохраняет доски', () => {
    const sim = new Simulation(); floor(sim);
    const ramp = new VoxelShape({ sx: 40, sy: 2, sz: 80, voxelSize: 0.1, grounded: true });
    ramp.fill({}, Mat.Plank); ramp.transform = { position: v3(-2, 0, 0), rotation: quatFromAxisAngle(v3(1, 0, 0), -0.2) };
    sim.world.addBody(new Body({ shapes: [ramp] }));
    const vehicle = new Vehicle('car', { position: v3(0, 0.1, -3), yaw: Math.PI, waterLevel: -10 }); vehicle.spawn(sim);
    const before = ramp.data.slice(); let rise = 0, pitch = 0;
    for (let i = 0; i < 240; i++) {
      vehicle.update(sim, { ...NEUTRAL_INPUT, throttle: 0.15 }, 1 / 60);
      rise = Math.max(rise, vehicle.position.y); pitch = Math.max(pitch, Math.abs(vehicle.pitch));
    }
    expect(rise).toBeGreaterThan(0.7); expect(pitch).toBeGreaterThan(0.1); expect(ramp.data).toEqual(before);
  });

  it('Rapier наклоняет машину при съезде с контейнера и ловит её на тонком покрытии без повреждения пола', async () => {
    const sim = new Simulation(); const road = floor(sim);
    const container = new VoxelShape({ sx: 80, sy: 26, sz: 60, voxelSize: 0.1, grounded: true });
    container.fill({}, Mat.Metal); container.transform.position = v3(-4, 0, -6);
    sim.world.addBody(new Body({ shapes: [container] }));
    const physics = await RapierPhysics.create(sim.world, { coarseAbove: Infinity }); sim.setPhysics(physics);
    try {
      const vehicle = new Vehicle('car', { position: v3(0, 2.62, -3), waterLevel: -10 }); vehicle.spawn(sim);
      const solidPoints = vehicle.body.shapes.flatMap(shape => {
        const points = [];
        for (let i = 0; i < shape.data.length; i++) if (shape.data[i] !== Mat.Air) {
          const p = v3(); shape.coords(i, p);
          points.push({ shape, point: p });
        }
        return points;
      });
      const before = road.data.slice(); let falling = false, tilted = false;
      // Дожидаемся устойчивой посадки после контакта передним краем шин.
      for (let i = 0; i < 420; i++) {
        vehicle.update(sim, { ...NEUTRAL_INPUT, throttle: 0.2 }, 1 / 60);
        physics.step(1 / 60); vehicle.afterPhysics();
        falling ||= !vehicle.body.kinematic;
        tilted ||= Math.abs(rotateVec(vehicle.body.transform.rotation, v3(1, 0, 0)).y) > 0.2;
        if (i % 10 === 0) {
          const lowest = Math.min(...solidPoints.map(({ shape, point }) =>
            shape.voxelCenterWorld(point.x, point.y, point.z, vehicle.body.transform).y));
          expect(lowest).toBeGreaterThan(-0.12);
        }
      }
      expect(falling).toBe(true); expect(tilted).toBe(true); const lowest = Math.min(...solidPoints.map(({ shape, point }) =>
        shape.voxelCenterWorld(point.x, point.y, point.z, vehicle.body.transform).y));
      expect(lowest).toBeLessThan(0.15); expect(Math.abs(vehicle.body.velocity.y)).toBeLessThan(0.5);
      expect(road.data).toEqual(before);
    } finally { physics.dispose(); }
  }, 30_000);
});
