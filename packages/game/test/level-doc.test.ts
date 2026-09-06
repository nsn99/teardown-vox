import { describe, expect, it } from 'vitest';
import { Mat, Simulation } from '@tvox/core';
import {
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

describe('формат карты', () => {
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
