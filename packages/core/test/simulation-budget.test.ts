import { describe, expect, it, vi } from 'vitest';
import { Simulation } from '@tvox/core';

describe('бюджет симуляции при долгом пожаре', () => {
  it('после дорогого шага отдаёт управление браузеру вместо пяти догоняющих шагов', () => {
    const sim = new Simulation({ frameBudgetMs: 8 });
    const step = vi.spyOn(sim.physics, 'step');
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(12);
    try {
      expect(sim.step(0.1).steps).toBe(1);
      expect(step).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
      sim.dispose();
    }
  });
});
