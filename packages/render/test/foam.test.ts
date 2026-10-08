import { expect, it } from 'vitest';
import { v3 } from '@tvox/core';
import { ExtinguisherJet } from '../src/effects.js';
it('пена состоит из движущихся пузырьков, имеет ограниченный пул и исчезает после отпускания', () => {
  const jet=new ExtinguisherJet();
  for(let i=0;i<100;i++){jet.show(v3(0,1,0),v3(0,1,-3));jet.step(.05);}
  expect(jet.mesh.count).toBeGreaterThan(20); expect(jet.mesh.count).toBeLessThanOrEqual(192);
  expect(jet.mesh.visible).toBe(true);
  for(let i=0;i<60;i++)jet.step(.05);
  expect(jet.mesh.count).toBe(0); expect(jet.mesh.visible).toBe(false);
  jet.show(v3(),v3(0,0,-3),false);jet.step(.02);jet.clear();expect(jet.mesh.count).toBe(0);
  jet.mesh.geometry.dispose();jet.mesh.material.dispose();
});
