import { expect, it } from 'vitest';
import { Body, Mat, Simulation, VoxelShape, v3 } from '@tvox/core';
import { Inventory, InventoryState, useTool } from '@tvox/game';

function scene() {
  const sim = new Simulation(), inventory = new Inventory({ active: 'flamethrower' });
  const wall = (z: number, material: Mat) => {
    const s = new VoxelShape({ sx: 20, sy: 20, sz: 1, voxelSize: 0.1 });
    s.fill({}, material); s.structural = false; s.transform.position = v3(-1, 0, z);
    const b = new Body({ kind: 'static', shapes: [s] }); sim.world.addBody(b); return { s, b };
  };
  const ctx = { sim, inventory, origin: v3(0, 1, 0), direction: v3(0, 0, -1), rng: () => 0.5 };
  const fire = (seconds: number) => {
    for (let t = 0; t < seconds; t += 0.05) { useTool(ctx); inventory.tick(0.05); sim.fire.step(sim.world, 0.05); }
  };
  return { sim, inventory, wall, ctx, fire };
}

it('расходует топливо при стрельбе в воздух и учитывает откат', () => {
  const f = scene();
  try {
    expect(useTool(f.ctx)).toMatchObject({ used: true, tool: 'flamethrower', heated: 0 });
    expect(f.inventory.ammo('flamethrower')).toBe(399);
    expect(useTool(f.ctx)).toMatchObject({ used: false, reason: 'cooldown' });
    expect(f.inventory.ammo('flamethrower')).toBe(399);
  } finally { f.sim.dispose(); }
});

it('поджигает видимую древесину и останавливается перед непрозрачной стеной', () => {
  const f = scene();
  try {
    const shield = f.wall(-1, Mat.Metal), wood = f.wall(-2, Mat.Wood);
    f.fire(2); expect(f.sim.fire.burningCount).toBe(0);
    expect(f.sim.fire.temperature(wood.s, wood.s.idx(10, 10, 0))).toBe(20);
    f.sim.world.removeBody(shield.b);
    f.fire(2); expect(f.sim.fire.burningCount).toBeGreaterThan(0);
  } finally { f.sim.dispose(); }
});

it('учитывает защиту цели и игнорируемую технику', () => {
  const f = scene();
  try {
    const shield = f.wall(-1, Mat.Metal), wood = f.wall(-2, Mat.Wood);
    const result = useTool({ ...f.ctx, ignoreBodies: new Set([shield.b.id]), protect: new Set([Mat.Wood]) });
    expect(result.heated).toBe(0); expect(f.sim.fire.snapshot()).toHaveLength(0);
    f.inventory.tick(0.1);
    expect(useTool({ ...f.ctx, ignoreBodies: new Set([shield.b.id]) }).heated).toBeGreaterThan(0);
    expect(wood.s.solidVoxels).toBe(400);
  } finally { f.sim.dispose(); }
});

it('старое сохранение инвентаря получает рабочий восьмой слот', () => {
  const inv = new Inventory(), old = inv.snapshot();
  for (const key of ['tiers', 'ammo', 'cooldown'] as const) delete (old[key] as Partial<InventoryState[typeof key]>).flamethrower;
  inv.restore(old); expect(inv.selectSlot(8)).toBe(true); expect(inv.canUse()).toBe(true);
  expect(inv.consume()).toBe(true); expect(inv.ammo('flamethrower')).toBe(399);
});

it('оплавление пластика возвращает точки для падающих капель', () => {
  const f = scene();
  try {
    const plastic = f.wall(-2, Mat.Plastic);
    let drops = 0;
    for (let i = 0; i < 30; i++) {
      const res = useTool(f.ctx); drops += res.meltPoints?.length ?? 0;
      f.inventory.tick(0.05); f.sim.fire.step(f.sim.world, 0.05);
    }
    expect(drops).toBeGreaterThan(0); expect(plastic.s.solidVoxels).toBeLessThan(400);
  } finally { f.sim.dispose(); }
});
