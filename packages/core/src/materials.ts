/**
 * Таблица материалов. Один байт на воксель — значит максимум 256 материалов,
 * из них 0 всегда воздух.
 *
 * Все числа подобраны так, чтобы игра читалась «на ощупь», а не по паспорту
 * стали. Порядок величин физический, абсолютные значения — игровые.
 */

export enum Mat {
  Air = 0,
  /** Невидимый неразрушимый фундамент. Якорь структурной целостности. */
  Foundation = 1,
  Rock = 2,
  Dirt = 3,
  Concrete = 4,
  Brick = 5,
  Wood = 6,
  Plank = 7,
  Metal = 8,
  HeavyMetal = 9,
  Glass = 10,
  Plastic = 11,
  Foliage = 12,
  Charred = 13,
  /** Только для маркировки маршрута баллончиком: не влияет на физику. */
  Paint = 14,
  Water = 15,
  Loot = 16,
  /**
   * Кабель сигнализации. Виден на стене, режется чем угодно и ничего не
   * держит — зато при разрыве включает сирену.
   */
  Cable = 17,
}

export interface MaterialDef {
  id: Mat;
  name: string;
  /** кг/м³ */
  density: number;
  /**
   * Порог инструмента 0..1. Если сила инструмента ниже — воксель не берётся
   * вообще. Кувалда (0.35) не пробивает металл (0.6), паяльная лампа (0.75) — да.
   */
  toughness: number;
  /** Сколько единиц урона нужно накопить, чтобы воксель исчез. */
  hp: number;
  /** 0..1, восприимчивость к возгоранию. 0 — не горит никогда. */
  flammability: number;
  /** Единиц топлива на воксель. Кончилось — воксель сгорел. */
  fuel: number;
  /** Предел сжатия, условные Па. Выше — воксель крошится под нагрузкой. */
  maxStress: number;
  /**
   * Предел изгибающего момента для консолей (нагрузка × плечо в вокселях).
   * Дерево ломается быстро, сталь держит длинный вылет.
   */
  maxMoment: number;
  /** Не разрушается ничем. */
  indestructible: boolean;
  /** Якорь для флад-филла структурной целостности. */
  anchor: boolean;
  /** RGB 0..255 — базовый цвет палитры рендера. */
  color: [number, number, number];
  /** 0..1 — светимость. */
  emissive: number;
  /** 0..1 — металличность для PBR. */
  metalness: number;
  /** 0..1 — шероховатость. */
  roughness: number;
  /** 0..1 — прозрачность (стекло). */
  alpha: number;
}

const def = (
  id: Mat,
  name: string,
  p: Partial<MaterialDef> & Pick<MaterialDef, 'density' | 'toughness' | 'hp' | 'color'>,
): MaterialDef => ({
  id,
  name,
  flammability: 0,
  fuel: 0,
  maxStress: 1_000_000,
  maxMoment: 1_000_000,
  indestructible: false,
  anchor: false,
  emissive: 0,
  metalness: 0,
  roughness: 0.85,
  alpha: 1,
  ...p,
});

export const MATERIALS: readonly MaterialDef[] = (() => {
  const table: MaterialDef[] = [];
  const put = (m: MaterialDef) => {
    table[m.id] = m;
  };

  put(
    def(Mat.Air, 'air', {
      density: 0,
      toughness: 0,
      hp: 0,
      color: [0, 0, 0],
      alpha: 0,
    }),
  );
  put(
    def(Mat.Foundation, 'foundation', {
      density: 4000,
      toughness: 1.01,
      hp: 65535,
      color: [30, 30, 34],
      indestructible: true,
      anchor: true,
      maxStress: Infinity,
      maxMoment: Infinity,
    }),
  );
  put(
    def(Mat.Rock, 'rock', {
      density: 2600,
      toughness: 0.45,
      hp: 120,
      color: [110, 108, 104],
      maxStress: 3_000_000,
      maxMoment: 3_000,
      anchor: true,
    }),
  );
  put(
    def(Mat.Dirt, 'dirt', {
      density: 1500,
      toughness: 0.1,
      hp: 30,
      color: [92, 70, 48],
      maxStress: 400_000,
      maxMoment: 150,
      anchor: true,
      roughness: 1,
    }),
  );
  put(
    def(Mat.Concrete, 'concrete', {
      density: 2400,
      toughness: 0.3,
      hp: 100,
      color: [150, 148, 142],
      maxStress: 2_000_000,
      maxMoment: 2_500,
    }),
  );
  put(
    def(Mat.Brick, 'brick', {
      density: 1900,
      toughness: 0.3,
      hp: 70,
      color: [140, 74, 58],
      maxStress: 1_200_000,
      maxMoment: 900,
    }),
  );
  put(
    def(Mat.Wood, 'wood', {
      density: 700,
      toughness: 0.2,
      hp: 45,
      color: [126, 90, 52],
      flammability: 0.8,
      fuel: 40,
      maxStress: 800_000,
      maxMoment: 500,
      roughness: 0.9,
    }),
  );
  put(
    def(Mat.Plank, 'plank', {
      density: 600,
      toughness: 0.18,
      hp: 32,
      color: [168, 126, 74],
      flammability: 0.85,
      fuel: 28,
      maxStress: 500_000,
      maxMoment: 260,
    }),
  );
  put(
    def(Mat.Metal, 'metal', {
      density: 7800,
      toughness: 0.6,
      hp: 160,
      color: [128, 134, 142],
      maxStress: 3_000_000,
      maxMoment: 9_000,
      metalness: 0.9,
      roughness: 0.4,
    }),
  );
  put(
    def(Mat.HeavyMetal, 'heavy_metal', {
      density: 7900,
      toughness: 0.72,
      hp: 320,
      color: [86, 92, 100],
      maxStress: 8_000_000,
      maxMoment: 25_000,
      metalness: 0.95,
      roughness: 0.3,
      anchor: true,
    }),
  );
  put(
    def(Mat.Cable, 'cable', {
      density: 1400,
      // Режется чем угодно, вплоть до руки: смысл кабеля не в прочности,
      // а в том, что игрок должен его заметить и обойти.
      toughness: 0.02,
      hp: 4,
      color: [214, 74, 52],
      emissive: 0.25,
      roughness: 0.6,
    }),
  );
  put(
    def(Mat.Glass, 'glass', {
      density: 2500,
      toughness: 0.05,
      hp: 6,
      color: [176, 214, 224],
      maxStress: 5_000_000,
      // Стекло прекрасно держит сжатие и совершенно не держит изгиб —
      // отсюда огромный maxStress при почти нулевом maxMoment.
      maxMoment: 20,
      alpha: 0.35,
      roughness: 0.05,
    }),
  );
  put(
    def(Mat.Plastic, 'plastic', {
      density: 950,
      toughness: 0.15,
      hp: 28,
      color: [196, 196, 200],
      flammability: 0.55,
      fuel: 22,
      maxStress: 300_000,
      maxMoment: 120,
      roughness: 0.45,
    }),
  );
  put(
    def(Mat.Foliage, 'foliage', {
      density: 300,
      toughness: 0.02,
      hp: 8,
      color: [70, 112, 52],
      flammability: 1,
      fuel: 10,
      maxStress: 30_000,
      maxMoment: 8,
      roughness: 1,
    }),
  );
  put(
    def(Mat.Charred, 'charred', {
      density: 350,
      toughness: 0.05,
      hp: 8,
      color: [38, 34, 32],
      flammability: 0.05,
      fuel: 2,
      maxStress: 20_000,
      maxMoment: 20,
    }),
  );
  put(
    def(Mat.Paint, 'paint', {
      density: 1,
      toughness: 0.01,
      hp: 1,
      color: [250, 96, 20],
      emissive: 0.25,
      maxStress: 0,
      maxMoment: 0,
    }),
  );
  put(
    def(Mat.Water, 'water', {
      density: 1000,
      toughness: 1.01,
      hp: 65535,
      color: [40, 92, 140],
      alpha: 0.55,
      roughness: 0.02,
      indestructible: true,
      maxStress: Infinity,
      maxMoment: Infinity,
    }),
  );
  put(
    def(Mat.Loot, 'loot', {
      density: 1200,
      toughness: 0.12,
      hp: 24,
      color: [214, 176, 62],
      emissive: 0.12,
      metalness: 0.7,
      roughness: 0.25,
      maxStress: 200_000,
      maxMoment: 60,
    }),
  );

  for (let i = 0; i < table.length; i++) {
    if (!table[i]) throw new Error(`Дыра в таблице материалов: id=${i}`);
  }
  return table;
})();

export function material(id: number): MaterialDef {
  const m = MATERIALS[id];
  if (!m) throw new RangeError(`Неизвестный материал: ${id}`);
  return m;
}

export const isSolid = (id: number): boolean => id !== Mat.Air;

export const isFlammable = (id: number): boolean =>
  id !== Mat.Air && material(id).flammability > 0;

/** Воксель считается несущим, если его вообще имеет смысл считать в нагрузке. */
export const carriesLoad = (id: number): boolean =>
  id !== Mat.Air && id !== Mat.Paint && id !== Mat.Water && id !== Mat.Cable;

/** Масса одного вокселя, кг. */
export const voxelMass = (id: number, voxelSize: number): number =>
  material(id).density * voxelSize * voxelSize * voxelSize;
