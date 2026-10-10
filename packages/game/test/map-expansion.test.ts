import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mat, Simulation, Vec3, v3 } from '@tvox/core';
import { CharacterController, EXPANDED_PORT_DOC, PORT_DOC, RING_ROAD, TUNNEL_BRANCH,
  expandedPortLevel, levelFromDoc, overlapsSolid } from '@tvox/game';

describe('расширение карты вокруг сохранённого порта', () => {
  let sim: Simulation;
  beforeAll(() => { sim = new Simulation(); expandedPortLevel.build(sim); }, 120_000);
  afterAll(() => sim.dispose());
  const top = (x: number, z: number) => sim.world.raycast(v3(x, 20, z), v3(0, -1, 0),
    { maxDistance: 40, filter: m => m !== Mat.Water });

  it('точно сохраняет площадку, здания, кран, ворота, цели и наземную технику', () => {
    for (const volume of PORT_DOC.volumes) {
      if (['pier', 'pier-parking-apron'].includes(volume.name)) continue;
      expect(EXPANDED_PORT_DOC.volumes.find(v => v.name === volume.name), volume.name).toEqual(volume);
    }
    expect(EXPANDED_PORT_DOC.volumes.some(v => v.name === 'pier')).toBe(false);
    expect(expandedPortLevel.gates).toEqual(levelFromDoc(PORT_DOC).gates);
    expect(EXPANDED_PORT_DOC.cranes).toEqual(PORT_DOC.cranes);
    expect(EXPANDED_PORT_DOC.mission).toEqual(PORT_DOC.mission);
    expect(EXPANDED_PORT_DOC.vehicles.filter(v => v.kind !== 'boat')).toEqual(PORT_DOC.vehicles.filter(v => v.kind !== 'boat'));
    expect(EXPANDED_PORT_DOC.vehicles.find(v => v.kind === 'boat')!.position).toEqual([112, -0.4, -145]);
  });

  it('весь контур дороги непрерывен, без воды, плотины и стен в габарите грузовика', () => {
    for (let segment = 1; segment < RING_ROAD.length; segment++) {
      const a = RING_ROAD[segment - 1], b = RING_ROAD[segment];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      for (let d = 0; d <= length; d += 4) {
        const p = v3(a.x + (b.x - a.x) * d / length, 2.4, a.z + (b.z - a.z) * d / length);
        const hit = top(p.x, p.z);
        expect(hit?.point.y, JSON.stringify(p)).toBeCloseTo(2.4, 5);
        expect(hit?.material).toBe(Mat.Concrete);
        expect(overlapsSolid(sim.world, { min: v3(p.x - 1.3, 2.45, p.z - 1.3), max: v3(p.x + 1.3, 8, p.z + 1.3) })).toBe(false);
      }
    }
  });

  it('тоннель направлен поперёк дороги и имеет сквозной просвет для техники', () => {
    const junction = TUNNEL_BRANCH[0];
    expect(junction.z).toBe(RING_ROAD[2].z);
    for (let z = -174; z >= -250; z -= 2) {
      expect(top(40, z)?.point.y).toBeGreaterThanOrEqual(2.4);
      expect(overlapsSolid(sim.world, { min: v3(37.5, 2.45, z - 0.5), max: v3(42.5, 9, z + 0.5) }), `z=${z}`).toBe(false);
    }
    expect(top(30, -213)?.point.y).toBeGreaterThan(15);
    expect(expandedPortLevel.mapExits?.[0].enabled).toBe(false);
    expect(expandedPortLevel.mapExits?.[0].center.z).toBeLessThan(-240);
  });

  function walk(points: Vec3[], seconds: number): void {
    const player = new CharacterController({ position: points[0] });
    let elapsed = 0;
    for (const goal of points.slice(1)) {
      while (Math.hypot(player.position.x - goal.x, player.position.z - goal.z) > 0.5 && elapsed < seconds) {
        const yaw = Math.atan2(-(goal.x - player.position.x), -(goal.z - player.position.z));
        player.update(sim.world, { forward: 1, right: 0, jump: false, sprint: true, crouch: false }, yaw, 1 / 30);
        elapsed += 1 / 30;
      }
      expect(Math.hypot(player.position.x - goal.x, player.position.z - goal.z), JSON.stringify(player.position)).toBeLessThan(0.6);
    }
  }
  it('выход из существующих ворот и спуск на дальний причал проходятся без прыжков', () => {
    walk([v3(45, 0.05, 61), v3(45, 2.4, 85)], 10);
    walk([v3(102, 2.45, -169), v3(102, 0.4, -141)], 12);
  });

  it('документ карты сохраняет описание ГЭС и будущего выхода', () => {
    const imported = levelFromDoc(JSON.parse(JSON.stringify(EXPANDED_PORT_DOC)));
    expect(imported.hydro).toEqual(expandedPortLevel.hydro);
    expect(imported.mapExits).toEqual(expandedPortLevel.mapExits);
    expect(imported.revision).toBe(expandedPortLevel.revision);
  });
});
