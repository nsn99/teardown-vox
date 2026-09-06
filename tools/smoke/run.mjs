#!/usr/bin/env node
/**
 * Дымовой прогон в настоящем браузере.
 *
 * Поднимает прод-сборку, открывает страницу, запускает миссию, ломает стену
 * и снимает кадры. Юнит-тесты не видят WebGL — а этот прогон видит, и он
 * ловит ровно те поломки, которые в консоли не всплывают: чёрный экран,
 * упавший шейдер, необработанное исключение в кадре.
 *
 *   node tools/smoke/run.mjs [--out shots] [--keep]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const args = process.argv.slice(2);
const outDir = resolve(root, argValue('--out', 'shots'));
const PORT = 4319;

function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
  console.error('Нет сборки. Сначала: npm run build --workspace apps/web');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const server = spawn(
  'npx',
  ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: join(root, 'apps/web'), stdio: ['ignore', 'pipe', 'pipe'] },
);

const stop = () => {
  if (!server.killed) server.kill('SIGTERM');
};
process.on('exit', stop);
process.on('SIGINT', () => {
  stop();
  process.exit(1);
});

await waitForServer(`http://127.0.0.1:${PORT}/`);

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: [
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // Без этого Chromium в песочнице лезет к google.com и висит на таймауте.
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
  ],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});
page.on('requestfailed', (r) => errors.push(`request: ${r.url()} ${r.failure()?.errorText ?? ''}`));
page.on('response', (r) => {
  if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`);
});

const steps = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  await fn();
  steps.push(`${name}: ${Date.now() - t0} мс`);
};

try {
  await step('загрузка страницы', async () => {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#menu:not([hidden])');
  });
  await page.screenshot({ path: join(outDir, '01-hub.png') });

  await step('старт миссии и построение уровня', async () => {
    await page.click('#btn-mission');
    await page.waitForFunction(() => document.getElementById('menu')?.hasAttribute('hidden') === true);
    // Даём меширование: чанки строятся с бюджетом за кадр.
    await page.waitForTimeout(9000);
  });
  await page.screenshot({ path: join(outDir, '02-port.png') });

  const built = await page.evaluate(() => document.querySelector('#stats')?.textContent ?? '');
  if (!/вокселей: [1-9]/.test(built)) throw new Error(`Уровень не построился: ${built}`);

  await step('сцена не чёрная', async () => {
    // WebGL-канвас без preserveDrawingBuffer отдаёт через toBlob пустоту,
    // поэтому яркость меряем по настоящему скриншоту.
    const png = await page.screenshot({ type: 'png' });
    const bright = await brightness(png);
    // Диапазон, а не минимум: залитый белым кадр — такая же поломка,
    // как и чёрный, просто с другой стороны.
    if (bright < 0.25) throw new Error(`Кадр почти чёрный: ${bright.toFixed(3)}`);
    if (bright > 0.985) throw new Error(`Кадр пересвечен: ${bright.toFixed(3)}`);
    steps.push(`доля светлых точек: ${bright.toFixed(3)}`);
  });

  await step('разрушение и обрушение', async () => {
    const before = await voxelCount(page);
    // Клик мышью требует захвата указателя, которого в headless нет,
    // поэтому дёргаем ядро напрямую через отладочный хук.
    const removed = await page.evaluate(() => {
      const h = window.tvox.heist;
      h.pitch = -0.15;
      h.yaw = Math.PI * 0.75;
      return window.tvox.blast(4);
    });
    if (removed <= 0) throw new Error('Взрыв не снял ни одного вокселя');
    await page.waitForTimeout(4000);
    const after = await voxelCount(page);
    const bodies = await page.evaluate(() => window.tvox.heist.sim.world.bodies.size);
    if (after >= before) throw new Error(`Вокселей не убавилось: ${before} → ${after}`);
    steps.push(`снято вокселей: ${removed}, всего ${before} → ${after}, тел: ${bodies}`);
  });
  await page.screenshot({ path: join(outDir, '03-after.png') });

  if (errors.length > 0) {
    throw new Error(`Ошибки в консоли:\n  ${errors.join('\n  ')}`);
  }

  console.log('Дымовой прогон пройден.');
  for (const s of steps) console.log(`  ${s}`);
  console.log(`Скриншоты: ${outDir}`);
} catch (err) {
  console.error(`Дымовой прогон упал: ${err.message}`);
  if (errors.length) console.error(errors.join('\n'));
  await page.screenshot({ path: join(outDir, 'fail.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  stop();
}

/** Доля достаточно светлых пикселей в PNG. */
async function brightness(png) {
  const { chromium: _c } = await import('playwright');
  void _c;
  const { createCanvas, loadImage } = await tryCanvas();
  if (createCanvas) {
    const img = await loadImage(png);
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    let bright = 0;
    let total = 0;
    for (let i = 0; i < data.length; i += 4 * 37) {
      total++;
      const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      if (lum > 45) bright++;
    }
    return bright / total;
  }
  // Без графической библиотеки оцениваем по энтропии PNG: полностью
  // однотонный кадр сжимается в килобайты, живой — в десятки.
  return Math.min(1, png.length / 60_000);
}

async function tryCanvas() {
  try {
    return await import('canvas');
  } catch {
    return {};
  }
}

async function voxelCount(page) {
  const text = await page.evaluate(() => document.querySelector('#stats')?.textContent ?? '');
  const m = text.match(/вокселей: ([\d\s ]+)/);
  return m ? Number(m[1].replace(/[\s ]/g, '')) : -1;
}

/** Playwright кладёт браузер в каталог с версией — ищем, а не гадаем. */
function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dirs = readdirSync(base).filter((d) => d.startsWith('chromium-'));
  for (const d of dirs) {
    const p = join(base, d, 'chrome-linux', 'chrome');
    if (existsSync(p)) return p;
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
