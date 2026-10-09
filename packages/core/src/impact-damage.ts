import { Body } from './body.js';
import { Vec3, clamp } from './math.js';
import { Mat, material } from './materials.js';
import { VoxelShape } from './voxel-shape.js';
import { bodySolidBounds } from './solid-contact.js';

/** Игровая модель удара: энергия задаёт силу, объём ограничивает область контакта. */
export function impactDamage(body: Body, speedDrop: number, scale = 0.0016): { radius: number; power: number } {
  const volume = body.shapes.reduce((sum, shape) => sum + shape.solidVoxels * shape.voxelSize ** 3, 0);
  const energy = 0.5 * body.mass() * Math.max(0, speedDrop) ** 2 * Math.max(0, scale / 0.0016);
  const bounds = bodySolidBounds(body);
  const footprint = Math.hypot(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) / 2;
  const sizeRadius = 0.06 + Math.max(Math.cbrt(volume) * 0.8, Number.isFinite(footprint) ? footprint * 0.95 : 0) + Math.cbrt(volume) * 0.3;
  const energyRadius = 0.06 + 0.45 * (energy / 2500) ** 0.28;
  const area = Math.max(0.01, volume ** (2 / 3));
  const energyFraction = energy / (energy + area * 50000);
  return { radius: Math.max(0.04, Math.min(3, sizeRadius, energyRadius) * (0.35 + 0.65 * energyFraction)),
    power: clamp(0.1 + 0.35 * Math.sqrt(energy / (area * 180000)), 0.1, 1.1) };
}

/** Contact dents have a finite excavation budget. Small debris cannot dig a pit. */
export function impactContact(body: Body, speed: number, point: Vec3, other?: Body | null) {
  const volume = body.shapes.reduce((n, s) => n + s.solidVoxels * s.voxelSize ** 3, 0);
  const energy = .5 * body.mass() * speed ** 2;
  let remaining = Math.min(volume * .25, energy / 1_000_000);
  const depth = Math.min(.3, Math.cbrt(volume) * .15, energy / 500_000);
  return (shape: VoxelShape, target: Body, x: number, y: number, z: number): boolean => {
    // A contact is not an explosion: neighbouring, untouched bodies are excluded.
    if (target !== body && target !== other) return false;
    if (target === body) return true;
    const mat = shape.get(x, y, z);
    if (speed < 4 && material(mat).toughness >= .3) return false;
    const ground = target.kind === 'static' && !shape.structural &&
      (mat === Mat.Dirt || mat === Mat.Concrete || mat === Mat.Rock);
    if (!ground) return true;
    if (energy < 300 || (mat !== Mat.Dirt && energy < 20_000)) return false;
    const cellVolume = shape.voxelSize ** 3;
    if (remaining < cellVolume || shape.voxelCenterWorld(x, y, z, target.transform).y < point.y - depth) return false;
    remaining -= cellVolume;
    return true;
  };
}
