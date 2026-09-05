import { Body, Mat, Simulation, VoxelShape, VoxelWorld, v3 } from '@tvox/core';

export const VS = 0.1;

export function makeShape(sx: number, sy: number, sz: number, grounded = true): VoxelShape {
  return new VoxelShape({ sx, sy, sz, voxelSize: VS, grounded });
}

export function staticBody(shapes: VoxelShape[], name = 'level'): Body {
  return new Body({ kind: 'static', shapes, name, tags: ['level'] });
}

export function worldWith(...shapes: VoxelShape[]): { world: VoxelWorld; body: Body } {
  const world = new VoxelWorld();
  const body = staticBody(shapes);
  world.addBody(body);
  return { world, body };
}

export function simWith(...shapes: VoxelShape[]): { sim: Simulation; body: Body } {
  const sim = new Simulation({ structure: { stress: true } });
  const body = staticBody(shapes);
  sim.world.addBody(body);
  return { sim, body };
}

/** Прямоугольная колонна материала mat. */
export function column(
  shape: VoxelShape,
  x: number,
  z: number,
  y0: number,
  y1: number,
  mat: Mat,
  w = 1,
  d = 1,
): void {
  shape.fill({ x0: x, x1: x + w, y0, y1, z0: z, z1: z + d }, mat);
}

export function countMaterial(shape: VoxelShape, mat: Mat): number {
  let n = 0;
  for (let i = 0; i < shape.data.length; i++) if (shape.data[i] === mat) n++;
  return n;
}

export const worldPos = (x: number, y: number, z: number) => v3(x * VS, y * VS, z * VS);

/** Центр вокселя (vx,vy,vz) в мире для формы с единичным трансформом. */
export const voxelCenter = (vx: number, vy: number, vz: number) =>
  v3((vx + 0.5) * VS, (vy + 0.5) * VS, (vz + 0.5) * VS);
