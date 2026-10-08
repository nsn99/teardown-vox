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

it('горизонтальный обзор в машине не сбрасывается, включая полный оборот', () => {
  const h=new Heist({level:portLevel,sandbox:true}); h.start();
  try {
    const v=h.vehicles.get('car')!; h.character.teleport({...v.position}); h.toggleVehicle();
    h.yaw=v.yaw+Math.PI*2+.7; h.pitch=.3;
    h.update(1/60,DEFAULT_INPUT,NEUTRAL_INPUT);
    expect(h.yaw-v.yaw).toBeCloseTo(Math.PI*2+.7,5); expect(h.pitch).toBe(.3);
    h.update(1/60,DEFAULT_INPUT,{...NEUTRAL_INPUT,throttle:.5,steer:1});
    expect(h.yaw-v.yaw).toBeCloseTo(Math.PI*2+.7,5);
  } finally {h.sim.dispose();}
});

it('гараж — общий свободный зал с резервным рядом; над катером нет навеса', () => {
  const h=new Heist({level:portLevel,sandbox:true}); h.start();
  try {
    const garage=[...h.sim.world.bodies.values()].find(b=>b.shapes.some(s=>s.name==='vehicle-garage'))!;
    expect(garage).toBeDefined();
    expect([...h.sim.world.bodies.values()].some(b=>b.name==='boat-shelter')).toBe(false);
    // Full-width aisle, including all former partitions, and five empty front parking spaces.
    expect(overlapsSolid(h.sim.world,{min:v3(50.7,.25,49),max:v3(73.3,4.5,50.8)})).toBe(false);
    for(const x of [52.4,57.2,62,66.8,71.6])
      expect(overlapsSolid(h.sim.world,{min:v3(x-1,.1,43),max:v3(x+1,3,47.8)})).toBe(false);
  } finally {h.sim.dispose();}
});

it('телескопические тяги соединяют корпус и поднятый ковш бульдозера', () => {
  const sim=roadSim();const v=new Vehicle('bulldozer',{position:v3(0,.1,0),waterLevel:-10});v.spawn(sim);
  try {
    expect(v.bladeLinks).toHaveLength(4);
    for(let i=0;i<120;i++)v.update(sim,{...NEUTRAL_INPUT,bladeLift:1},1/60);
    for(let side=0;side<2;side++){
      const outer=v.bladeLinks[side*2].localAabb(),inner=v.bladeLinks[side*2+1].localAabb();
      expect(inner.min.x).toBeLessThan(outer.max.x);expect(inner.min.y).toBeLessThan(outer.max.y);
      expect(inner.max.y).toBeGreaterThan(v.bladeHeight+.5);expect(outer.min.y).toBeLessThan(.8);
    }
  } finally{sim.dispose();}
});
