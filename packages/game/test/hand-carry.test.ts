import { describe, expect, it } from 'vitest';
import { Body, Mat, Simulation, mergeIntoField, VoxelShape, v3 } from '@tvox/core';
import { HandCarry, CharacterController } from '@tvox/game';
import { overlapsSolid } from '../src/character.js';

function object(sim: Simulation, mat = Mat.Wood, size = [4, 4, 4], at = v3(-.2, .9, -1.4)) {
  const shape = new VoxelShape({ sx: size[0], sy: size[1], sz: size[2], voxelSize: .1 });
  shape.fill({}, mat);
  const b = new Body({ kind: 'dynamic', shapes: [shape] }); b.transform.position = at;
  sim.world.addBody(b); return b;
}
const eye = v3(0, 1.2, 0), dir = v3(0, 0, -1);
describe('переноска рукой', () => {
  it('берёт свободный предмет, переносит и возвращает физику после отпускания', () => {
    const sim = new Simulation(), hand = new HandCarry();
    try {
      const b = object(sim, Mat.Wood, [3, 3, 3]);
      expect(hand.pick(sim, eye, dir)).toBe(true); expect(b.kinematic).toBe(true);
      const before = b.transform.position.x;
      hand.update(sim, v3(.5, 1.2, 0), dir, new CharacterController({position: v3(.5, 0, 0)}).aabbAt(v3(.5, 0, 0)));
      expect(b.transform.position.x).toBeGreaterThan(before);
      expect(hand.drop(sim)).toBe(b); expect(b.kinematic).toBe(false); expect(b.sleeping).toBe(false);
      const y = b.transform.position.y; for (let i=0;i<30;i++) sim.step(1/60);
      expect(b.transform.position.y).toBeLessThan(y);
    } finally { sim.dispose(); }
  });
  it.each(['mass','size','anchor','attached','vehicle'] as const)('не позволяет поднять: %s', reason => {
    const sim = new Simulation(), hand = new HandCarry();
    try {
      const b = object(sim, reason === 'mass' ? Mat.Metal : Mat.Wood, reason === 'size' ? [30,1,1] : [4,4,4], reason==='size'?v3(-1.5,1.15,-1.4):undefined);
      if(reason==='anchor') b.shapes[0].grounded = true;
      if(reason==='attached') b.shapes[0].attachments.set(0,{bodyId:999,shapeId:999,index:0});
      if(reason==='vehicle') b.tags.add('vehicle');
      expect(hand.pick(sim, eye, dir)).toBe(false); expect(hand.body).toBeNull();
    } finally { sim.dispose(); }
  });
  it('предмет упирается в тонкую стену при резком развороте камеры', () => {
    const sim = new Simulation(), hand = new HandCarry();
    try {
      const b = object(sim, Mat.Wood, [3,3,3]); expect(hand.pick(sim, eye, dir)).toBe(true);
      const wall=object(sim,Mat.Concrete,[1,30,30],v3(.4,0,-2)); wall.kind='static'; wall.shapes[0].grounded=true;
      hand.update(sim,eye,v3(1,0,0),new CharacterController().aabbAt(v3(0,0,0)));
      expect(b.aabb().max.x).toBeLessThanOrEqual(.401);
      expect(overlapsSolid(sim.world,b.aabb(),new Set([b.id]))).toBe(false);
      const old=hand.snapshot(), other=new HandCarry(); other.restore(old,new Map([[b.id,b]])); expect(other.body).toBe(b);
      hand.drop(sim);
    } finally { sim.dispose(); }
  });
});

it('достаёт небольшой замороженный обломок из общей свалки, не двигая остальные', () => {
  const sim=new Simulation(),hand=new HandCarry();
  try {
    const b=object(sim,Mat.Wood,[3,3,3]),shape=b.shapes[0];
    const field=mergeIntoField(sim.world,b);
    const other=object(sim,Mat.Wood,[3,3,3],v3(3,1,-1));mergeIntoField(sim.world,other);
    expect(hand.pick(sim,eye,dir)).toBe(true);expect(hand.body!.shapes[0]).toBe(shape);
    expect(field.shapes).toHaveLength(1);expect(hand.body!.passive).toBe(false);
    hand.drop(sim);
  }finally{sim.dispose();}
});
