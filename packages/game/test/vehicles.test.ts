import { describe, expect, it } from 'vitest';
import { Body, Mat, Simulation, VoxelShape, v3 } from '@tvox/core';
import { NEUTRAL_INPUT, VEHICLES, Vehicle, VehicleInput } from '@tvox/game';

const VS = 0.1;
const drive = (over: Partial<VehicleInput> = {}): VehicleInput => ({
  ...NEUTRAL_INPUT,
  ...over,
});

function emptySim(): Simulation {
  return new Simulation();
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
  it('пять единиц из дизайн-документа', () => {
    expect(Object.keys(VEHICLES).sort()).toEqual([
      'boat',
      'bulldozer',
      'car',
      'excavator',
      'pickup',
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
    afloat.spawn(sim);
    expect(afloat.inWater).toBe(true);
    run(afloat, sim, drive({ throttle: 1 }), 1);
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
  it('на скорости пробивает кирпичную стену', () => {
    const sim = emptySim();
    // Стену ставим с разбегом: чтобы таранить, надо успеть разогнаться.
    const wall = addWall(sim, -25, Mat.Brick);
    const before = wall.solidVoxels;
    const v = new Vehicle('pickup', { position: v3(0, 0.1, 0) });
    v.spawn(sim);
    run(v, sim, drive({ throttle: 1 }), 4);
    expect(v.speed).toBeGreaterThan(VEHICLES.pickup.ramSpeed);
    expect(wall.solidVoxels).toBeLessThan(before);
    expect(v.position.z).toBeLessThan(-25);
  });

  it('без разгона в ту же стену упирается', () => {
    const sim = emptySim();
    const wall = addWall(sim, -4, Mat.Brick);
    const before = wall.solidVoxels;
    const v = new Vehicle('pickup', { position: v3(0, 0.1, 0) });
    v.spawn(sim);
    run(v, sim, drive({ throttle: 1 }), 4);
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
    const sim = emptySim();
    const v = boat(sim);
    run(v, sim, drive({ throttle: 1 }), 3);
    expect(v.flooding).toBe(0);
    expect(v.buoyancy).toBe(1);
    expect(v.wrecked).toBe(false);
  });

  it('пробитый корпус набирает воду, садится и теряет ход', () => {
    const sim = emptySim();
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
    const sim = emptySim();
    const v = boat(sim);
    const shape = v.body.shapes[0];
    shape.fill({ x0: 0, x1: Math.floor(shape.sx * 0.4) }, Mat.Air);

    run(v, sim, drive({ throttle: 1 }), 20);

    expect(v.flooding).toBe(1);
    expect(v.canDrive()).toBe(false);
    expect(v.wrecked).toBe(true);
  });

  it('машина в воде глохнет насовсем', () => {
    const sim = emptySim();
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
