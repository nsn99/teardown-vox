import { describe, expect, it } from 'vitest';
import { Body, Mat, Simulation, VoxelShape, v3 } from '@tvox/core';
import { NEUTRAL_INPUT, VEHICLES, Vehicle, VehicleInput } from '@tvox/game';
import { roadSim } from './helpers/vehicle-world.js';
import { overlapsSolid } from '../src/character.js';

const VS = 0.1;
const drive = (over: Partial<VehicleInput> = {}): VehicleInput => ({
  ...NEUTRAL_INPUT,
  ...over,
});

function emptySim(): Simulation {
  return roadSim();
}

/** Стена поперёк движения: машина при yaw=0 едет в -Z. */
function addWall(sim: Simulation, z: number, mat = Mat.Brick, thickness = 4): Body {
  const s = new VoxelShape({ sx: 120, sy: 40, sz: thickness, voxelSize: VS, grounded: true });
  s.fill({}, mat);
  s.transform = { position: v3(-6, 0, z), rotation: { x: 0, y: 0, z: 0, w: 1 } };
  const b = new Body({ kind: 'static', shapes: [s], name: 'wall', tags: ['level'] });
  sim.world.addBody(b);
  return b;
}

function run(v: Vehicle, sim: Simulation, input: VehicleInput, seconds: number): void {
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds / dt); i++) v.update(sim, input, dt);
}

describe('каталог техники', () => {
  it('семь видов техники, включая погрузчик', () => {
    expect(Object.keys(VEHICLES).sort()).toEqual([
      'boat',
      'bulldozer',
      'car',
      'excavator',
      'forklift',
      'pickup',
      'truck',
    ]);
  });

  it('отвал есть только у тяжёлой техники', () => {
    expect(VEHICLES.bulldozer.blade).not.toBeNull();
    expect(VEHICLES.excavator.blade).not.toBeNull();
    expect(VEHICLES.car.blade).toBeNull();
  });

  it('легковая быстрее бульдозера', () => {
    expect(VEHICLES.car.maxSpeed).toBeGreaterThan(VEHICLES.bulldozer.maxSpeed);
  });
});

describe('движение', () => {
  it('едет вперёд и тормозит', () => {
    const sim = emptySim();
    const v = new Vehicle('car', { position: v3(0, 0.1, 0) });
    v.spawn(sim);
    run(v, sim, drive({ throttle: 1 }), 2);
    expect(v.speed).toBeGreaterThan(5);
    const travelled = Math.abs(v.position.z);
    expect(travelled).toBeGreaterThan(3);

    run(v, sim, drive({ brake: true }), 3);
    expect(Math.abs(v.speed)).toBeLessThan(0.5);
  });

  it('задний ход медленнее переднего', () => {
    const sim = emptySim();
    const v = new Vehicle('car', { position: v3(0, 0.1, 0) });
    v.spawn(sim);
    run(v, sim, drive({ throttle: -1 }), 3);
    expect(v.speed).toBeLessThan(0);
    expect(Math.abs(v.speed)).toBeLessThanOrEqual(VEHICLES.car.reverseSpeed + 0.01);
  });

  it('руль работает только на ходу', () => {
    const sim = emptySim();
    const v = new Vehicle('car', { position: v3(0, 0.1, 0) });
    v.spawn(sim);
    const yaw0 = v.yaw;
    run(v, sim, drive({ steer: 1 }), 1);
    expect(v.yaw).toBeCloseTo(yaw0, 6);

    run(v, sim, drive({ throttle: 1 }), 2);
    run(v, sim, drive({ throttle: 1, steer: 1 }), 1);
    expect(v.yaw).not.toBeCloseTo(yaw0, 3);
  });

  it('тело следует за машиной', () => {
    const sim = emptySim();
    const v = new Vehicle('car', { position: v3(0, 0.1, 0) });
    v.spawn(sim);
    run(v, sim, drive({ throttle: 1 }), 1);
    expect(v.body.transform.position.z).toBeCloseTo(v.position.z, 9);
  });
});

describe('среда обитания', () => {
  it('катер едет только по воде', () => {
    const sim = emptySim();
    const boat = new Vehicle('boat', { position: v3(0, 5, 0), waterLevel: 0 });
    boat.spawn(sim);
    expect(boat.canDrive()).toBe(false);
    run(boat, sim, drive({ throttle: 1 }), 1);
    expect(boat.speed).toBe(0);

    const afloat = new Vehicle('boat', { position: v3(0, 0, 0), waterLevel: 0 });
    const sea = new Simulation();
    afloat.spawn(sea);
    expect(afloat.inWater).toBe(true);
    run(afloat, sea, drive({ throttle: 1 }), 1);
    expect(afloat.speed).toBeGreaterThan(0);
    expect(afloat.position.y).toBe(0);
  });

  it('машина в воде глохнет', () => {
    const sim = emptySim();
    const car = new Vehicle('car', { position: v3(0, -1, 0), waterLevel: 0 });
    car.spawn(sim);
    expect(car.canDrive()).toBe(false);
  });
});

describe('взаимодействие с вокселями', () => {
  it('пикап повреждает кирпич при разгоне, но толстая стена его останавливает', () => {
    const sim = emptySim();
    // Стену ставим с разбегом: чтобы таранить, надо успеть разогнаться.
    const wall = addWall(sim, -25, Mat.Brick);
    const before = wall.solidVoxels;
    const v = new Vehicle('pickup', { position: v3(0, 0.1, 0) });
    v.spawn(sim);
    run(v, sim, drive({ throttle: 1 }), 4);
    expect(wall.solidVoxels).toBeLessThan(before);
    expect(wall.solidVoxels).toBeGreaterThan(before * .8);
    expect(v.position.z).toBeGreaterThan(-25);
    expect(v.hullIntegrity).toBeLessThan(1);
  });

  it('удар в деревянную ограду оставляет неровный скол', () => {
    const sim = emptySim();
    const wall = addWall(sim, -25, Mat.Wood);
    const v = new Vehicle('pickup', { position: v3(0, 0.1, 0) });
    v.spawn(sim);

    run(v, sim, drive({ throttle: 1 }), 4);

    const shape = wall.shapes[0];
    const removedWidths: number[] = [];

    for (let y = 0; y < shape.sy; y++) {
      let removedColumns = 0;
      for (let x = 0; x < shape.sx; x++) {
        let cut = false;
        for (let z = 0; z < shape.sz; z++) {
          if (shape.get(x, y, z) === Mat.Air) {
            cut = true;
            break;
          }
        }
        if (cut) removedColumns++;
      }
      if (removedColumns > 0) removedWidths.push(removedColumns);
    }

    expect(new Set(removedWidths).size).toBeGreaterThan(2);
  });

  it('без разгона в ту же стену упирается', () => {
    const sim = emptySim();
    const wall = addWall(sim, -4, Mat.Brick);
    const before = wall.solidVoxels;
    const v = new Vehicle('pickup', { position: v3(0, 0.1, 0) });
    v.spawn(sim);
    run(v, sim, drive({ throttle: .1 }), 4);
    expect(wall.solidVoxels).toBe(before);
    expect(v.position.z).toBeGreaterThan(-4);
  });

  it('на малой скорости стену не берёт', () => {
    const sim = emptySim();
    const wall = addWall(sim, -2, Mat.Brick);
    const before = wall.solidVoxels;
    const v = new Vehicle('car', { position: v3(0, 0.1, 0) });
    v.spawn(sim);
    run(v, sim, drive({ throttle: 0.1 }), 3);
    expect(wall.solidVoxels).toBe(before);
  });

  it('может отъехать назад от препятствия перед носом', () => {
    const sim = emptySim();
    addWall(sim, -2, Mat.Brick);

    const v = new Vehicle('car', { position: v3(0, 0.1, 0) });
    v.spawn(sim);

    run(v, sim, drive({ throttle: -1 }), 2);

    expect(v.speed).toBeLessThan(-1);
    expect(v.position.z).toBeGreaterThan(1);
  });

  it('стальную стену легковая не пробивает даже на скорости', () => {
    const sim = emptySim();
    const wall = addWall(sim, -8, Mat.Metal);
    const before = wall.solidVoxels;
    const v = new Vehicle('car', { position: v3(0, 0.1, 0) });
    v.spawn(sim);
    run(v, sim, drive({ throttle: 1 }), 4);
    expect(wall.solidVoxels).toBe(before);
  });

  it('бульдозер расчищает завал отвалом стоя', () => {
    const sim = emptySim();
    const wall = addWall(sim, -4, Mat.Concrete, 6);
    const before = wall.solidVoxels;
    const v = new Vehicle('bulldozer', { position: v3(0, 0.1, 0) });
    v.spawn(sim);
    run(v, sim, drive({ blade: true }), 2);
    expect(wall.solidVoxels).toBeLessThan(before);
  });

  it('ковш экскаватора берёт бетон', () => {
    const sim = emptySim();
    const wall = addWall(sim, -4, Mat.Concrete, 6);
    const before = wall.solidVoxels;
    const v = new Vehicle('excavator', { position: v3(0, 0.1, 0) });
    v.spawn(sim);
    run(v, sim, drive({ blade: true }), 2);
    expect(wall.solidVoxels).toBeLessThan(before);
  });
});

describe('уничтожение техники', () => {
  it('разбитый корпус больше не едет', () => {
    const sim = emptySim();
    const v = new Vehicle('car', { position: v3(0, 0.1, 0) });
    v.spawn(sim);
    const shape = v.body.shapes[0];
    // Сносим больше половины корпуса.
    shape.fill({ x0: 0, x1: Math.floor(shape.sx * 0.7) }, Mat.Air);
    v.update(sim, drive({ throttle: 1 }), 1 / 60);
    expect(v.wrecked).toBe(true);
    expect(v.canDrive()).toBe(false);
    const z = v.position.z;
    run(v, sim, drive({ throttle: 1 }), 1);
    expect(v.position.z).toBe(z);
  });
});

describe('вода', () => {
  /** Катер на воде: уровень воды на нуле, катер на нём. */
  function boat(sim: Simulation) {
    const v = new Vehicle('boat', { position: v3(0, 0, 0), voxelSize: VS, waterLevel: 0 });
    v.spawn(sim);
    return v;
  }

  it('целый корпус воду не набирает', () => {
    const sim = new Simulation();
    const v = boat(sim);
    run(v, sim, drive({ throttle: 1 }), 3);
    expect(v.flooding).toBe(0);
    expect(v.buoyancy).toBe(1);
    expect(v.wrecked).toBe(false);
  });

  it('пробитый корпус набирает воду, садится и теряет ход', () => {
    const sim = new Simulation();
    const v = boat(sim);
    // Вырезаем четверть корпуса: это уже пробоина, а не царапина.
    const shape = v.body.shapes[0];
    const cut = Math.floor(shape.sx * 0.35);
    shape.fill({ x0: 0, x1: cut }, Mat.Air);

    expect(v.hullIntegrity).toBeLessThan(0.92);
    run(v, sim, drive({ throttle: 1 }), 6);

    expect(v.flooding).toBeGreaterThan(0);
    expect(v.buoyancy).toBeLessThan(1);
    // Осевший катер сидит ниже уровня воды.
    expect(v.position.y).toBeLessThan(0);
  });

  it('полностью затопленный катер тонет и глохнет', () => {
    const sim = new Simulation();
    const v = boat(sim);
    const shape = v.body.shapes[0];
    shape.fill({ x0: 0, x1: Math.floor(shape.sx * 0.4) }, Mat.Air);

    run(v, sim, drive({ throttle: 1 }), 20);

    expect(v.flooding).toBe(1);
    expect(v.canDrive()).toBe(false);
    expect(v.wrecked).toBe(true);
  });

  it('машина в воде глохнет насовсем', () => {
    const sim = new Simulation();
    const car = new Vehicle('car', { position: v3(0, -1, 0), voxelSize: VS, waterLevel: 0 });
    car.spawn(sim);

    expect(car.canDrive()).toBe(false);
    run(car, sim, drive({ throttle: 1 }), 3);

    expect(car.wrecked).toBe(true);
    // И на суше уже не заводится: двигатель утоплен.
    car.position = v3(0, 2, 0);
    expect(car.canDrive()).toBe(false);
  });

  it('машина на берегу воду не набирает', () => {
    const sim = emptySim();
    const car = new Vehicle('car', { position: v3(0, 0.5, 0), voxelSize: VS, waterLevel: 0 });
    car.spawn(sim);
    run(car, sim, drive({ throttle: 1 }), 3);
    expect(car.wrecked).toBe(false);
  });
});

describe('силуэт техники', () => {
  it('камера катера находится в пустой рубке и смотрит через стекло при повороте', () => {
    const sim = new Simulation();
    try {
      const boat = new Vehicle('boat', { position: v3(3, -0.4, -7), yaw: Math.PI / 3 });
      boat.spawn(sim);
      const eye = boat.driverEye;
      expect(overlapsSolid(sim.world, {
        min: v3(eye.x - 0.06, eye.y - 0.06, eye.z - 0.06),
        max: v3(eye.x + 0.06, eye.y + 0.06, eye.z + 0.06),
      })).toBe(false);
      const ahead = sim.world.raycast(eye, boat.forward, { maxDistance: 2 })!;
      expect(ahead.body).toBe(boat.body);
      expect(ahead.shape.get(ahead.vx, ahead.vy, ahead.vz)).toBe(Mat.Glass);
      expect(ahead.distance).toBeGreaterThan(0.4);
      const roof = sim.world.raycast(eye, v3(0, 1, 0), { maxDistance: 1 })!;
      expect(roof.shape.get(roof.vx, roof.vy, roof.vz)).toBe(Mat.Metal);
    } finally { sim.dispose(); }
  });

  it('у бульдозера раздельные гусеницы, высокая кабина и наклонный отвал', () => {
    const v = new Vehicle('bulldozer', { position: v3(0, 0.1, 0) });
    const shape = v.body.shapes[0];
    expect(shape.get(20, 2, 4)).toBe(Mat.HeavyMetal);
    expect(shape.get(20, 2, 29)).toBe(Mat.HeavyMetal);
    expect(shape.get(20, 2, 17)).toBe(Mat.Air);
    expect(shape.get(4, 1, 4)).toBe(Mat.Air);
    expect(shape.get(4, 5, 4)).toBe(Mat.HeavyMetal);
    expect(shape.get(16, 25, 17)).toBe(Mat.HeavyMetal);
    expect(shape.get(34, 20, 17)).toBe(Mat.Air);
    expect(shape.get(24, 18, 17)).toBe(Mat.Glass);
    expect(shape.get(51, 10, 17)).toBe(Mat.Air);
    expect(v.bladeShape!.get(57, 3, 17)).toBe(Mat.HeavyMetal);
    expect(v.bladeShape!.get(55, 13, 17)).toBe(Mat.HeavyMetal);
    expect(v.bladeShape!.get(57, 13, 17)).toBe(Mat.Air);
  });

  it('окраска различает части бульдозера и сохраняет сталь и стекло', () => {
    const v = new Vehicle('bulldozer', { position: v3(0, 0.1, 0) });
    const shape = v.body.shapes[0];
    const colors = [shape.paint.get(shape.idx(20, 2, 4))!, shape.paint.get(shape.idx(16, 25, 17))!,
      v.bladeShape!.paint.get(shape.idx(57, 3, 17))!];
    expect(new Set(colors).size).toBe(3);
    expect(colors.every(c => c >= 0x1000000)).toBe(true);
    expect(shape.paint.has(shape.idx(24, 18, 17))).toBe(false);
    expect([...shape.data].every(m => m === Mat.Air || m === Mat.HeavyMetal || m === Mat.Glass || m === Mat.Fuel)).toBe(true);
  });

  it('корпус не заполняет верхние углы габаритного бокса', () => {
    for (const kind of Object.keys(VEHICLES) as (keyof typeof VEHICLES)[]) {
      const v = new Vehicle(kind, { position: v3(0, 0.1, 0), voxelSize: VS });
      const shape = v.body.shapes[0];
      const y = shape.sy - 1;

      expect(shape.get(0, y, 0), kind).toBe(Mat.Air);
      expect(shape.get(0, y, shape.sz - 1), kind).toBe(Mat.Air);
      expect(shape.get(shape.sx - 1, y, 0), kind).toBe(Mat.Air);
      expect(shape.get(shape.sx - 1, y, shape.sz - 1), kind).toBe(Mat.Air);
    }
  });
});
