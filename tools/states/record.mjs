#!/usr/bin/env node
/**
 * Съёмка состояний: цел → повреждён → разрушен.
 *
 * Ролик на каждый материал и на каждый инструмент плюс запись полного
 * обрушения склада. Нужны они не для красоты: разрушение — единственная
 * часть игры, где «работает или нет» глазами видно сразу, а тестом почти
 * не описывается. Тест скажет, что снялось 812 вокселей; вопрос «а
 * выглядит ли это как проломленная кирпичная стена» тест не решает.
 *
 * Кадры снимаются по шагам симуляции, а не по времени: под SwiftShader
 * страница идёт полтора кадра в секунду, и запись экрана дала бы
 * слайд-шоу. Тридцать снимков склеиваются в ролик на тридцати кадрах в
 * секунду — то есть ролик показывает игровое время, а не время съёмки.
 *
 *   node tools/states/record.mjs [--out shots/states] [--only кирпич]
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const outDir = resolve(root, argValue('--out', 'shots/states'));
const only = argValue('--only', '');
const PORT = 4323;

/**
 * Что чем ломаем.
 *
 * Пара «материал — инструмент» выбрана не случайно: снимать, как
 * огнетушитель не берёт бетон, бессмысленно. Для каждого материала берём
 * инструмент, который его действительно берёт, — ролик должен показывать
 * разрушение, а не бессилие.
 */
const MATERIALS = [
  { name: 'rock', tool: 'explosive', label: 'камень' },
  { name: 'dirt', tool: 'sledge', label: 'земля' },
  { name: 'concrete', tool: 'explosive', label: 'бетон' },
  { name: 'brick', tool: 'sledge', label: 'кирпич' },
  { name: 'plank', tool: 'shotgun', label: 'доска' },
  { name: 'wood', tool: 'sledge', label: 'дерево' },
  { name: 'metal', tool: 'blowtorch', label: 'металл' },
  { name: 'heavy_metal', tool: 'explosive', label: 'тяжёлый металл' },
  { name: 'glass', tool: 'shotgun', label: 'стекло' },
  { name: 'plastic', tool: 'sledge', label: 'пластик' },
  { name: 'foliage', tool: 'sledge', label: 'листва' },
  { name: 'cable', tool: 'sledge', label: 'кабель' },
];

/** Каждый инструмент — по одной кирпичной стенке. */
const TOOLS = ['sledge', 'shotgun', 'explosive', 'blowtorch', 'spraycan', 'extinguisher', 'planks'];

if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
  console.error('Нет сборки. Сначала: npm run build');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const tmp = join(outDir, '.frames');

const server = spawn(
  'npx',
  ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: join(root, 'apps/web'), stdio: ['ignore', 'pipe', 'pipe'] },
);
const stop = () => {
  if (!server.killed) server.kill('SIGTERM');
};
process.on('exit', stop);

await waitForServer(`http://127.0.0.1:${PORT}/`);

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: [
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
  ],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('#menu:not([hidden])');
await page.click('#btn-sandbox').catch(() => page.click('#btn-mission'));
await page.waitForFunction(
  () => (window.tvox?.renderer?.stats?.dirty ?? 1) === 0 && (window.tvox?.renderer?.stats?.chunks ?? 0) > 0,
  undefined,
  { timeout: 240000, polling: 250 },
);

// Свободное место во дворе: стенд ставим там, где ничего не мешает.
// Блок 1.4 м, игрок в двух шагах и смотрит ему в середину.
const STAND = { x: 34, y: 0.02, z: 27 };
const EYE = { x: 34.9, y: 0.05, z: 28.9 };

const made = [];

for (const m of MATERIALS) {
  if (only && !m.name.includes(only) && !m.label.includes(only)) continue;
  await clip(`материал-${m.name}`, `${m.label} × ${m.tool}`, m.name, m.tool);
}
for (const tool of TOOLS) {
  if (only && !tool.includes(only)) continue;
  await clip(`инструмент-${tool}`, `${tool} × кирпич`, 'brick', tool);
}
if (!only) await collapse();

writeFileSync(
  join(outDir, 'README.md'),
  ['# Ролики состояний', '', 'Снято: ' + new Date().toISOString(), '', ...made.map((m) => `- ${m}`), ''].join('\n'),
  'utf8',
);
console.log(`Готово: ${made.length} роликов в ${outDir}`);

await browser.close().catch(() => {});
stop();
setTimeout(() => process.exit(0), 1000).unref();

/** Один ролик: ставим блок, снимаем целым, бьём, снимаем до конца. */
async function clip(file, title, material, tool) {
  process.stdout.write(`… ${title}\n`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  const id = await page.evaluate(
    ([mat, stand, eye]) => {
      window.tvox.look(eye.x, eye.y, eye.z, 0, -0.25);
      // Инструменты на максимуме: ролик показывает, как материал ломается,
      // а не как первая ступень его не берёт. Бессилие — тоже поведение,
      // но у него своё место в тестах, а не в справочнике состояний.
      window.tvox.upgradeAll();
      return window.tvox.stand(mat, stand.x, stand.y, stand.z, 18);
    },
    [material, STAND, EYE],
  );
  if (id < 0) {
    console.error(`  материал «${material}» не найден`);
    return;
  }
  await settle();

  let n = 0;
  const shot = async () => {
    await page.screenshot({ path: join(tmp, `${String(n++).padStart(4, '0')}.png`) });
  };

  // Цел: несколько кадров, чтобы состояние успело прочитаться.
  for (let i = 0; i < 6; i++) await shot();

  let left = await page.evaluate((b) => window.tvox.standLeft(b), id);
  const start = left;
  let hits = 0;
  for (let i = 0; i < 24 && left > 0; i++) {
    // Целимся не в одну точку: пробив дыру, луч уходит сквозь неё, и
    // дальше инструмент бьёт по воздуху. Игрок так не делает — он ведёт
    // по стене, и ролик должен показывать именно это.
    hits += await page.evaluate(
      ([t, e, k]) => {
        const yaw = ((k % 6) - 2.5) * 0.12;
        const pitch = -0.5 + Math.floor(k / 6) * 0.1;
        window.tvox.look(e.x, e.y, e.z, yaw, pitch);
        return window.tvox.swing(t);
      },
      [tool, EYE, i],
    );
    await page.waitForTimeout(120);
    await settle(6000);
    await shot();
    left = await page.evaluate((b) => window.tvox.standLeft(b), id);
  }
  for (let i = 0; i < 4; i++) await shot();

  encode(file, title);
  // Второе число — то, что осталось от стенда. Третье — сколько вокселей
  // сняли по сцене вообще: у дробовика конус уходит за стенку и цепляет
  // всё, что за ней, поэтому оно бывает больше самого стенда.
  made.push(`${title}: стенд ${start} → ${left}, по сцене снято ${hits}`);
  await page.evaluate((b) => {
    const world = window.tvox.heist.sim.world;
    const body = world.bodies.get(b);
    if (body) world.removeBody(body);
  }, id);
  await settle();
}

/** Полное обрушение склада в игровом масштабе. */
async function collapse() {
  process.stdout.write('… обрушение склада\n');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  await page.evaluate(() => window.tvox.look(40, 6, 40, Math.PI * 0.78, -0.18));
  await settle(120000);

  let n = 0;
  const shot = async () => page.screenshot({ path: join(tmp, `${String(n++).padStart(4, '0')}.png`) });
  for (let i = 0; i < 4; i++) await shot();

  // Бьём по несущим: смысл записи — обрушение, а не дырки в стене.
  const points = [
    [10, 1.2, 16],
    [22, 1.2, 16],
    [10, 1.2, 28],
    [22, 1.2, 28],
    [16, 1.2, 22],
  ];
  for (const p of points) {
    await page.evaluate((c) => {
      return window.tvox.core.carve(
        window.tvox.heist.sim.world,
        { kind: 'sphere', center: { x: c[0], y: c[1], z: c[2] }, radius: 2.2 },
        { power: 1, damage: 1, instant: true, falloff: 'quadratic', cause: 'debug' },
      ).removed;
    }, p);
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(150);
      await shot();
    }
  }
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(200);
    await shot();
  }
  encode('обрушение-склада', 'полное обрушение склада');
  made.push('полное обрушение склада');
}

/** Кадры в ролик. Игровое время, тридцать кадров в секунду. */
function encode(file, title) {
  const out = join(outDir, `${file}.webm`);
  const res = spawnSync('ffmpeg', [
    '-y',
    '-loglevel', 'error',
    '-framerate', '8',
    '-i', join(tmp, '%04d.png'),
    '-c:v', 'libvpx-vp9',
    '-b:v', '0',
    '-crf', '38',
    '-pix_fmt', 'yuv420p',
    out,
  ], { encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(`  ffmpeg не собрал ролик «${title}»: ${res.stderr}`);
    return;
  }
  const frames = readdirSync(tmp).length;
  process.stdout.write(`  ✓ ${title}: ${frames} кадров → ${file}.webm\n`);
}

async function settle(timeout = 60000) {
  const started = Date.now();
  let best = Infinity;
  let moved = started;
  for (;;) {
    const dirty = await page.evaluate(() => window.tvox?.renderer?.stats?.dirty ?? -1);
    if (dirty === 0) {
      await page.waitForTimeout(200);
      return;
    }
    if (dirty >= 0 && dirty < best) {
      best = dirty;
      moved = Date.now();
    }
    if (Date.now() - moved > 15000 || Date.now() - started > timeout) return;
    await page.waitForTimeout(250);
  }
}

function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  try {
    for (const d of readdirSync(base).filter((x) => x.startsWith('chromium-'))) {
      const p = join(base, d, 'chrome-linux', 'chrome');
      if (existsSync(p)) return p;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function waitForServer(url) {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* ещё поднимается */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Сервер предпросмотра не поднялся');
}
