import { expect, it } from 'vitest';
import { v3 } from '@tvox/core';
import { SurfaceFlames } from '../src/surface-flames.js';

it('показывает отдельные очаги, объединяет соседние и убирает потушенные', () => {
  const flames = new SurfaceFlames(3);
  try {
    flames.update([0, .01, 1, 20].map(x => ({ position: v3(x, 0, 0), heat: 1 })), 1);
    expect(flames.mesh.count).toBe(6);
    flames.update([{ position: v3(20, 0, 0), heat: .2 }], 2); expect(flames.mesh.count).toBe(2);
    flames.update([], 3); expect(flames.mesh.count).toBe(0);
    flames.update(Array.from({ length: 50 }, (_, x) => ({ position: v3(x, 0, 0), heat: 1 })), 4);
    expect(flames.mesh.count).toBe(6); flames.clear(); expect(flames.mesh.count).toBe(0);
  } finally { flames.mesh.geometry.dispose(); (flames.mesh.material as { dispose(): void }).dispose(); }
});
