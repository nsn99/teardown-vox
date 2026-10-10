import { describe, expect, it } from 'vitest';
import { Heist, SessionCheckpoint, portLevel } from '@tvox/game';
import { decodeSession, encodeSession } from '../src/session-file.js';
import { sessionKey } from '../src/session-store.js';

describe('перенос сохранения в файл', () => {
  it('сохраняет бесконечный фитиль, typed paint и Set в очереди разрушения', () => {
    const h = new Heist({ level: portLevel, sandbox: true }); h.start();
    try {
      h.charges.restore([{ id: 1, position: { x: 1, y: 1, z: 1 }, blastCenter: { x: 1, y: 1, z: 1 }, radius: 2, power: 1, fuse: Infinity, armed: true }]);
      const save = new SessionCheckpoint(h).capture();
      save.bodies[0].shapes[0].paint = new Uint32Array([1, 0xffaabb]);
      h.sim.destruction.enqueue({ kind: 'sphere', center: { x: 1, y: 1, z: 1 }, radius: .2 },
        { power: 1, damage: 0, instant: true, ignoreBodies: new Set([h.vehicles.get('car')!.body.id]) });
      save.destruction = h.sim.destruction.snapshot();
      const copy = decodeSession(encodeSession(save));
      expect(copy).toEqual(save); expect(copy.charges[0].fuse).toBe(Infinity);
      expect(copy.bodies[0].shapes[0].paint).toBeInstanceOf(Uint32Array);
      expect(copy.destruction[0].opts.ignoreBodies).toBeInstanceOf(Set);
      expect(sessionKey(copy)).not.toBe(sessionKey({ ...copy, sandbox: false }));
      expect(sessionKey(copy)).not.toBe(sessionKey({ ...copy, mapRevision: 'new-map' }));
    } finally { h.sim.dispose(); }
  }, 120_000);
  it('не принимает посторонний файл или неверную версию', () => {
    expect(() => decodeSession('{}')).toThrow();
    expect(() => decodeSession('{"format":"tvox-session","version":2}')).toThrow();
  });
});
