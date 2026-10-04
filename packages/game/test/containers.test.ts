import { describe, expect, it } from 'vitest';
import { Body, Mat, Simulation, v3 } from '@tvox/core';
import { PORT_DOC, buildVolume } from '@tvox/game';

const doc = PORT_DOC.volumes.find(v => v.name === 'containers')!;
const placements = [[0, 0], [60, 0], [120, 0], [0, 26], [60, 26]];

describe('детали портовых контейнеров', () => {
  it('пять контейнеров различаются цветом и сохраняют полые металлические корпуса', () => {
    const shape = buildVolume(doc, PORT_DOC.voxelSize);
    const colors = placements.map(([x, y]) => {
      expect(shape.get(x + 29, y + 13, 15)).toBe(Mat.Air);
      expect(shape.get(x + 29, y + 25, 15)).toBe(Mat.Metal);
      expect(shape.get(x + 10, y + 10, 28)).toBe(Mat.Metal);
      return shape.paint.get(shape.idx(x + 10, y + 10, 28));
    });
    expect(new Set(colors).size).toBe(5);
    expect(colors.every(color => color !== undefined && color >= 0x1000000)).toBe(true);
    expect([...shape.data].every(m => m === Mat.Air || m === Mat.Metal)).toBe(true);
    expect(shape.sx).toBe(180);
    expect(shape.sy).toBe(52);
    expect(shape.sz).toBe(30);
    expect(doc.position).toEqual([4, 0, 31.2]);
  });

  it('рёбра имеют настоящий рельеф, а крыша под сумкой остаётся плоской', () => {
    const shape = buildVolume(doc, PORT_DOC.voxelSize);
    const sim = new Simulation();
    sim.world.addBody(new Body({ kind: 'static', shapes: [shape] }));
    const side = (localX: number) => sim.world.raycast(
      v3(4 + localX * 0.1 + 0.05, 1.3, 36), v3(0, 0, -1), { maxDistance: 8 },
    )!;
    expect(side(4).point.z - side(6).point.z).toBeCloseTo(0.1, 5);
    const cash = PORT_DOC.mission.targets.find(t => t.id === 'cash')!;
    const roof = sim.world.raycast(v3(cash.position[0], 3.5, cash.position[2]), v3(0, -1, 0), { maxDistance: 2 });
    expect(roof).not.toBeNull();
    expect(roof!.point.y).toBeCloseTo(2.6, 5);
  });
});
