import { expect, it } from 'vitest';
import { v3 } from '@tvox/core';
import { FlameJet } from '../src/effects.js';
it('струя имеет ограниченный пул, гасит свет и исчезает после отпускания', () => {
  const jet = new FlameJet();
  try {
    for (let i = 0; i < 100; i++) { jet.show(v3(0, 1, 0), v3(0, 1, -6), true); jet.step(0.05); }
    expect(jet.mesh.count).toBeGreaterThan(30); expect(jet.mesh.count).toBeLessThanOrEqual(192);
    expect(jet.active).toBe(true); expect(jet.light.intensity).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) jet.step(0.05);
    expect(jet.active).toBe(false); expect(jet.mesh.count).toBe(0); expect(jet.light.intensity).toBe(0);
    jet.show(v3(), v3(0, 4, 0)); jet.step(0.02); jet.clear(); expect(jet.mesh.visible).toBe(false);
  } finally { jet.mesh.geometry.dispose(); jet.mesh.material.dispose(); }
});
