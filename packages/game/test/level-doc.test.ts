import { describe, expect, it } from 'vitest';
import { Mat, Simulation, v3 } from '@tvox/core';
import {
  AutomaticGate,
  LevelDoc,
  LevelFormatError,
  PORT_DOC,
  buildVolume,
  docFromLevel,
  levelFromDoc,
  parseLevelDoc,
  portLevel,
} from '@tvox/game';

/**
 * Формат карты.
 *
 * Два требования, и оба проверяются здесь: сломанный файл обязан назвать
 * поле, а целый — собраться в ту же геометрию до последнего вокселя.
 * Всё остальное — удобства.
 */

/** Минимальная карта, на которой можно проверять формат, а не «Порт». */
function tinyDoc(): LevelDoc {
  return JSON.parse(
    JSON.stringify({
      format: 'tvox-level',
      version: 1,
      id: 'tiny',
      name: 'Кладовка',
      brief: 'Одна комната, один сейф.',
      voxelSize: 0.1,
      waterLevel: -5,
      spawn: { position: [0, 0, 0], yaw: 0 },
      volumes: [
        {
          name: 'room',
          size: [40, 30, 40],
          position: [0, 0, 0],
          // Порядок операций — как слои краски: следующая перекрывает
          // предыдущую. Фундамент кладём последним, иначе пол коробки
          // затрёт его, и комната повиснет без якоря.
          ops: [
            { op: 'hollow', wall: 'brick', roof: 'concrete', floor: 'concrete', thickness: 2 },
            { op: 'fill', box: [0, 0, 0, 40, 2, 40], mat: 'foundation' },
            { op: 'line', mat: 'cable', points: [[3, 20, 3], [36, 20, 3]] },
          ],
        },
      ],
      triggers: [],
      vehicles: [],
      mission: {
        id: 'tiny',
        name: 'Кладовка',
        brief: 'Забрать и уйти.',
        alarmSeconds: 30,
        extraction: { center: [0, 1, 0], halfExtents: [2, 2, 2] },
        targets: [
          {
            id: 'safe',
            name: 'Сейф',
            kind: 'safe',
            wired: true,
            required: true,
            value: 1000,
            position: [2, 0.5, 2],
          },
        ],
      },
    }),
  ) as LevelDoc;
}

/** Портит одно поле документа и возвращает то, что вышло. */
function broken(mutate: (doc: Record<string, unknown>) => void): unknown {
  const doc = tinyDoc() as unknown as Record<string, unknown>;
  mutate(doc);
  return doc;
}

function gateDoc(): LevelDoc {
  const doc = tinyDoc();
  doc.props = [{ name: 'door', kind: 'dynamic', kinematic: true, tags: ['gate'],
    volume: { name: 'panel', size: [40, 40, 3], position: [4, 0, 0], grounded: false,
      structural: false, ops: [{ op: 'fill', mat: 'metal', color: '#99a5ae' }] } }];
  doc.gates = [{ id: 'door', body: 'door', rise: 4.1, speed: 4, approachRadius: 8, closeDelay: 2,
    support: { volume: 'room', voxel: [1, 29, 1] } }];
  return doc;
}

describe('ворота в формате карты', () => {
  it('сохраняет механизм, краску и повреждения открытой створки и загружает её закрытой', () => {
    const level = levelFromDoc(gateDoc());
    const sim = new Simulation();
    const restored = new Simulation();
    try {
      level.build(sim);
      const gate = new AutomaticGate(sim, level.gates![0]);
      const shape = gate.body.shapes[0];
      shape.set(3, 3, 1, Mat.Air);
      shape.paint.set(shape.idx(0, 0, 0), 0x1889900);
      gate.update({ min: v3(5, 0.1, -2), max: v3(6, 2, -1) }, 1.1);
      expect(gate.opening).toBe(1);
      const saved = parseLevelDoc(docFromLevel(level, sim));
      expect(saved.gates).toEqual(gateDoc().gates);
      expect(saved.props!.find(p => p.name === 'door')!.kinematic).toBe(true);
      const next = levelFromDoc(saved);
      next.build(restored);
      const door = new AutomaticGate(restored, next.gates![0]);
      expect(door.opening).toBe(0);
      expect(door.body.aabb().min.y).toBe(0);
      expect(door.body.shapes[0].get(3, 3, 1)).toBe(Mat.Air);
      expect(door.body.shapes[0].paint.get(door.body.shapes[0].idx(0, 0, 0))).toBe(0x1889900);
    } finally { sim.dispose(); restored.dispose(); }
  });

  it.each(['rise', 'speed', 'approachRadius'] as const)('не принимает нулевое значение %s', field => {
    const doc = gateDoc();
    doc.gates![0][field] = 0;
    expect(() => parseLevelDoc(doc)).toThrow(`gates[0].${field}`);
  });

  it('проверяет задержку, повторные имена и ссылки на тела и раму', () => {
    const doc = gateDoc();
    doc.gates![0].closeDelay = -1;
    expect(() => parseLevelDoc(doc)).toThrow('gates[0].closeDelay');
    doc.gates![0].closeDelay = 2;
    doc.gates!.push({ ...doc.gates![0] });
    expect(() => parseLevelDoc(doc)).toThrow('gates[1].id');
    doc.gates![1].id = 'second';
    expect(() => parseLevelDoc(doc)).toThrow('gates[1].body');
    doc.gates!.pop();
    doc.gates![0].body = 'absent';
    expect(() => parseLevelDoc(doc)).toThrow('gates[0].body');
    doc.gates![0].body = 'door';
    doc.gates![0].support!.volume = 'absent';
    expect(() => parseLevelDoc(doc)).toThrow('gates[0].support.volume');
    doc.gates![0].support!.volume = 'room';
    doc.gates![0].support!.voxel = [1, 30, 1];
    expect(() => parseLevelDoc(doc)).toThrow('gates[0].support.voxel');
  });

  it('кинематическая створка должна быть динамическим телом', () => {
    const doc = gateDoc();
    doc.props![0].kind = 'static';
    expect(() => parseLevelDoc(doc)).toThrow('props[0].kinematic');
    doc.props![0].kind = 'dynamic';
    doc.props![0].kinematic = false;
    expect(() => parseLevelDoc(doc)).toThrow('gates[0].body');
  });
});

describe('формат карты', () => {
  it('размер сетки отдельного объёма сохраняется при экспорте и повторной загрузке', () => {
    const doc = tinyDoc();
    doc.volumes[0].voxelSize = 0.5;
    const level = levelFromDoc(doc);
    const sim = new Simulation();
    const original = level.build(sim)[0].shapes[0];
    const restored = levelFromDoc(docFromLevel(level, sim)).build(new Simulation())[0].shapes[0];
    expect(original.voxelSize).toBe(0.5);
    expect(restored.voxelSize).toBe(0.5);
    expect(restored.localAabb()).toEqual(original.localAabb());
    expect(restored.data).toEqual(original.data);
    for (const value of [0, -0.1, 'bad']) {
      (doc.volumes[0] as unknown as { voxelSize: unknown }).voxelSize = value;
      expect(() => parseLevelDoc(doc)).toThrow(/volumes\[0\].voxelSize/);
    }
  });
  it('минимальная карта разбирается и собирается', () => {
    const level = levelFromDoc(tinyDoc());
    const sim = new Simulation();
    const bodies = level.build(sim);
    expect(level.id).toBe('tiny');
    // Тело уровня плюс тело цели.
    expect(bodies.length).toBe(2);
    expect(bodies[0].shapes[0].solidVoxels).toBeGreaterThan(0);
    expect(bodies[1].tags.has('target:safe')).toBe(true);
  });

  it('операции дают ровно ту геометрию, что написана', () => {
    const shape = buildVolume(tinyDoc().volumes[0], 0.1);
    // Фундамент внизу, кирпич по стене, воздух внутри, кабель на месте.
    expect(shape.get(20, 0, 20)).toBe(Mat.Foundation);
    expect(shape.get(0, 10, 20)).toBe(Mat.Brick);
    expect(shape.get(20, 10, 20)).toBe(Mat.Air);
    expect(shape.get(20, 20, 3)).toBe(Mat.Cable);
    expect(shape.get(3, 20, 3)).toBe(Mat.Cable);
  });

  it('сетка повторяет ячейку с шагом, а не размазывает её', () => {
    const doc = tinyDoc();
    doc.volumes[0].ops = [
      { op: 'grid', box: [0, 0, 0, 40, 4, 40], cell: [2, 4, 2], step: [10, 100, 10], mat: 'wood' },
    ];
    const shape = buildVolume(doc.volumes[0], 0.1);
    expect(shape.get(0, 1, 0)).toBe(Mat.Wood);
    expect(shape.get(1, 1, 1)).toBe(Mat.Wood);
    expect(shape.get(5, 1, 5)).toBe(Mat.Air);
    expect(shape.get(10, 1, 10)).toBe(Mat.Wood);
    // Четыре ряда на четыре ряда по два вокселя в ячейке на четыре слоя.
    expect(shape.solidVoxels).toBe(4 * 4 * 2 * 2 * 4);
  });

  it('сырые воксели кладутся в форму со смещением', () => {
    const doc = tinyDoc();
    doc.volumes[0].ops = [
      { op: 'voxels', at: [5, 5, 5], size: [2, 1, 1], rle: [Mat.Metal, 1, Mat.Air, 1] },
    ];
    const shape = buildVolume(doc.volumes[0], 0.1);
    expect(shape.get(5, 5, 5)).toBe(Mat.Metal);
    expect(shape.get(6, 5, 5)).toBe(Mat.Air);
    expect(shape.solidVoxels).toBe(1);
  });

  it('цвет заливки и сетки сохраняет материал и обрезается по границе формы', () => {
    const doc = tinyDoc();
    doc.volumes[0].size = [4, 3, 4];
    doc.volumes[0].ops = [
      { op: 'fill', box: [-1, 0, -1, 5, 3, 5], mat: 'metal', color: '#123456' },
      { op: 'fill', box: [1, 1, 1, 3, 3, 3], mat: 'air', color: '#ffffff' },
      { op: 'grid', box: [0, 0, 0, 4, 3, 4], cell: [1, 1, 1], step: [2, 2, 2], mat: 'metal', color: '#aabbcc' },
    ];
    const parsed = parseLevelDoc(JSON.stringify(doc));
    const shape = buildVolume(parsed.volumes[0], 0.1);
    expect(shape.get(0, 0, 0)).toBe(Mat.Metal);
    expect(shape.paint.get(shape.idx(0, 0, 0))).toBe(0x1aabbcc);
    expect(shape.paint.get(shape.idx(1, 0, 1))).toBe(0x1123456);
    expect(shape.get(1, 1, 1)).toBe(Mat.Air);
    expect(shape.paint.has(shape.idx(1, 1, 1))).toBe(false);
    for (const index of shape.paint.keys()) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(shape.data.length);
      expect(shape.data[index]).not.toBe(Mat.Air);
    }
  });

  it('снимок карты сохраняет окраску заливок и сеток', () => {
    const doc = tinyDoc();
    doc.volumes[0].ops = [
      { op: 'fill', box: [0, 0, 0, 4, 4, 4], mat: 'metal', color: '#000000' },
      { op: 'grid', box: [0, 0, 0, 4, 4, 4], cell: [1, 4, 1], step: [2, 10, 2], mat: 'metal', color: '#abcdef' },
    ];
    const level = levelFromDoc(doc);
    const sim = new Simulation();
    const before = level.build(sim)[0].shapes[0];
    const snapshot = docFromLevel(level, sim);
    const restored = levelFromDoc(JSON.stringify(snapshot)).build(new Simulation())[0].shapes[0];
    expect(restored.data).toEqual(before.data);
    expect(restored.paint).toEqual(before.paint);
    expect(restored.paint.get(restored.idx(1, 1, 1))).toBe(0x1000000);
  });

  it('карта из файла совпадает с картой из кода воксель в воксель', () => {
    const a = new Simulation();
    const fromCode = portLevel.build(a);
    const b = new Simulation();
    const fromFile = levelFromDoc(PORT_DOC).build(b);

    expect(fromFile.length).toBe(fromCode.length);
    for (let i = 0; i < fromCode.length; i++) {
      const x = fromCode[i].shapes;
      const y = fromFile[i].shapes;
      expect(y.length).toBe(x.length);
      for (let j = 0; j < x.length; j++) {
        expect(y[j].name).toBe(x[j].name);
        expect(y[j].solidVoxels).toBe(x[j].solidVoxels);
      }
    }
  });

  it('слепок построенной карты грузится обратно без потерь', () => {
    const first = new Simulation();
    const built = portLevel.build(first);
    const snapshot = docFromLevel(portLevel, first);

    const second = new Simulation();
    const restored = levelFromDoc(snapshot).build(second);

    const level = built[0];
    const back = restored[0];
    expect(back.shapes.length).toBe(level.shapes.length);
    for (let i = 0; i < level.shapes.length; i++) {
      const a = level.shapes[i];
      const b = back.shapes[i];
      expect(`${b.name} ${b.sx}x${b.sy}x${b.sz}`).toBe(`${a.name} ${a.sx}x${a.sy}x${a.sz}`);
      let diff = 0;
      for (let k = 0; k < a.data.length; k++) if (a.data[k] !== b.data[k]) diff++;
      expect(`${a.name}: ${diff}`).toBe(`${a.name}: 0`);
    }
    // Вода — отдельное тело и остаётся отдельным телом.
    expect(back.name).toBe(level.name);
    expect(restored.some((x) => x.tags.has('water'))).toBe(true);
  });

  it('снимок сохраняет неструктурные формы неструктурными', () => {
    const sim = new Simulation();
    portLevel.build(sim);
    const snapshot = docFromLevel(portLevel, sim);
    const ground = snapshot.volumes.find((v) => v.name === 'ground');
    expect(ground?.structural).toBe(false);
  });

  it('маршруты отхода доезжают до уровня и обратно в документ', () => {
    const level = levelFromDoc(PORT_DOC);
    expect(level.routes?.length).toBeGreaterThanOrEqual(3);
    const yard = level.routes?.find((r) => r.id === 'yard');
    expect(yard?.needs).toBe('foot');
    // В документе точки — массивы, в уровне — векторы: проверяем, что
    // перевод не потерял ни точки, ни порядка.
    expect(yard?.waypoints[0]).toEqual(v3(26.5, 0.9, 26.5));
    const back = docFromLevel(level, seed(level));
    expect(back.routes?.length).toBe(level.routes?.length);
    expect(back.routes?.[0].waypoints[0]).toEqual([26.5, 0.9, 26.5]);
  });

  it('погоня из документа доезжает до уровня', () => {
    const level = levelFromDoc(PORT_DOC);
    expect(level.pursuit?.length).toBe(2);
    expect(level.pursuit?.[0].kind).toBe('helicopter');
    expect(docFromLevel(level, seed(level)).pursuit?.length).toBe(2);
  });
});

function seed(level: ReturnType<typeof levelFromDoc>) {
  const sim = new Simulation();
  level.build(sim);
  return sim;
}

describe('формат карты: ошибки называют поле', () => {
  const cases: Array<{ name: string; input: unknown; path: string }> = [
    { name: 'не тот формат', input: broken((d) => (d.format = 'minecraft')), path: 'format' },
    { name: 'версия из будущего', input: broken((d) => (d.version = 99)), path: 'version' },
    { name: 'нет объёмов', input: broken((d) => (d.volumes = [])), path: 'volumes' },
    {
      name: 'отрицательный воксель',
      input: broken((d) => (d.voxelSize = -1)),
      path: 'voxelSize',
    },
    {
      name: 'нет материала',
      input: broken((d) => {
        (d.volumes as Array<{ ops: unknown[] }>)[0].ops = [
          { op: 'fill', box: [0, 0, 0, 1, 1, 1], mat: 'адамантий' },
        ];
      }),
      path: 'volumes[0].ops[0].mat',
    },
    {
      name: 'неверный цвет заливки',
      input: broken((d) => {
        (d.volumes as Array<{ ops: unknown[] }>)[0].ops = [{ op: 'fill', mat: 'metal', color: 'red' }];
      }),
      path: 'volumes[0].ops[0].color',
    },
    {
      name: 'неверный цвет сетки',
      input: broken((d) => {
        (d.volumes as Array<{ ops: unknown[] }>)[0].ops = [
          { op: 'grid', box: [0, 0, 0, 4, 4, 4], cell: [1, 1, 1], step: [2, 2, 2], mat: 'metal', color: '#gg1122' },
        ];
      }),
      path: 'volumes[0].ops[0].color',
    },
    {
      name: 'неизвестная операция',
      input: broken((d) => {
        (d.volumes as Array<{ ops: unknown[] }>)[0].ops = [{ op: 'магия' }];
      }),
      path: 'volumes[0].ops[0].op',
    },
    {
      name: 'вывернутая коробка',
      input: broken((d) => {
        (d.volumes as Array<{ ops: unknown[] }>)[0].ops = [
          { op: 'fill', box: [10, 0, 0, 1, 1, 1], mat: 'brick' },
        ];
      }),
      path: 'volumes[0].ops[0].box',
    },
    {
      name: 'сырые воксели не покрывают объём',
      input: broken((d) => {
        (d.volumes as Array<{ ops: unknown[] }>)[0].ops = [
          { op: 'voxels', at: [0, 0, 0], size: [4, 4, 4], rle: [5, 2] },
        ];
      }),
      path: 'volumes[0].ops[0].rle',
    },
    {
      name: 'ломаная из одной точки',
      input: broken((d) => {
        (d.volumes as Array<{ ops: unknown[] }>)[0].ops = [
          { op: 'line', mat: 'cable', points: [[0, 0, 0]] },
        ];
      }),
      path: 'volumes[0].ops[0].points',
    },
    {
      name: 'таймер нулевой',
      input: broken((d) => ((d.mission as { alarmSeconds: number }).alarmSeconds = 0)),
      path: 'mission.alarmSeconds',
    },
    {
      name: 'нет обязательных целей',
      input: broken((d) => {
        (d.mission as { targets: Array<{ required: boolean }> }).targets[0].required = false;
      }),
      path: 'mission.targets',
    },
    {
      name: 'повтор id цели',
      input: broken((d) => {
        const m = d.mission as { targets: unknown[] };
        m.targets = [m.targets[0], JSON.parse(JSON.stringify(m.targets[0]))];
        (m.targets[1] as { required: boolean }).required = true;
      }),
      path: 'mission.targets',
    },
    {
      name: 'нет такой техники',
      input: broken((d) => {
        d.vehicles = [{ id: 'x', kind: 'танк', position: [0, 0, 0] }];
      }),
      path: 'vehicles[0].kind',
    },
    {
      name: 'неизвестный вид триггера',
      input: broken((d) => {
        d.triggers = [
          { id: 't', kind: 'ловушка', center: [0, 0, 0], halfExtents: [1, 1, 1] },
        ];
      }),
      path: 'triggers[0].kind',
    },
    {
      name: 'маршрут из одной точки',
      input: broken((d) => {
        d.routes = [{ id: 'x', name: 'x', needs: 'foot', waypoints: [[0, 0, 0]] }];
      }),
      path: 'routes[0].waypoints',
    },
    {
      name: 'маршрут требует неизвестно чего',
      input: broken((d) => {
        d.routes = [{ id: 'x', name: 'x', needs: 'телепорт', waypoints: [[0, 0, 0], [1, 0, 0]] }];
      }),
      path: 'routes[0].needs',
    },
    {
      name: 'преследователь неизвестной породы',
      input: broken((d) => {
        d.pursuit = [{ kind: 'дирижабль', from: [0, 0, 0], hover: 1, maxSpeed: 1, lead: 1, light: 1 }];
      }),
      path: 'pursuit[0].kind',
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      // Смысл теста не в том, что упало, а в том, что сказало куда смотреть.
      try {
        parseLevelDoc(c.input);
        throw new Error(`ожидалась ошибка формата: ${c.name}`);
      } catch (e) {
        expect(e).toBeInstanceOf(LevelFormatError);
        expect((e as LevelFormatError).path).toBe(c.path);
        expect((e as LevelFormatError).message).toContain(c.path);
      }
    });
  }

  it('карта грузится из строки JSON, а не только из объекта', () => {
    const doc = parseLevelDoc(JSON.stringify(tinyDoc()));
    expect(doc.id).toBe('tiny');
    expect(doc.volumes[0].ops.length).toBe(3);
  });

  it('мусор вместо карты тоже назван по имени', () => {
    expect(() => parseLevelDoc(42)).toThrow(LevelFormatError);
    expect(() => parseLevelDoc(null)).toThrow(LevelFormatError);
  });
});
