import {
  PROFILE_STORAGE_KEY,
  AudioDirector,
  Heist,
  LevelSource,
  chaseCamera,
  NEUTRAL_INPUT,
  Profile,
  MAX_TIER,
  TOOL_IDS,
  ToolId,
  VehicleInput,
  portLevel,
  toolBySlot,
} from '@tvox/game';
import {
  Body,
  Mat,
  RapierPhysics,
  VoxelShape,
  add,
  carve,
  clamp,
  explode,
  materialByName,
  scale,
  stepStructure,
  v3,
} from '@tvox/core';
import { ChargeView, FireLights, ParticleSystem, VoxelRenderer } from '@tvox/render';
import { AudioPlayer } from './audio-player.js';
import { Input } from './input.js';
import { Hud, Menu, ResultScreen, money } from './hud.js';
import { enableLevelDrop } from './level-drop.js';

const canvas = document.getElementById('view') as HTMLCanvasElement;

const renderer = new VoxelRenderer({ canvas, quality: 'medium' });
const particles = new ParticleSystem({ capacity: 6000 });
const fireLights = new FireLights(6);
const chargeView = new ChargeView();
renderer.scene.add(particles.points, fireLights.group, chargeView.group);
const audio = new AudioDirector();
const player = new AudioPlayer();
let audioOff: (() => void) | null = null;

const input = new Input({ canvas });
const hud = new Hud();
const profile = loadProfile();

let heist: Heist | null = null;
/**
 * Текущая карта. По умолчанию «Порт», но её можно заменить, бросив файл
 * в окно: игра не знает и не должна знать, откуда карта взялась.
 */
let level: LevelSource = portLevel;
let paused = true;
let sandbox = false;
let last = performance.now();
/** Вид от третьего лица. Осмысленен за рулём, поэтому включается сам. */
let thirdPerson = false;
/** Сглаженная длительность кадра, мс — для честного счётчика кадров. */
let smoothedFrame = 16;
let captureMode = false;
let physicsReady: Promise<void> = Promise.resolve();

const menu = new Menu({
  onMission: () => startRun(false),
  onSandbox: () => startRun(true),
  onUpgrade: (tool) => {
    const res = profile.upgrade(tool);
    if (res.ok) {
      saveProfile();
      menu.render(profile, level.brief);
      if (heist) heist.inventory.setTier(tool, res.tier);
    }
  },
});

const result = new ResultScreen({
  onAgain: () => {
    result.hide();
    startRun(sandbox);
  },
  onHub: () => {
    result.hide();
    toHub();
  },
});

menu.render(profile, level.brief);
menu.show();
resize();
window.addEventListener('resize', resize);

function resize(): void {
  renderer.resize(window.innerWidth, window.innerHeight);
}

function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    return raw ? Profile.fromJSON(JSON.parse(raw)) : new Profile();
  } catch {
    return new Profile();
  }
}

function saveProfile(): void {
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile.toJSON()));
  } catch {
    /* приватный режим — играем без сохранения */
  }
}

// ---------------------------------------------------------------------------

function startRun(inSandbox: boolean): void {
  player.suspend();
  sandbox = inSandbox;
  heist?.sim.dispose();
  particles.clear();
  chargeView.update([]);

  heist = new Heist({ level, profile, sandbox: inSandbox, simulation: { frameBudgetMs: 8 } });
  heist.start();
  // Карта строится целиком в первый же кадр: бюджет ремеша — про
  // разрушение по ходу игры, а не про загрузку уровня.
  renderer.prime();
  renderer.setDaylight(level.environment?.daylight ?? 'dusk');
  renderer.setLevelLights(level.environment?.lights ?? []);
  wireEvents(heist);
  physicsReady = upgradeToRapier(heist);

  audioOff?.();
  audio.dispose();
  audioOff = audio.listen(heist.sim.world, () => heist?.sim.fire.burningCount ?? 0);
  player.resume();

  menu.hide();
  result.hide();
  hud.show();
  hud.message(
    inSandbox
      ? 'Песочница: таймера нет, расходники бесконечны'
      : 'Разведка. Таймер пойдёт с первой проводной цели',
    4,
  );
  paused = false;
  last = performance.now();
  input.requestLock();
}

function toHub(): void {
  paused = true;
  player.suspend();
  hud.hide();
  input.releaseLock();
  menu.render(profile, level.brief);
  menu.show();
}

/**
 * Rapier — WASM, он грузится асинхронно. Игра стартует немедленно на
 * headless-дублёре и бесшовно переезжает на настоящий солвер.
 */
async function upgradeToRapier(h: Heist): Promise<void> {
  try {
    const physics = await RapierPhysics.create(h.sim.world, {
      protectedMaterials: h.protectedMaterials(),
    });
    if (heist === h) h.sim.setPhysics(physics);
    else physics.dispose();
  } catch (err) {
    console.warn('Rapier не загрузился, остаёмся на встроенной физике', err);
  }
}

function wireEvents(h: Heist): void {
  h.sim.world.events.on('voxels:removed', (e) => {
    if (e.count > 0) particles.emitSmoke(e.center, Math.min(6, 1 + e.count / 40), 0.8);
    if (e.debris) particles.emitDebris(e.debris, e.cause === 'explosive' ? 1.5 : 1);
  });

  h.sim.world.events.on('impact', (e) => {
    particles.emitSmoke(e.point, 4, 1.2);
    particles.emitSparks(e.point, 6);
  });

  h.sim.world.events.on('fire:ignited', (e) => {
    const limit = { low: 256, medium: 768, high: 1536 }[renderer.currentQuality];
    if (particles.count < limit) particles.emitFire(e.point, 1);
  });

  h.mission.events.on('alarm:started', () =>
    hud.message(`Тревога. ${Math.round(h.mission.config.alarmSeconds)} секунд`, 3),
  );

  h.pursuit.events.on('pursuit:inbound', (e) =>
    hud.message(e.kind === 'boat' ? 'Катер в гавани' : 'Вертолёт на подлёте', 3),
  );
  h.pursuit.events.on('pursuit:close', () => hud.message('Он над тобой', 2));
  h.mission.events.on('target:delivered', (e) => hud.message(`${e.target.name} — в машине`, 2));

  h.events.on('heist:finished', (r) => {
    paused = true;
    player.suspend();
    input.releaseLock();
    saveProfile();
    const record = profile.record(r.missionId);
    result.show(r.success, [
      r.success
        ? `Вынесено: ${r.delivered.length}, из них ценностей: ${r.valuablesDelivered}.`
        : r.reason === 'timeout'
          ? 'Таймер вышел. Вертолёт над портом.'
          : 'Заход прерван.',
      `Под тревогой: ${r.alarmTime.toFixed(1)} с. Всего: ${r.totalTime.toFixed(1)} с.`,
      `Выплата: ${money(r.payout)}. Наличные: ${money(profile.money)}.`,
      record && Number.isFinite(record.bestAlarmTime)
        ? `Лучшее время под тревогой: ${record.bestAlarmTime.toFixed(1)} с.`
        : '',
    ].filter(Boolean));
  });
}

// ---------------------------------------------------------------------------

const vehicleInput: VehicleInput = { ...NEUTRAL_INPUT };

function handleActions(h: Heist): void {
  for (let slot = 1; slot <= 7; slot++) {
    if (input.take(`Digit${slot}`)) {
      const id = toolBySlot(slot);
      if (id) h.inventory.select(id);
    }
  }

  const wheel = input.takeWheel();
  if (wheel !== 0) h.inventory.cycle(wheel > 0 ? 1 : -1);

  if (input.take('KeyE')) {
    // Стоишь у машины с целью в руках — грузишь в кузов; иначе обычное
    // «взять/положить». Отдельную кнопку заводить незачем: действие одно
    // и то же, разница только в том, что рядом.
    const stowed = h.stow();
    if (stowed) {
      hud.message(`В кузов: ${h.vehicles.get(stowed)?.spec.name ?? 'техника'}`, 1.5);
    } else {
      const id = h.interact();
      if (id) hud.message(h.mission.carriedIds.includes(id) ? 'Взято' : 'Положено', 1.2);
    }
  }

  if (input.take('KeyG') && h.drivingId) {
    const n = h.unloadCargo(h.drivingId);
    if (n > 0) hud.message(`Выгружено: ${n}`, 1.5);
  }

  const veh = h.driving;
  if (veh && veh.inWater && Math.abs(veh.speed) > 1.5) {
    particles.emitSplash(add(veh.position, v3(0, 0.1, 0)), 3);
  }

  if (input.take('KeyF')) {
    const id = h.toggleVehicle();
    if (id) {
      // За рулём вид от третьего лица уместнее: видно габариты и то, во что
      // ты сейчас въедешь. Пешком — обратно от первого.
      thirdPerson = h.driving !== null;
      hud.message(h.driving ? `За рулём: ${h.driving.spec.name}` : 'Вышел', 1.5);
    }
  }

  if (input.take('KeyQ')) {
    const order = ['low', 'medium', 'high'] as const;
    const next = order[(order.indexOf(renderer.currentQuality) + 1) % order.length];
    renderer.setQuality(next);
    hud.message(`Качество: ${next === 'low' ? 'низкое' : next === 'medium' ? 'среднее' : 'высокое'}`, 1.4);
  }

  if (input.take('KeyN')) {
    const order = ['day', 'dusk', 'night'] as const;
    const next = order[(order.indexOf(renderer.time) + 1) % order.length];
    renderer.setDaylight(next);
    hud.message(next === 'day' ? 'День' : next === 'dusk' ? 'Сумерки' : 'Ночь', 1.2);
  }

  if (input.take('KeyV')) {
    thirdPerson = !thirdPerson;
    hud.message(thirdPerson ? 'Вид от третьего лица' : 'Вид от первого лица', 1.2);
  }

  if (input.take('Mouse2')) {
    const n = h.detonate();
    if (n > 0) hud.message(`Подорвано зарядов: ${n}`, 1.5);
  }

  if (input.take('KeyM')) {
    const off = audio.toggleMute();
    player.setMuted(off);
    hud.message(off ? 'Звук выключен' : 'Звук включён', 1.2);
  }

  if (input.take('KeyR')) startRun(sandbox);

  if (input.take('Escape')) {
    toHub();
    return;
  }

  if (input.state.firing) {
    const res = h.use();
    if (res.used) {
      if (res.point && (res.removed ?? 0) > 0) {
        particles.emitSparks(res.point, h.inventory.active === 'blowtorch' ? 10 : 4);
      }
      if (res.reason === undefined && h.inventory.active === 'planks' && res.spawned) {
        hud.message('Доска установлена', 1.2);
      }
    } else if (res.reason === 'needs-second-point') {
      hud.message('Вторая точка доски', 1.5);
    } else if (res.reason === 'no-ammo') {
      hud.message('Пусто', 1);
    }
  }
}

/**
 * Откуда смотрим. От третьего лица камера отъезжает назад, но упирается в
 * геометрию: провалившаяся в стену камера — это чёрный экран и потеря
 * управления, а не «немного другой ракурс».
 */
function cameraEye(h: Heist): { x: number; y: number; z: number } {
  if (!thirdPerson) return h.eye;
  const veh = h.driving;
  const ignore = new Set<number>();
  if (veh) ignore.add(veh.body.id);
  return chaseCamera(h.sim.world, h.eye, h.yaw, h.pitch, {
    distance: veh ? 7 : 3.2,
    height: veh ? 1.2 : 0.35,
    ignore,
  });
}

function readVehicleInput(): VehicleInput {
  const s = input.sample();
  vehicleInput.throttle = s.forward;
  vehicleInput.steer = s.right;
  vehicleInput.brake = s.crouch;
  vehicleInput.blade = s.jump;
  return vehicleInput;
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  const raw = (now - last) / 1000;
  last = now;
  // Огромный dt после сворачивания вкладки не должен телепортировать мир.
  const dt = captureMode ? 0 : clamp(raw, 0, 0.1);
  smoothedFrame += (raw * 1000 - smoothedFrame) * 0.1;

  if (!heist) return;
  const h = heist;

  if (!captureMode && !paused && input.locked) {
    const look = input.consumeLook();
    h.yaw += look.yaw;
    h.pitch = clamp(h.pitch + look.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
    handleActions(h);
    if (paused) return;
    const move = input.sample();
    h.update(dt, move, h.driving ? readVehicleInput() : NEUTRAL_INPUT);
  } else {
    input.clearPressed();
  }

  if (paused) {
    player.suspend();
    return;
  }
  // Захват мыши асинхронный: ожидание не должно закрывать новый звук.
  if (!captureMode && !input.locked) return;

  particles.step(dt);
  const firePointLimit = { low: 48, medium: 128, high: 256 }[renderer.currentQuality];
  const firePoints = [...h.sim.fire.burningPoints(firePointLimit)];
  fireLights.update(firePoints, h.sim.world.time);
  for (const p of firePoints) {
    if (!captureMode && Math.random() < dt * 3.6) particles.emitFire(p.position, p.heat);
  }

  // Слушатель — там же, где камера: звук должен приходить оттуда, куда
  // игрок смотрит, а не из начала координат.
  player.play(
    audio.update(dt, h.eye, {
      alarmActive: h.mission.alarmActive,
      timeLeft: h.mission.timeLeft,
      alarmSeconds: h.level.mission.alarmSeconds ?? 60,
      // Винт слышно раньше, чем видно: это единственное предупреждение,
      // которое приходит вовремя.
      pursuit: h.pursuit.proximity(h.eye),
    }),
  );

  // Дым вокруг головы: он же уводит прицел, он же садит видимость.
  const eye = h.eye;
  const haze = clamp(
    h.sim.smoke.densityAt(eye) * 0.6 +
      h.sim.smoke.opacityAlong(eye, add(eye, scale(h.aimDirection, 12))) * 0.5,
    0,
    1,
  );
  renderer.setAtmosphere({ underwater: h.character.inWater, smoke: haze });

  // Дым живёт в симуляции, а частицы — картинка поверх него: берём
  // облака оттуда, а не выдумываем заново.
  let clouds = 0;
  for (const c of h.sim.smoke.clouds()) {
    if (c.density < 0.25 || clouds++ > 24) continue;
    if (!captureMode && Math.random() < c.density * 0.25) particles.emitSmoke(c.position, 1, 1.6);
  }

  const shake = h.shakeState;
  renderer.setCamera(
    add(cameraEye(h), shake.offset),
    h.yaw + shake.yaw,
    h.pitch + shake.pitch,
    shake.roll,
  );
  renderer.sync(h.sim.world);
  chargeView.update(h.charges.list());
  renderer.render();

  hud.update(
    h,
    dt,
    [
      `тел: ${h.sim.world.bodies.size}`,
      `вокселей: ${h.sim.world.totalSolidVoxels().toLocaleString('ru-RU')}`,
      `чанков: ${renderer.stats.chunks} (ремеш ${renderer.stats.remeshed})`,
      `частиц: ${particles.count}`,
      `огонь: ${h.sim.fire.burningCount}`,
      `${(1000 / Math.max(smoothedFrame, 1)).toFixed(0)} кадр/с`,
    ].join('\n'),
  );
}

/**
 * Отладочный доступ для дымового прогона и ручной проверки из консоли.
 * Игровой логики здесь нет — только вход в уже собранные системы.
 */
declare global {
  interface Window {
    tvox: {
      get heist(): Heist | null;
      renderer: VoxelRenderer;
      particles: ParticleSystem;
      /** Взрыв в точке прицела: быстрый способ проверить обрушение. */
      blast(radius?: number): number;
      /** Поставить игрока и повернуть камеру — для прогонов и отладки. */
      look(x: number, y: number, z: number, yaw: number, pitch: number): void;
      /** Кусок ядра для замеров из прогона: разрушение и структура. */
      core: { carve: typeof carve; stepStructure: typeof stepStructure };
      /** Поставить блок материала — стенд для съёмки состояний. */
      stand(material: string, x: number, y: number, z: number, size?: number): number;
      /** Ударить активным инструментом. Возвращает, сколько снял. */
      swing(tool: string): number;
      /** Поднять все инструменты до максимума — для съёмки состояний. */
      upgradeAll(): void;
      /** Сколько вокселей осталось в теле стенда. */
      standLeft(id: number): number;
      captureStart(isolated?: boolean): Promise<void>;
      captureStep(seconds: number): void;
    };
  }
}

window.tvox = {
  get heist() {
    return heist;
  },
  renderer,
  particles,
  async captureStart(isolated = true) {
    captureMode = true;
    level = isolated ? {
      ...portLevel,
      id: 'material-stage', name: 'Стенд материалов',
      spawn: { position: v3(34.9, 0.05, 29.2), yaw: 0 },
      vehicles: [], triggers: [], routes: [],
      environment: { daylight: 'day', lights: [] },
      mission: { ...portLevel.mission, targets: [] },
      build(sim) {
        const floor = new VoxelShape({sx: 80, sy: 2, sz: 80, voxelSize: 0.1, grounded: true});
        floor.fill({}, Mat.Foundation);
        floor.structural = false;
        floor.transform.position = v3(31, -0.2, 24);
        const body = new Body({kind: 'static', shapes: [floor]});
        sim.world.addBody(body);
        return [body];
      },
    } : portLevel;
    startRun(true);
    // Запись не начинает физику до загрузки того же солвера, что у игры.
    await physicsReady;
    if (!(heist!.sim.physics instanceof RapierPhysics)) throw new Error('Запись требует Rapier');
  },
  captureStep(seconds) {
    if (!heist || !captureMode) return;
    const steps = Math.round(seconds * 60);
    for (let i = 0; i < steps; i++) {
      heist.sim.step(1 / 60);
      heist.charges.step(heist.sim, 1 / 60);
      heist.inventory.tick(1 / 60);
      particles.step(1 / 60);
    }
    renderer.sync(heist.sim.world);
    chargeView.update(heist.charges.list());
    renderer.render();
  },
  blast(radius = 3) {
    if (!heist) return 0;
    const h = heist;
    const hit = h.sim.world.raycast(h.eye, h.aimDirection, { maxDistance: 60 });
    const center = hit ? hit.point : h.eye;
    const res = explode(h.sim.world, { center, radius, power: 1.4, cause: 'debug' });
    h.sim.physics.applyRadialImpulse(center, radius * 2, 1200);
    h.sim.settle();
    return res.removed;
  },
  look(x, y, z, yaw, pitch) {
    if (!heist) return;
    heist.character.teleport(v3(x, y, z));
    heist.yaw = yaw;
    heist.pitch = pitch;
  },
  core: { carve, stepStructure },
  stand(material, x, y, z, size = 12) {
    if (!heist) return -1;
    const mat = materialByName(material);
    if (!mat) return -1;
    // Стенд — не куб, а стенка: в игре ломают стены, и «пробил насквозь»
    // читается на ролике куда лучше, чем «отгрыз угол у кубика».
    const shape = new VoxelShape({ sx: size, sy: size, sz: 4, voxelSize: 0.1, name: material });
    shape.fill({}, mat.id);
    // Плита в основании — из несущего материала. Без неё блок висит сам по
    // себе, структурная целостность честно роняет его в первом же кадре, и
    // снимать оказывается нечего.
    shape.fill({ y1: 2 }, Mat.Foundation);
    shape.transform = { position: v3(x, y, z), rotation: { x: 0, y: 0, z: 0, w: 1 } };
    const body = new Body({ kind: 'static', shapes: [shape], name: `стенд:${material}` });
    heist.sim.world.addBody(body);
    renderer.prime();
    return body.id;
  },
  swing(tool) {
    if (!heist) return 0;
    const h = heist;
    // select возвращает false, если инструмент уже выбран, — на выбор это
    // не влияет, и проверять её результат тут нечего.
    h.inventory.select(tool as ToolId);
    if (h.inventory.active !== tool) return 0;
    // Откат снимаем руками: съёмка идёт по шагам, а не по секундам, и
    // игровые полсекунды между ударами здесь не проходят вовсе.
    h.inventory.tick(10);
    const res = h.use();
    // Заряд сам по себе ничего не показывает — интересен взрыв. Считаем
    // при этом воксели, а не заряды: detonateAll возвращает второе.
    if (tool === 'explosive' && res.used) {
      const before = h.sim.world.totalSolidVoxels();
      h.detonate();
      return before - h.sim.world.totalSolidVoxels();
    }
    return res.removed ?? 0;
  },
  upgradeAll() {
    if (!heist) return;
    for (const id of TOOL_IDS) heist.inventory.setTier(id, MAX_TIER);
  },
  standLeft(id) {
    const body = heist?.sim.world.bodies.get(id);
    if (!body) return 0;
    let n = 0;
    for (const s of body.shapes) n += s.solidVoxels;
    return n;
  },
};

/**
 * Карту можно принести свою: `.json` в формате игры или `.vox` из
 * MagicaVoxel. Бросил в окно — играешь. Пересобирать приложение для этого
 * не нужно, и это ровно то, чего не хватало формату уровня.
 */
enableLevelDrop(window, {
  onLevel(next, fileName) {
    level = next;
    hud.message(`Карта: ${next.name} (${fileName})`, 3);
    menu.render(profile, level.brief);
    if (paused) menu.show();
    else startRun(sandbox);
  },
  onError(message) {
    hud.message(`Карта не загрузилась. ${message}`, 6);
    console.error(message);
  },
  onHover(over) {
    document.body.classList.toggle('is-dropping', over);
  },
});

canvas.addEventListener('click', () => {
  // Браузер пускает звук только после жеста — клик по канвасу и есть жест.
  if (!paused) player.resume();
  if (!paused && !input.locked) input.requestLock();
});

document.addEventListener('pointerlockchange', () => {
  if (!input.locked && !paused && !menu.visible && !result.visible) {
    toHub();
  }
});

requestAnimationFrame(frame);
