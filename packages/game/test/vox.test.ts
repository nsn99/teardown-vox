import { describe, expect, it } from 'vitest';
import { Mat, Simulation } from '@tvox/core';
import { meshShape, meshSlice, sliceChunk } from '@tvox/render';
import {
  VoxFormatError,
  buildVolume,
  levelFromDoc,
  readVox,
  parseLevelDoc,
  voxCount,
  voxMaterialTable,
  voxSandboxDoc,
  voxToShape,
  voxToVolume,
} from '@tvox/game';

it('RGBA сохраняется при загрузке уровня и мешировании в воркере', () => {
  const file = readVox(makeVox([{size: [2, 1, 1], voxels: [[0, 0, 0, 1], [1, 0, 0, 2]]}], [[255, 0, 0, 255], [0, 255, 0, 255]]));
  const doc = parseLevelDoc(JSON.parse(JSON.stringify(voxSandboxDoc(file))));
  const shape = buildVolume(doc.volumes[1], 0.1);
  expect([...shape.paint.values()]).toEqual([0x1ff0000, 0x100ff00]);
  const direct = meshShape(shape, {aoStrength: 0});
  const worker = meshSlice(sliceChunk(shape, shape.chunkBounds(0), undefined), 0).opaque;
  expect([...worker.colors]).toEqual([...direct.colors]);
  expect([...direct.colors]).toContain(1);
  const spawn = voxSandboxDoc(file).spawn;
  expect(-Math.sin(spawn.yaw)).toBeGreaterThan(0);
  expect(-Math.cos(spawn.yaw)).toBeGreaterThan(0);
});

/**
 * Импорт .vox.
 *
 * Файлы для теста собираем прямо здесь, побайтово: тащить в репозиторий
 * двоичный образец, который никто не может ни прочитать, ни поправить, —
 * худший способ проверять разбор формата.
 */

interface Model {
  size: [number, number, number];
  /** x, y, z, индекс палитры. */
  voxels: Array<[number, number, number, number]>;
}

function chunk(id: string, content: Uint8Array, children: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(12 + content.length + children.length);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  view.setUint32(4, content.length, true);
  view.setUint32(8, children.length, true);
  out.set(content, 12);
  out.set(children, 12 + content.length);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint32(i * 4, v, true));
  return out;
}

/** Собрать .vox из моделей и (необязательно) палитры RGBA. */
function makeVox(models: Model[], palette?: Array<[number, number, number, number]>): Uint8Array {
  const children: Uint8Array[] = [];
  for (const m of models) {
    children.push(chunk('SIZE', u32(...m.size)));
    const xyzi = new Uint8Array(4 + m.voxels.length * 4);
    new DataView(xyzi.buffer).setUint32(0, m.voxels.length, true);
    m.voxels.forEach((v, i) => xyzi.set(v, 4 + i * 4));
    children.push(chunk('XYZI', xyzi));
  }
  if (palette) {
    const rgba = new Uint8Array(256 * 4);
    palette.forEach((c, i) => rgba.set(c, i * 4));
    children.push(chunk('RGBA', rgba));
  }
  const header = new Uint8Array(8);
  header.set([0x56, 0x4f, 0x58, 0x20]); // 'VOX '
  new DataView(header.buffer).setUint32(4, 150, true);
  return concat([header, chunk('MAIN', new Uint8Array(0), concat(children))]);
}

describe('импорт .vox', () => {
  it('читает размеры, воксели и версию', () => {
    const file = readVox(
      makeVox([
        {
          size: [3, 4, 5],
          voxels: [
            [0, 0, 0, 1],
            [2, 3, 4, 2],
          ],
        },
      ]),
    );
    expect(file.version).toBe(150);
    expect(file.models.length).toBe(1);
    expect(file.models[0].size).toEqual({ x: 3, y: 4, z: 5 });
    expect(voxCount(file.models[0])).toBe(2);
  });

  it('читает несколько моделей подряд', () => {
    const file = readVox(
      makeVox([
        { size: [2, 2, 2], voxels: [[0, 0, 0, 1]] },
        { size: [4, 4, 4], voxels: [[1, 1, 1, 1], [2, 2, 2, 1]] },
      ]),
    );
    expect(file.models.length).toBe(2);
    expect(voxCount(file.models[1])).toBe(2);
  });

  it('пересаживает оси: Z вверх у них — Y вверх у нас', () => {
    // Один воксель в точке (x=1, y=2, z=3) по осям MagicaVoxel.
    const file = readVox(makeVox([{ size: [4, 6, 8], voxels: [[1, 2, 3, 1]] }]));
    const shape = voxToShape(file, 0, { defaultMaterial: Mat.Brick });
    // Габариты: наш Y — их Z, наш Z — их Y.
    expect([shape.sx, shape.sy, shape.sz]).toEqual([4, 8, 6]);
    expect(shape.get(1, 3, 2)).toBe(Mat.Brick);
    expect(shape.solidVoxels).toBe(1);
  });

  it('палитра из файла подбирает материал по цвету', () => {
    // Первый цвет — стеклянно-голубой, второй — кирпично-рыжий.
    const glassish: [number, number, number, number] = [150, 200, 210, 255];
    const brickish: [number, number, number, number] = [150, 70, 55, 255];
    const file = readVox(
      makeVox([{ size: [2, 1, 1], voxels: [[0, 0, 0, 1], [1, 0, 0, 2]] }], [glassish, brickish]),
    );
    const table = voxMaterialTable(file);
    expect(table[1]).toBe(Mat.Glass);
    expect(table[2]).toBe(Mat.Brick);
    // Ноль — всегда пустота, что бы ни лежало в палитре.
    expect(table[0]).toBe(Mat.Air);
  });

  it('подбор по цвету не выдаёт служебные материалы', () => {
    // Почти чёрный: ближайший по цвету — неразрушимый фундамент, и вот
    // его-то импорт выдавать не должен ни при каких обстоятельствах.
    const file = readVox(makeVox([{ size: [1, 1, 1], voxels: [[0, 0, 0, 1]] }], [[30, 30, 34, 255]]));
    const table = voxMaterialTable(file);
    expect(table[1]).not.toBe(Mat.Foundation);
    expect(table[1]).not.toBe(Mat.Water);
    expect(table[1]).not.toBe(Mat.Loot);
  });

  it('явное соответствие перекрывает подбор по цвету', () => {
    const file = readVox(makeVox([{ size: [1, 1, 1], voxels: [[0, 0, 0, 1]] }], [[150, 70, 55, 255]]));
    const table = voxMaterialTable(file, { palette: { 1: 'heavy_metal' } });
    expect(table[1]).toBe(Mat.HeavyMetal);
  });

  it('без палитры всё идёт материалом по умолчанию', () => {
    // Файл с палитрой по умолчанию чанк RGBA не пишет вообще: индексы
    // есть, цветов нет, и угадывать тут нечего.
    const file = readVox(makeVox([{ size: [1, 1, 1], voxels: [[0, 0, 0, 7]] }]));
    expect(file.palette).toBeNull();
    const shape = voxToShape(file, 0, { defaultMaterial: Mat.Wood });
    expect(shape.get(0, 0, 0)).toBe(Mat.Wood);
  });

  it('модель становится объёмом карты и собирается обратно так же', () => {
    const file = readVox(
      makeVox([
        {
          size: [3, 3, 3],
          voxels: [
            [0, 0, 0, 1],
            [1, 1, 1, 1],
            [2, 2, 2, 1],
          ],
        },
      ]),
    );
    const volume = voxToVolume(file, 0, {
      defaultMaterial: Mat.Metal,
      name: 'кран',
      position: { x: 5, y: 0, z: 5 },
    });
    expect(volume.name).toBe('кран');
    expect(volume.position).toEqual([5, 0, 5]);

    const shape = buildVolume(volume, 0.1);
    expect(shape.solidVoxels).toBe(3);
    expect(shape.get(1, 1, 1)).toBe(Mat.Metal);
    expect(shape.transform.position.x).toBe(5);
  });

  it('битые файлы отвергаются с внятной причиной', () => {
    expect(() => readVox(new Uint8Array([1, 2, 3]))).toThrow(VoxFormatError);
    // Не тот заголовок.
    const wrong = makeVox([{ size: [1, 1, 1], voxels: [[0, 0, 0, 1]] }]);
    wrong[0] = 0x42;
    expect(() => readVox(wrong)).toThrow(/подписи/);
    // XYZI без SIZE.
    const header = new Uint8Array(8);
    header.set([0x56, 0x4f, 0x58, 0x20]);
    new DataView(header.buffer).setUint32(4, 150, true);
    const orphan = concat([header, chunk('MAIN', new Uint8Array(0), chunk('XYZI', u32(0)))]);
    expect(() => readVox(orphan)).toThrow(/раньше SIZE/);
    // Совсем пустой файл без моделей.
    const empty = concat([header, chunk('MAIN', new Uint8Array(0))]);
    expect(() => readVox(empty)).toThrow(/ни одной модели/);
  });

  it('вокруг модели собирается играбельная песочница', () => {
    const file = readVox(
      makeVox([
        {
          size: [20, 16, 12],
          voxels: [
            [0, 0, 0, 1],
            [10, 8, 6, 1],
            [19, 15, 11, 1],
          ],
        },
      ]),
    );
    const doc = voxSandboxDoc(file, 0, { defaultMaterial: Mat.Brick, name: 'башня' });
    // Документ обязан быть настоящим: он идёт через тот же разбор, что и
    // карта с диска, и падать на нём нечему.
    const level = levelFromDoc(doc);
    const sim = new Simulation();
    const bodies = level.build(sim);

    expect(level.name).toBe('башня');
    expect(bodies[0].shapes.map((s) => s.name)).toEqual(['площадка', 'башня']);
    // Модель стоит на площадке, а не висит в воздухе и не тонет в ней.
    const model = bodies[0].shapes[1];
    expect(model.transform.position.y).toBe(0);
    expect(model.solidVoxels).toBe(3);
    // Точка старта — в зоне эвакуации: цель донести можно.
    expect(level.mission.extraction.center.x).toBeCloseTo(level.spawn.position.x, 5);
    // Площадка шире модели: есть куда отойти и откуда смотреть.
    const pad = bodies[0].shapes[0];
    expect(pad.sx).toBeGreaterThan(model.sx);
    expect(pad.sz).toBeGreaterThan(model.sz);
  });

  it('в песочнице нет воды, а площадка не считается в напряжениях', () => {
    const file = readVox(makeVox([{ size: [4, 4, 4], voxels: [[1, 1, 1, 1]] }]));
    const doc = voxSandboxDoc(file);
    expect(doc.waterLevel).toBeLessThan(-100);
    // Считать напряжения по сплошной плите фундамента — время впустую.
    expect(doc.volumes[0].structural).toBe(false);
    expect(doc.mission.targets[0].required).toBe(true);
  });

  it('песочница для несуществующей модели не собирается', () => {
    const file = readVox(makeVox([{ size: [2, 2, 2], voxels: [[0, 0, 0, 1]] }]));
    expect(() => voxSandboxDoc(file, 3)).toThrow(VoxFormatError);
  });

  it('запрос несуществующей модели — ошибка, а не пустая форма', () => {
    const file = readVox(makeVox([{ size: [1, 1, 1], voxels: [[0, 0, 0, 1]] }]));
    expect(() => voxToShape(file, 5)).toThrow(VoxFormatError);
  });

  it('неизвестное имя материала в соответствии — ошибка', () => {
    const file = readVox(makeVox([{ size: [1, 1, 1], voxels: [[0, 0, 0, 1]] }]));
    expect(() => voxMaterialTable(file, { palette: { 1: 'мифрил' } })).toThrow(/мифрил/);
  });

  it('обрезанный XYZI не читается как половина модели', () => {
    const header = new Uint8Array(8);
    header.set([0x56, 0x4f, 0x58, 0x20]);
    new DataView(header.buffer).setUint32(4, 150, true);
    // Обещает десять вокселей, а данных — на один.
    const xyzi = new Uint8Array(8);
    new DataView(xyzi.buffer).setUint32(0, 10, true);
    const file = concat([
      header,
      chunk('MAIN', new Uint8Array(0), concat([chunk('SIZE', u32(2, 2, 2)), chunk('XYZI', xyzi)])),
    ]);
    expect(() => readVox(file)).toThrow(/вокселей/);
  });
});
