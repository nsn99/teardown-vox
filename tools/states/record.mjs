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
 * слайд-шоу. Десять снимков склеиваются в ролик на десяти кадрах в
 * секунду — то есть ролик показывает игровое время, а не время съёмки.
 *
 *   node tools/states/record.mjs [--out shots/states] [--only кирпич]
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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
const FPS = 10;

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

if (!existsSync(join(root, 'apps/web/dist/index.html'))) throw new Error('Сначала npm run build');
mkdirSync(outDir, { recursive: true });
const server = spawn('npm', ['run', 'preview', '--workspace', 'apps/web', '--', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
let browser;
const made = [];
const errors = [];
try {
  await waitForServer(`http://127.0.0.1:${PORT}`);
  browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
    if (message.text().startsWith('[capture]')) console.log(message.text());
  });
  await page.goto(`http://127.0.0.1:${PORT}`);
  await page.waitForSelector('#btn-sandbox');
  await page.click('#btn-sandbox');
  const jobs = MATERIALS.map(m => ({file: `материал-${m.name}`, mat: m.name, tool: m.tool, title: m.label}));
  jobs.push(...TOOLS.map(tool => ({file: `инструмент-${tool}`, mat: tool === 'extinguisher' ? 'wood' : 'brick', tool, title: tool})));
  for (const job of jobs) {
    if (only && !`${job.file} ${job.title}`.includes(only)) continue;
    console.log(`… ${job.file}`);
    await page.evaluate(() => window.tvox.captureStart());
    const id = await page.evaluate(mat => {
      const t = window.tvox;
      t.upgradeAll();
      t.look(34.9, .05, 29.2, 0, -.4);
      return t.stand(mat, 34, .02, 27, 18);
    }, job.mat);
    const tmp = join(outDir, '.frames', job.file);
    mkdirSync(tmp, {recursive: true});
    const start = await page.evaluate(id => window.tvox.standLeft(id), id);
    for (let frame = 0; frame < 40; frame++) {
      if (frame >= 6 && frame < 32 && frame % 2 === 0) {
        await page.evaluate(({id, tool, frame}) => {
          const t = window.tvox, h = t.heist, body = h.sim.world.bodies.get(id);
          h.inventory.select(tool); h.inventory.tick(10);
          // Целимся в существующую клетку стенда, не стреляем в фон сквозь дыру.
          const shape = body?.shapes[0];
          const targets = [];
          if (shape) for (let y = 3; y < shape.sy; y++) for (let x = 0; x < shape.sx; x++) {
            for (let z = shape.sz - 1; z >= 0; z--) if (shape.get(x,y,z)) {
              targets.push(shape.voxelCenterWorld(x,y,z,body.transform)); break;
            }
          }
          if (!targets.length) return;
          const point = targets[Math.floor(((frame - 6) / 26) * (targets.length - 1))];
          const eye = h.eye, dx = point.x-eye.x, dy = point.y-eye.y, dz = point.z-eye.z;
          h.yaw = Math.atan2(-dx, -dz); h.pitch = Math.atan2(dy, Math.hypot(dx,dz));
          if (tool === 'extinguisher' && frame === 6) h.sim.fire.igniteArea(h.sim.world, point, 1, 1);
          if (tool === 'explosive') {
            if (frame === 6 || frame === 8) h.use();
            if (frame === 12) h.detonate();
          } else h.use();
        }, {id, tool: job.tool, frame});
      }
      await shot(page, tmp, frame);
    }
    const end = await page.evaluate(id => window.tvox.standLeft(id), id);
    encode(job.file, tmp, 40);
    made.push({ ...job, start, end, frames: 40 });
    console.log(`  ✓ ${start} → ${end}`);
  }
  if (!only || only === 'collapse') {
    console.log('… обрушение-склада');
    await page.evaluate(() => window.tvox.captureStart(false));
    await page.evaluate(() => {
      const t = window.tvox;
      t.look(36, 11, 40, 0, 0);
      const eye = t.heist.eye, dx = 16-eye.x, dy = 4-eye.y, dz = 22-eye.z;
      t.heist.yaw = Math.atan2(-dx,-dz); t.heist.pitch = Math.atan2(dy,Math.hypot(dx,dz));
      t.renderer.setDaylight('day');
    });
    const tmp = join(outDir, '.frames', 'обрушение-склада');
    mkdirSync(tmp, {recursive: true});
    let detached = 0;
    for (let frame = 0; frame < 90; frame++) {
      if ([10,20,30,40].includes(frame)) {
        console.log(`  сектор ${frame / 10}`);
        const n = frame/10-1;
        detached += await page.evaluate(n => {
          const t = window.tvox, world = t.heist.sim.world;
          const started = performance.now();
          t.core.carve(world, {kind:'box', center:{x: n%2 ? 22:10, y:1, z:n<2 ? 18:28}, halfExtents:{x:6,y:.4,z:5}}, {power:2,damage:0,instant:true,falloff:'none',cause:'capture-support-cut'});
          console.log('[capture] carve ms', performance.now()-started);
          const result = t.heist.sim.settle().detachedVoxels;
          console.log('[capture] settle ms', performance.now()-started, 'detached', result);
          return result;
        }, n);
      }
      await shot(page, tmp, frame);
      if (frame % 10 === 0) console.log(`  кадр ${frame}`);
    }
    const fragments = await page.evaluate(() => [...window.tvox.heist.sim.world.bodies.values()].filter(b => b.kind === 'dynamic').length);
    if (detached === 0) throw new Error('Опоры удалены, но ничего не отделилось');
    encode('обрушение-склада', tmp, 90);
    made.push({file:'обрушение-склада', frames:90, detached, fragments});
    console.log(`  ✓ отделено ${detached} вокселей`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  if (!only && made.length !== 20) throw new Error(`Ожидалось 20 роликов, получено ${made.length}`);
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({fps:FPS, recorded:new Date().toISOString(), clips:made}, null, 2));
  writeFileSync(join(outDir, 'README.md'), '# Ролики состояний\n\nФиксированный шаг 1/60 с, 10 кадров/с. Каждый стенд начинает чистую сцену.\n\n'+made.map(m => `- ${m.file}: ${m.start ?? ''} → ${m.end ?? m.detached}`).join('\n')+'\n');
  console.log(`Готово: ${made.length} роликов`);
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}

async function shot(page, tmp, n) {
  await page.evaluate(() => window.tvox.captureStep(1/10));
  await page.waitForFunction(() => window.tvox.renderer.stats.dirty === 0, undefined, {timeout:60000, polling:50});
  await page.screenshot({path:join(tmp, `${String(n).padStart(4,'0')}.png`)});
}
function encode(file, tmp, count) {
  const res = spawnSync('ffmpeg', ['-y','-loglevel','error','-framerate',String(FPS),'-i',join(tmp,'%04d.png'),'-frames:v',String(count),'-c:v','libvpx-vp9','-b:v','0','-crf','34','-pix_fmt','yuv420p',join(outDir,`${file}.webm`)], {encoding:'utf8'});
  if (res.status !== 0) throw new Error(`ffmpeg: ${res.stderr || res.error}`);
}
function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!existsSync(base)) return undefined;
  for (const dir of readdirSync(base).filter(x=>x.startsWith('chromium-'))) {
    for (const folder of ['chrome-linux','chrome-linux64']) {
      const path = join(base,dir,folder,'chrome'); if (existsSync(path)) return path;
    }
  }
}
async function waitForServer(url) {
  for (let i=0; i<120; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* старт сервера */ }
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw new Error('Preview не поднялся');
}
