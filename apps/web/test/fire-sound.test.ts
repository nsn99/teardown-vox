import { expect, it } from 'vitest';
import { fireSoundSamples } from '../src/fire-sound.js';

it('треск горения и струя имеют разные сигналы без клиппинга и щелчка на стыке', () => {
  const fire = fireSoundSamples(12000, 2), jet = fireSoundSamples(12000, 2, true);
  for (const samples of [fire, jet]) {
    expect(samples).toHaveLength(24000);
    expect(samples[0]).toBe(0); expect(Math.abs(samples.at(-1)!)).toBe(0);
    expect(samples.every(x => Number.isFinite(x) && Math.abs(x) <= 1)).toBe(true);
    expect(samples.some(x => Math.abs(x) > .2)).toBe(true);
  }
  const energy = (samples: Float32Array) => samples.reduce((n, x) => n + x * x, 0) / samples.length;
  expect(energy(jet)).toBeGreaterThan(energy(fire) * 2);
});
