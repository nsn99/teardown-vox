import { describe, expect, it } from 'vitest';
import { MovingTracks, trackShoeAt } from '../src/vehicle-tracks.js';
import { Matrix4, Vector3 } from 'three';

const track = { center: { x: -0.35, y: 0.4, z: 1.25 }, radius: 0.4, halfStraight: 1.95, width: 0.7, travel: 0 };
describe('замкнутая визуальная гусеница', () => {
  it('не скачет на стыках прямых и дуг и движется назад на нижней стороне', () => {
    const straight = track.halfStraight * 2, curve = Math.PI * track.radius;
    const perimeter = 2 * (straight + curve);
    for (const join of [0, straight, straight + curve, 2 * straight + curve, perimeter]) {
      const a = trackShoeAt(track, join - 1e-6), b = trackShoeAt(track, join + 1e-6);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(3e-6);
    }
    const top = trackShoeAt(track, 1), topMoved = trackShoeAt(track, 1.2);
    const bottom = trackShoeAt(track, straight + curve + 1), bottomMoved = trackShoeAt(track, straight + curve + 1.2);
    expect(topMoved.x - top.x).toBeCloseTo(0.2); expect(bottomMoved.x - bottom.x).toBeCloseTo(-0.2);
  });
  it('движение меняет позиции звеньев, остановка сохраняет их, повреждённая лента скрывается', () => {
    const moving = new MovingTracks([track]);
    const mesh = moving.group.children[0] as import('three').InstancedMesh;
    const a = new Matrix4(), b = new Matrix4(); mesh.getMatrixAt(0, a);
    moving.update([{ ...track, travel: 0.6 }]); mesh.getMatrixAt(0, b);
    expect(new Vector3().setFromMatrixPosition(a).distanceTo(new Vector3().setFromMatrixPosition(b))).toBeGreaterThan(0.4);
    const after = b.clone(); moving.update([{ ...track, travel: 0.6, visible: false }]); mesh.getMatrixAt(0, b);
    expect(b.equals(after)).toBe(true); expect(mesh.visible).toBe(false); moving.dispose();
  });
});
