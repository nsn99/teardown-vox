import { describe, expect, it } from 'vitest';
import { Body, FireSystem, Mat, VoxelShape, VoxelWorld, v3 } from '@tvox/core';
import { AudioDirector, SoundCue, soundOfMaterial } from '@tvox/game';

/**
 * Звук проверяется не ухом, а правилами: что звучит, как громко и на
 * каком расстоянии. Синтез живёт в приложении, здесь — решения.
 */

const LISTENER = v3(0, 0, 0);

it('звук пожара прекращается после тушения и не переносится в новый мир', () => {
  const { world: w } = chunk(Mat.Wood);
  const fire = new FireSystem();
  const audio = new AudioDirector();
  audio.listen(w, () => fire.burningCount);
  fire.igniteArea(w, v3(0, 0, 0), 2);
  expect(audio.update(1 / 60, LISTENER).some(c => c.id === 'fire')).toBe(true);
  fire.extinguish(w, v3(0, 0, 0), 2, 2);
  expect(audio.update(1 / 60, LISTENER).some(c => c.id === 'fire')).toBe(false);
  fire.step(w, 7);
  fire.igniteArea(w, v3(0, 0, 0), 2);
  audio.dispose();
  audio.listen(new VoxelWorld());
  expect(audio.update(1 / 60, LISTENER)).toEqual([]);
});

function world(): VoxelWorld {
  return new VoxelWorld();
}

/** Кусок формы, который можно «разрушить» ради события. */
function chunk(mat: Mat, size = 4): { world: VoxelWorld; body: Body; shape: VoxelShape } {
  const w = world();
  const shape = new VoxelShape({ sx: size, sy: size, sz: size, voxelSize: 0.1 });
  shape.fill({ x0: 0, y0: 0, z0: 0, x1: size, y1: size, z1: size }, mat);
  const body = new Body({ kind: 'static', shapes: [shape], name: 'кусок' });
  w.addBody(body);
  return { world: w, body, shape };
}

function removeEvent(w: VoxelWorld, body: Body, shape: VoxelShape, mat: Mat, count: number, at = v3(0, 0, 0)) {
  w.events.emit('voxels:removed', {
    body,
    shape,
    count,
    center: at,
    materials: new Map([[mat, count]]),
    cause: 'sledge',
  });
}

function firstOf(cues: SoundCue[], id: string): SoundCue | undefined {
  return cues.find((c) => c.id === id);
}

describe('звук разрушения', () => {
  it('дерево, кирпич, сталь и стекло звучат по-разному', () => {
    expect(soundOfMaterial(Mat.Wood)).toBe('hit-wood');
    expect(soundOfMaterial(Mat.Brick)).toBe('hit-stone');
    expect(soundOfMaterial(Mat.Concrete)).toBe('hit-stone');
    expect(soundOfMaterial(Mat.Metal)).toBe('hit-metal');
    expect(soundOfMaterial(Mat.HeavyMetal)).toBe('hit-metal');
    expect(soundOfMaterial(Mat.Glass)).toBe('hit-glass');

    const ids = new Set(
      [Mat.Wood, Mat.Brick, Mat.Metal, Mat.Glass].map((m) => soundOfMaterial(m)),
    );
    expect(ids.size).toBe(4);
  });

  it('удар по материалу выдаёт его звук', () => {
    const { world: w, body, shape } = chunk(Mat.Metal);
    const audio = new AudioDirector();
    audio.listen(w);

    removeEvent(w, body, shape, Mat.Metal, 6);
    const cues = audio.update(1 / 60, LISTENER);

    expect(cues.map((c) => c.id)).toContain('hit-metal');
  });

  it('звучит преобладающий материал порции, а не первый попавшийся', () => {
    const { world: w, body, shape } = chunk(Mat.Glass);
    const audio = new AudioDirector();
    audio.listen(w);

    w.events.emit('voxels:removed', {
      body,
      shape,
      count: 30,
      center: v3(0, 0, 0),
      materials: new Map([
        [Mat.Glass, 2],
        [Mat.Concrete, 28],
      ]),
      cause: 'sledge',
    });

    expect(audio.update(1 / 60, LISTENER).map((c) => c.id)).toContain('hit-stone');
  });

  it('взрыв звучит взрывом, а не ударом по материалу', () => {
    const { world: w, body, shape } = chunk(Mat.Brick);
    const audio = new AudioDirector();
    audio.listen(w);

    w.events.emit('voxels:removed', {
      body,
      shape,
      count: 900,
      center: v3(0, 0, 0),
      materials: new Map([[Mat.Brick, 900]]),
      cause: 'explosive',
    });

    expect(audio.update(1 / 60, LISTENER).map((c) => c.id)).toContain('explosion');
  });

  it('громкость растёт с числом снятых вокселей', () => {
    const quiet = (count: number): number => {
      const { world: w, body, shape } = chunk(Mat.Brick);
      const audio = new AudioDirector();
      audio.listen(w);
      removeEvent(w, body, shape, Mat.Brick, count);
      return firstOf(audio.update(1 / 60, LISTENER), 'hit-stone')?.gain ?? 0;
    };
    expect(quiet(400)).toBeGreaterThan(quiet(3));
  });

  it('дальний звук тише ближнего, а слишком дальний не звучит вовсе', () => {
    const at = (d: number): number => {
      const { world: w, body, shape } = chunk(Mat.Brick);
      const audio = new AudioDirector();
      audio.listen(w);
      removeEvent(w, body, shape, Mat.Brick, 40, v3(d, 0, 0));
      return firstOf(audio.update(1 / 60, LISTENER), 'hit-stone')?.gain ?? 0;
    };
    const near = at(2);
    const far = at(30);
    expect(far).toBeLessThan(near);
    expect(at(500)).toBe(0);
  });
});

describe('обрушение и тревога', () => {
  it('обрушение звучит соразмерно массе', () => {
    const collapse = (voxels: number): number => {
      const w = world();
      const audio = new AudioDirector();
      audio.listen(w);
      const shape = new VoxelShape({ sx: voxels, sy: 1, sz: 1, voxelSize: 0.1 });
      shape.fill({}, Mat.Concrete);
      const frag = new Body({ kind: 'dynamic', shapes: [shape], name: 'обломок' });
      w.events.emit('body:split', {
        source: frag,
        fragments: [frag],
        reason: 'disconnected',
      });
      return firstOf(audio.update(1 / 60, LISTENER), 'collapse')?.gain ?? 0;
    };
    expect(collapse(400)).toBeGreaterThan(collapse(4));
  });

  it('сирена слышна отовсюду и нарастает к концу таймера', () => {
    const audio = new AudioDirector();
    const at = (timeLeft: number): SoundCue =>
      audio.update(1 / 60, v3(500, 0, 500), {
        alarmActive: true,
        timeLeft,
        alarmSeconds: 60,
      }).find((c) => c.id === 'siren')!;

    const start = at(59);
    const end = at(3);

    // Позиции нет — расстояние на сирену не влияет.
    expect(start.at).toBeNull();
    expect(start.loop).toBe(true);
    expect(end.gain).toBeGreaterThan(start.gain);
    expect(end.pitch).toBeGreaterThan(start.pitch);
  });

  it('без тревоги сирены нет', () => {
    const audio = new AudioDirector();
    const cues = audio.update(1 / 60, LISTENER, {
      alarmActive: false,
      timeLeft: 60,
      alarmSeconds: 60,
    });
    expect(cues.find((c) => c.id === 'siren')).toBeUndefined();
  });

  it('огонь звучит, пока горит, и тем громче, чем больше очагов', () => {
    const w = world();
    const audio = new AudioDirector();
    audio.listen(w);
    const shape = new VoxelShape({ sx: 2, sy: 2, sz: 2, voxelSize: 0.1 });
    const body = new Body({ kind: 'static', shapes: [shape], name: 'дрова' });

    const ignite = (n: number) => {
      for (let i = 0; i < n; i++) {
        w.events.emit('fire:ignited', { body, shape, index: i, point: v3(0, 0, 0) });
      }
    };

    ignite(1);
    const small = firstOf(audio.update(1 / 60, LISTENER), 'fire')!.gain;
    ignite(60);
    const big = firstOf(audio.update(1 / 60, LISTENER), 'fire')!.gain;
    expect(big).toBeGreaterThan(small);

    for (let i = 0; i < 61; i++) {
      w.events.emit('fire:burnedOut', { body, shape, index: i });
    }
    expect(firstOf(audio.update(1 / 60, LISTENER), 'fire')).toBeUndefined();
  });
});

describe('дисциплина звука', () => {
  it('один и тот же звук не повторяется чаще кулдауна', () => {
    const { world: w, body, shape } = chunk(Mat.Brick);
    const audio = new AudioDirector({ cooldown: 0.2 });
    audio.listen(w);

    removeEvent(w, body, shape, Mat.Brick, 10);
    expect(audio.update(1 / 60, LISTENER)).toHaveLength(1);

    removeEvent(w, body, shape, Mat.Brick, 10);
    expect(audio.update(1 / 60, LISTENER)).toHaveLength(0);

    // Прошёл кулдаун — снова звучит.
    audio.update(0.25, LISTENER);
    removeEvent(w, body, shape, Mat.Brick, 10);
    expect(audio.update(1 / 60, LISTENER)).toHaveLength(1);
  });

  it('за кадр выпускается не больше положенного', () => {
    const { world: w, body, shape } = chunk(Mat.Brick);
    const audio = new AudioDirector({ maxPerFrame: 2, cooldown: 0 });
    audio.listen(w);

    for (const m of [Mat.Brick, Mat.Wood, Mat.Metal, Mat.Glass]) {
      removeEvent(w, body, shape, m, 20);
    }
    expect(audio.update(1 / 60, LISTENER).length).toBeLessThanOrEqual(2);
  });

  it('одна кнопка выключает всё', () => {
    const { world: w, body, shape } = chunk(Mat.Brick);
    const audio = new AudioDirector();
    audio.listen(w);

    expect(audio.toggleMute()).toBe(true);
    expect(audio.muted).toBe(true);

    removeEvent(w, body, shape, Mat.Brick, 50);
    expect(
      audio.update(1 / 60, LISTENER, { alarmActive: true, timeLeft: 5, alarmSeconds: 60 }),
    ).toHaveLength(0);

    audio.toggleMute();
    removeEvent(w, body, shape, Mat.Brick, 50);
    expect(audio.update(1 / 60, LISTENER).length).toBeGreaterThan(0);
  });

  it('отписка перестаёт слушать мир', () => {
    const { world: w, body, shape } = chunk(Mat.Brick);
    const audio = new AudioDirector();
    audio.listen(w);
    audio.dispose();

    removeEvent(w, body, shape, Mat.Brick, 50);
    expect(audio.update(1 / 60, LISTENER)).toHaveLength(0);
  });
});
