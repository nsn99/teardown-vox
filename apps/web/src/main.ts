import {
  PROFILE_STORAGE_KEY,
  AudioDirector,
  Heist,
  LevelSource,
  chaseCamera,
  NEUTRAL_INPUT,
  Profile,
  VehicleInput,
  portLevel,
  toolBySlot,
} from '@tvox/game';
import { RapierPhysics, add, carve, clamp, explode, stepStructure, v3 } from '@tvox/core';
import { FireLights, ParticleSystem, VoxelRenderer } from '@tvox/render';
import { AudioPlayer } from './audio-player.js';
import { Input } from './input.js';
import { Hud, Menu, ResultScreen, money } from './hud.js';
import { enableLevelDrop } from './level-drop.js';

const canvas = document.getElementById('view') as HTMLCanvasElement;

const renderer = new VoxelRenderer({ canvas, quality: 'medium' });
const particles = new ParticleSystem({ capacity: 6000 });
const fireLights = new FireLights(6);
renderer.scene.add(particles.points, fireLights.group);
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
  sandbox = inSandbox;
  heist?.sim.dispose();
  particles.clear();

  heist = new Heist({ level, profile, sandbox: inSandbox });
  heist.start();
  // Карта строится целиком в первый же кадр: бюджет ремеша — про
  // разрушение по ходу игры, а не про загрузку уровня.
  renderer.prime();
  renderer.setDaylight(level.environment?.daylight ?? 'dusk');
  renderer.setLevelLights(level.environment?.lights ?? []);
  wireEvents(heist);
  upgradeToRapier(heist);

  audioOff?.();
  audioOff = audio.listen(heist.sim.world);
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
  } catch (err) {
    console.warn('Rapier не загрузился, остаёмся на встроенной физике', err);
  }
}

function wireEvents(h: Heist): void {
  h.sim.world.events.on('voxels:removed', (e) => {
    if (e.count > 0) particles.emitSmoke(e.center, Math.min(6, 1 + e.count / 40), 0.8);
  });

  h.sim.world.events.on('impact', (e) => {
    particles.emitSmoke(e.point, 4, 1.2);
    particles.emitSparks(e.point, 6);
  });

  h.sim.world.events.on('fire:ignited', (e) => particles.emitFire(e.point, 1));

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
    input.releaseLock();
    paused = true;
    menu.render(profile, level.brief);
    menu.show();
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
  const dt = clamp(raw, 0, 0.1);
  smoothedFrame += (raw * 1000 - smoothedFrame) * 0.1;

  if (!heist) return;
  const h = heist;

  if (!paused && input.locked) {
    const look = input.consumeLook();
    h.yaw += look.yaw;
    h.pitch = clamp(h.pitch + look.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
    handleActions(h);
    const move = input.sample();
    h.update(dt, move, h.driving ? readVehicleInput() : NEUTRAL_INPUT);
  } else {
    input.clearPressed();
  }

  particles.step(dt);
  fireLights.update(h.sim.fire.burningPoints(), h.sim.world.time);
  for (const p of h.sim.fire.burningPoints()) {
    if (Math.random() < 0.06) particles.emitFire(p.position, p.heat);
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

  renderer.setCamera(cameraEye(h), h.yaw, h.pitch);
  renderer.sync(h.sim.world);
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
    };
  }
}

window.tvox = {
  get heist() {
    return heist;
  },
  renderer,
  particles,
  blast(radius = 3) {
    if (!heist) return 0;
    const h = heist;
    const hit = h.sim.world.raycast(h.eye, h.aimDirection, { maxDistance: 60 });
    const center = hit ? hit.point : h.eye;
    const res = explode(h.sim.world, { center, radius, power: 1.4, cause: 'debug' });
    h.sim.physics.applyRadialImpulse(center, radius * 2, 1200);
    h.sim.settle();
    particles.emitDebris(res.debris, 1.5);
    return res.removed;
  },
  look(x, y, z, yaw, pitch) {
    if (!heist) return;
    heist.character.teleport(v3(x, y, z));
    heist.yaw = yaw;
    heist.pitch = pitch;
  },
  core: { carve, stepStructure },
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
  player.resume();
  if (!paused && !input.locked) input.requestLock();
});

document.addEventListener('pointerlockchange', () => {
  if (!input.locked && !paused && !menu.visible && !result.visible) {
    paused = true;
    menu.render(profile, level.brief);
    menu.show();
  }
});

requestAnimationFrame(frame);
