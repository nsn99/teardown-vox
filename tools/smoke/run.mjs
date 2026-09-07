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
import { appendFileSync, mkdirSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
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

// Разрешение поменьше игрового: на раннере рисует SwiftShader, то есть
// процессор, и каждый лишний пиксель — это секунды прогона.
const page = await browser.newPage({ viewport: { width: 1024, height: 576 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});
page.on('requestfailed', (r) => errors.push(`request: ${r.url()} ${r.failure()?.errorText ?? ''}`));
page.on('response', (r) => {
  if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`);
});

// Предохранитель: прогон, который завис, должен падать, а не занимать
// раннер на полчаса.
const HARD_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 600_000);
const hardStop = setTimeout(() => {
  console.error(`Дымовой прогон не уложился в ${HARD_TIMEOUT_MS} мс.`);
  process.exit(1);
}, HARD_TIMEOUT_MS);
hardStop.unref();

const steps = [];

/**
 * Журнал прогона.
 *
 * Пишется всегда, в том числе при падении, и уезжает вместе со
 * скриншотами в артефакт CI. Иначе «Process completed with exit code 1»
 * в интерфейсе Actions — это всё, что остаётся от упавшего прогона.
 */
const saveLog = (verdict) => {
  const lines = [
    `Дымовой прогон: ${verdict}`,
    `Когда: ${new Date().toISOString()}`,
    '',
    ...steps,
    ...(errors.length ? ['', 'Консоль страницы:', ...errors] : []),
  ];
  try {
    writeFileSync(join(outDir, 'smoke.log'), lines.join('\n') + '\n', 'utf8');
  } catch {
    /* журнал — удобство, а не условие прохождения */
  }
  // Сводка прогона GitHub Actions. Без неё «Process completed with exit
  // code 1» — это всё, что видно на странице упавшей сборки, и причину
  // приходится искать в логе раннера, до которого доходят не всегда.
  try {
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
      appendFileSync(
        summary,
        `### Дымовой прогон: ${verdict}\n\n\`\`\`\n${lines.slice(2).join('\n')}\n\`\`\`\n`,
        'utf8',
      );
    }
  } catch {
    /* сводка — тоже удобство */
  }
};

const step = async (name, fn) => {
  const t0 = Date.now();
  process.stdout.write(`… ${name}\n`);
  try {
    await fn();
  } catch (err) {
    steps.push(`${name}: УПАЛ — ${err.message}`);
    saveLog(`упал на шаге «${name}»`);
    throw err;
  }
  const dt = Date.now() - t0;
  process.stdout.write(`  ✓ ${name}: ${dt} мс\n`);
  steps.push(`${name}: ${dt} мс`);
};

try {
  await step('загрузка страницы', async () => {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#menu:not([hidden])');
  });
  await page.screenshot({ path: join(outDir, '01-hub.png') });

  // Чем именно рисуется картинка. На раннере это программный SwiftShader,
  // и если он вдруг не поднялся, знать об этом надо первым делом, а не
  // гадать по тёмному кадру десятью шагами позже.
  steps.push(
    `видеослой: ${await page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') ?? c.getContext('webgl');
      if (!gl) return 'WebGL недоступен';
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      return `${name} (${gl.getParameter(gl.VERSION)})`;
    })}`,
  );

  await step('старт миссии и построение уровня', async () => {
    await page.click('#btn-mission');
    await page.waitForFunction(() => document.getElementById('menu')?.hasAttribute('hidden') === true);
    // Ждём не «сколько-нибудь секунд», а конкретного состояния: ни одного
    // недостроенного чанка. Фиксированная пауза — это ставка на скорость
    // раннера, а раннер бывает втрое медленнее ноутбука.
    await page.waitForFunction(
      () => (window.tvox?.renderer?.stats?.dirty ?? 1) === 0 && (window.tvox?.renderer?.stats?.chunks ?? 0) > 0,
      undefined,
      { timeout: 90000, polling: 250 },
    );
    // Кадр после сборки: свет и тени должны успеть лечь.
    await page.waitForTimeout(600);
  });
  await page.screenshot({ path: join(outDir, '02-port.png') });

  const built = await page.evaluate(() => document.querySelector('#stats')?.textContent ?? '');
  if (!/вокселей: [1-9]/.test(built)) throw new Error(`Уровень не построился: ${built}`);

  // Отдельная проверка до яркости: если геометрии в сцене нет, диагноз
  // должен быть «нечего показывать», а не «кадр тёмный».
  const mesh = await page.evaluate(() => ({ ...window.tvox.renderer.stats }));
  if (mesh.quads <= 0 || mesh.dirty > 0) {
    throw new Error(`Сцена не смеширована: ${JSON.stringify(mesh)}`);
  }
  steps.push(`сцена: чанков ${mesh.chunks}, квадов ${mesh.quads.toLocaleString('ru-RU')}`);

  await step('сцена не чёрная', async () => {
    // WebGL-канвас без preserveDrawingBuffer отдаёт через toBlob пустоту,
    // поэтому яркость меряем по настоящему скриншоту.
    const png = await page.screenshot({ type: 'png' });
    const bright = await brightness(png);
    const mean = await meanLuminance(png);
    // Диапазон, а не минимум: залитый белым кадр — такая же поломка,
    // как и чёрный, просто с другой стороны. Границы широкие намеренно:
    // проверка ловит «нечего показывать», а не художественный замысел.
    // Узкий коридор здесь означал бы красный CI на каждую правку света.
    if (bright < 0.1) throw new Error(`Кадр почти чёрный: доля светлых ${bright.toFixed(3)}`);
    if (bright > 0.985) throw new Error(`Кадр пересвечен: доля светлых ${bright.toFixed(3)}`);
    if (mean >= 0 && mean < 0.02) throw new Error(`Кадр почти чёрный: средняя ${mean.toFixed(4)}`);
    steps.push(`доля светлых точек: ${bright.toFixed(3)}, средняя яркость: ${mean.toFixed(4)}`);
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

  await step('свет попадает внутрь через пробитую крышу', async () => {
    // Смысл небесного света в одной фразе приёмки: пробил крышу — внутри
    // стало светло. Это единственная проверка освещения, которую можно
    // сделать машиной, а не глазами, поэтому она здесь и есть.
    // Смотрим на пол: именно туда ляжет свет из дыры. Снимать крышу,
    // в которой эту дыру и пробили, бессмысленно — там меняется небо в
    // проёме, а не освещённость зала.
    const atFloor = () => window.tvox.look(16, 1.7, 22, 0, -0.55);
    await page.evaluate(atFloor);
    await settleMesh(page);
    const before = await meanLuminance(await page.screenshot({ type: 'png' }));
    await page.screenshot({ path: join(outDir, '04-inside.png') });

    const removed = await page.evaluate(() => {
      window.tvox.look(16, 1.7, 22, 0, 0.95);
      return window.tvox.blast(3);
    });
    if (removed <= 0) throw new Error('Крыша не пробилась, светить нечему');
    await page.evaluate(atFloor);
    await settleMesh(page);
    const after = await meanLuminance(await page.screenshot({ type: 'png' }));
    await page.screenshot({ path: join(outDir, '05-inside-lit.png') });

    if (before < 0) {
      steps.push('внутри склада: замер пропущен, нет графической библиотеки');
      return;
    }
    steps.push(
      `внутри склада: средняя яркость ${before.toFixed(4)} → ${after.toFixed(4)} ` +
        `после дыры в крыше`,
    );
    if (after <= before * 1.08) {
      throw new Error(
        `Свет не попал внутрь: средняя яркость ${before.toFixed(4)} → ${after.toFixed(4)}`,
      );
    }
  });

  await step('дым садит видимость и рассеивается', async () => {
    // Дым — данные, а не спрайты: проверяем это тем же способом, что и
    // свет. Задымляем воздух перед камерой и смотрим, что кадр сел.
    // Наружу, на открытое место: в тёмном зале туман мерить бессмысленно,
    // там и без дыма ничего не видно дальше десяти метров.
    await page.evaluate(() => window.tvox.look(24, 1.7, 13, 0, -0.05));
    await settleMesh(page);
    const clear = await meanLuminance(await page.screenshot({ type: 'png' }));

    const cells = await page.evaluate(() => {
      const smoke = window.tvox.heist.sim.smoke;
      for (let i = 0; i < 600; i++) {
        smoke.emit({ x: 18 + (i % 14), y: 1 + ((i / 14) % 5), z: 3 + ((i / 70) % 10) }, 1);
      }
      return smoke.size;
    });
    if (cells <= 0) throw new Error('Дым не встал');
    await page.waitForTimeout(700);
    const hazy = await meanLuminance(await page.screenshot({ type: 'png' }));
    await page.screenshot({ path: join(outDir, '06-smoke.png') });

    if (clear < 0) {
      steps.push('дым: замер пропущен, нет графической библиотеки');
      return;
    }
    steps.push(`дым: ${cells} ячеек, яркость ${clear.toFixed(4)} → ${hazy.toFixed(4)}`);
    if (Math.abs(hazy - clear) < 0.01) {
      throw new Error(`Дым ничего не изменил: ${clear.toFixed(4)} → ${hazy.toFixed(4)}`);
    }
  });

  await step('кадр держится в бюджете при активном разрушении', async () => {
    // Мерить один структурный проход бессмысленно: он неделим и намеренно
    // отодвигает следующий. Игрока волнует кадр, поэтому меряем кадры —
    // ровно во время того, как стена сыплется.
    const res = await page.evaluate(async () => {
      const h = window.tvox.heist;
      const core = window.tvox.core;
      const frames = [];
      let carved = 0;
      for (let i = 0; i < 90; i++) {
        if (i % 9 === 0) {
          carved += core.carve(
            h.sim.world,
            { kind: 'sphere', center: { x: 8 + (i / 9) * 0.8, y: 2.2, z: 14.1 }, radius: 0.7 },
            { power: 1, damage: 0, instant: true, falloff: 'quadratic', cause: 'smoke' },
          ).removed;
        }
        const t0 = performance.now();
        h.sim.step(1 / 60);
        frames.push(performance.now() - t0);
      }
      frames.sort((a, b) => a - b);
      return {
        carved,
        median: frames[frames.length >> 1],
        p95: frames[Math.floor(frames.length * 0.95)],
        max: frames[frames.length - 1],
        avg: frames.reduce((a, b) => a + b, 0) / frames.length,
      };
    });

    if (res.carved <= 0) throw new Error('Замер бессмыслен: удары ничего не сняли');
    steps.push(
      `кадр симуляции при разрушении: средняя ${res.avg.toFixed(2)} мс, ` +
        `медиана ${res.median.toFixed(2)}, p95 ${res.p95.toFixed(2)}, макс ${res.max.toFixed(2)}`,
    );

    // Кадр — 16.6 мс на всё, симуляции отводим половину. На общем раннере
    // та же работа идёт втрое медленнее, и требовать там игрового порога
    // бессмысленно. Хуже другое: p95 на чужом железе меряет соседей по
    // машине, а не наш код — локально он гуляет впятеро от прогона к
    // прогону. Поэтому на CI смотрим на медиану: это тот кадр, который
    // игрок видит большую часть времени, и он от шума почти не зависит.
    // Числа при этом печатаются всегда — регрессию видно и без ловушки.
    if (process.env.CI) {
      if (res.median > 20) {
        throw new Error(`Симуляция не в бюджете кадра: медиана ${res.median.toFixed(2)} мс`);
      }
      if (res.avg > 60) {
        throw new Error(`Симуляция не в бюджете кадра: средняя ${res.avg.toFixed(2)} мс`);
      }
      return;
    }
    if (res.avg > 8) {
      throw new Error(`Симуляция не в бюджете кадра: средняя ${res.avg.toFixed(2)} мс`);
    }
    if (res.p95 > 33) {
      throw new Error(`Просадка кадра при разрушении: p95 ${res.p95.toFixed(2)} мс`);
    }
  });

  await step('консоль чистая', async () => {
    // Отдельным шагом, а не постскриптумом: в артефакте CI должно быть
    // видно, что упало именно на консоли, и что именно в ней лежит.
    if (errors.length > 0) {
      throw new Error(`Ошибки в консоли (${errors.length}):\n  ${errors.join('\n  ')}`);
    }
  });

  saveLog('пройден');
  console.log('Дымовой прогон пройден.');
  for (const s of steps) console.log(`  ${s}`);
  console.log(`Скриншоты: ${outDir}`);
} catch (err) {
  saveLog(`упал: ${err.message}`);
  console.error(`Дымовой прогон упал: ${err.message}`);
  console.error('Шаги до падения:');
  for (const s of steps) console.error(`  ${s}`);
  if (errors.length) console.error(errors.join('\n'));
  await page.screenshot({ path: join(outDir, 'fail.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  stop();
  // Vite-предпросмотр умеет держать процесс живым и после SIGTERM,
  // а CI не должен висеть на уже пройденном прогоне.
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
}

/** Дождаться, пока в сцене не останется недостроенных чанков. */
async function settleMesh(page) {
  await page.waitForFunction(
    () => (window.tvox?.renderer?.stats?.dirty ?? 1) === 0,
    undefined,
    { timeout: 60000, polling: 200 },
  );
  await page.waitForTimeout(500);
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

/**
 * Средняя яркость кадра.
 *
 * Доля светлых точек годится, чтобы поймать чёрный экран, но не годится,
 * чтобы поймать «стало светлее»: пятно света в тёмном зале не переводит
 * пиксели через порог, оно поднимает средний уровень.
 */
async function meanLuminance(png) {
  const { createCanvas, loadImage } = await tryCanvas();
  if (!createCanvas) return -1;
  const img = await loadImage(png);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);
  let sum = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += 4 * 7) {
    total++;
    sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  }
  return sum / total / 255;
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
  const m = text.match(/вокселей: ([\d\s\u00a0]+)/);
  return m ? Number(m[1].replace(/[\s\u00a0]/g, '')) : -1;
}

/** Playwright кладёт браузер в каталог с версией — ищем, а не гадаем. */
/**
 * Путь к Chromium.
 *
 * В песочнице разработки браузер лежит в /opt/pw-browsers и Playwright о
 * нём не знает — приходится показывать пальцем. На CI он ставится обычным
 * `playwright install` и находится сам, а каталога из песочницы там нет
 * вовсе: не найдя его, возвращаем undefined и отдаём выбор Playwright.
 */
function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  let dirs = [];
  try {
    dirs = readdirSync(base).filter((d) => d.startsWith('chromium-'));
  } catch {
    return undefined;
  }
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
