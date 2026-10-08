import { describe, expect, it } from 'vitest';
import { Body, Mat, Simulation, VoxelShape, v3 } from '@tvox/core';
import { CharacterController, DEFAULT_INPUT, Heist, NEUTRAL_INPUT, Vehicle, portLevel } from '@tvox/game';
import { overlapsSolid } from '../src/character.js';
import { addWater, roadSim } from './helpers/vehicle-world.js';

describe('управление техникой и проходы', () => {
  it.each(['car', 'pickup', 'truck', 'bulldozer', 'excavator', 'boat'] as const)('%s соблюдает выбранный предел скорости вперёд и назад', kind => {
    const sim = kind === 'boat' ? new Simulation() : roadSim();
    if (kind === 'boat') addWater(sim, v3(-20, -3, -100), v3(40, 3, 140));
    const v = new Vehicle(kind, { position: v3(0, kind === 'boat' ? 0 : .1, 0), waterLevel: kind === 'boat' ? 0 : -10 });
    v.spawn(sim); v.speedLimit = .4;
    try {
      for (const direction of [1, -1]) {
        for (let i = 0; i < 240; i++) v.update(sim, { ...NEUTRAL_INPUT, throttle: direction }, 1 / 60);
        expect(v.speed).toBeCloseTo(direction * (direction > 0 ? v.spec.maxSpeed : v.spec.reverseSpeed) * .4, 5);
      }
    } finally { sim.dispose(); }
  });

  it('видимый ковш поднимается и опускается; автоматически режет на выбранной высоте и сохраняет дорогу', () => {
    const sim = roadSim();
    const v = new Vehicle('bulldozer', { position: v3(0, .1, 0), waterLevel: -10 }); v.spawn(sim);
    const road = [...sim.world.bodies.values()][0].shapes[0], before = road.data.slice();
    try {
      for (let i = 0; i < 120; i++) v.update(sim, { ...NEUTRAL_INPUT, bladeLift: 1 }, 1 / 60);
      expect(v.bladeHeight).toBeCloseTo(1.6); expect(v.bladeShape!.transform.position.y).toBeCloseTo(1.6);
      const wall = new VoxelShape({ sx: 20, sy: 35, sz: 2, voxelSize: .1, grounded: true });
      wall.fill({}, Mat.Metal); wall.transform.position = v3(-1, 0, -4.4);
      sim.world.addBody(new Body({ shapes: [wall] }));
      v.update(sim, { ...NEUTRAL_INPUT, throttle: .1 }, 1 / 60);
      expect(wall.get(10, 5, 0)).toBe(Mat.Metal); expect(wall.solidVoxels).toBeLessThan(1400);
      for (let i = 0; i < 120; i++) v.update(sim, { ...NEUTRAL_INPUT, bladeLift: -1 }, 1 / 60);
      expect(v.bladeHeight).toBe(0); expect(v.bladeShape!.transform.position.y).toBe(0);
      expect(wall.get(10, 5, 0)).toBe(Mat.Air); expect(road.data).toEqual(before);
    } finally { sim.dispose(); }
  });

  it('персонаж проходит в офис и обратно без прыжка и приседания', () => {
    const h = new Heist({ level: portLevel, sandbox: true }); h.start();
    const c = new CharacterController({ position: v3(35, .02, 12) });
    try {
      for (let i = 0; i < 70; i++) c.update(h.sim.world, { ...DEFAULT_INPUT, forward: 1 }, Math.PI, 1 / 60);
      expect(c.position.z).toBeGreaterThan(15); expect(overlapsSolid(h.sim.world, c.aabbAt(c.position))).toBe(false);
      for (let i = 0; i < 70; i++) c.update(h.sim.world, { ...DEFAULT_INPUT, forward: 1 }, 0, 1 / 60);
      expect(c.position.z).toBeLessThan(14); expect(overlapsSolid(h.sim.world, c.aabbAt(c.position))).toBe(false);
    } finally { h.sim.dispose(); }
  });
});
