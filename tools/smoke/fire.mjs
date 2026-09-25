#!/usr/bin/env node
/** Пожар → тушение → меню: реальный Web Audio и собранная игра. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const root = process.cwd();
const out = resolve(root, 'shots/fire-regression');
mkdirSync(out, { recursive: true });
const server = spawn('npm', ['run', 'preview', '--workspace', 'apps/web', '--', '--port', '4193', '--strictPort'], { stdio: 'ignore' });
const report = { checks: [], errors: [], passed: false };
let browser;
let page;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch('http://127.0.0.1:4193')).ok) { ready = true; break; } } catch { /* сервер запускается */ }
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready, 'Preview не запустился');
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  let executablePath;
  if (existsSync(base)) for (const dir of readdirSync(base).filter(n => n.startsWith('chromium-'))) {
    for (const folder of ['chrome-linux', 'chrome-linux64']) {
      const path = join(base, dir, folder, 'chrome');
      if (existsSync(path)) executablePath = path;
    }
  }
  browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  page.setDefaultTimeout(90000);
  page.on('pageerror', e => report.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') report.errors.push(m.text()); });
  await page.addInitScript(() => {
    const Native = window.AudioContext;
    window.testAudio = [];
    window.AudioContext = class extends Native {
      constructor(...args) {
        super(...args);
        this.testLoops = 0;
        window.testAudio.push(this);
      }
      createBufferSource() {
        const source = super.createBufferSource();
        const start = source.start.bind(source), stop = source.stop.bind(source);
        let live = false;
        source.start = (...args) => { if (source.loop) { live = true; this.testLoops++; } return start(...args); };
        source.stop = (...args) => { if (live) { live = false; this.testLoops--; } return stop(...args); };
        return source;
      }
    };
  });
  await page.goto('http://127.0.0.1:4193');
  await page.click('#btn-sandbox');
  await page.waitForFunction(() => window.tvox.heist && document.pointerLockElement);
  await page.mouse.move(240, 135);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const t = window.tvox;
    t.renderer.setQuality('low');
    t.look(11, .4, 5, 0, -Math.PI / 2 + .02);
    const h = t.heist;
    h.sim.fire.igniteArea(h.sim.world, { x: 11, y: .35, z: 5 }, .15);
  });
  await page.waitForFunction(() => window.testAudio.some(a => a.state === 'running' && a.testLoops > 0));
  report.checks.push('Пожар слышен во время игры');
  // Клавиатура и DOM-ввод на canvas: CDP mouse.down под pointer lock
  // может уводить прицел в headless, поэтому событие направляем явно.
  await page.keyboard.press('Digit3');
  await page.waitForFunction(() => window.tvox.heist.inventory.active === 'extinguisher');
  await page.evaluate(() => window.tvox.look(11, .4, 5, 0, -Math.PI / 2 + .02));
  await page.dispatchEvent('#view', 'mousedown', { button: 0 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.tvox.look(11, .4, 5, 0, -Math.PI / 2 + .02));
  try { await page.waitForFunction(() => window.tvox.heist.sim.fire.burningCount === 0, null, { timeout: 20000 }); }
  finally { await page.dispatchEvent('#view', 'mouseup', { button: 0 }); }
  await page.waitForFunction(() => window.testAudio.every(a => a.testLoops === 0));
  report.checks.push('Огнетушитель погасил пожар; звуковая петля остановилась');
  await page.evaluate(() => {
    const h = window.tvox.heist;
    h.sim.fire.igniteArea(h.sim.world, { x: 14, y: .35, z: 5 }, .15);
  });
  await page.waitForFunction(() => window.testAudio.some(a => a.testLoops > 0));
  await page.keyboard.press('Escape');
  await page.waitForSelector('#menu:not([hidden])');
  await page.waitForFunction(() => window.testAudio.every(a => a.state === 'closed' && a.testLoops === 0));
  const before = await page.evaluate(() => window.tvox.heist.sim.world.time);
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => window.tvox.heist.sim.world.time), before);
  report.checks.push('Escape открыл меню, остановил звук и симуляцию');
  await page.screenshot({ path: join(out, 'menu.png') });
  await page.click('#btn-sandbox');
  await page.waitForFunction(() => window.testAudio.some(a => a.state === 'running'));
  assert.equal(await page.evaluate(() => window.tvox.heist.sim.fire.burningCount), 0);
  assert.equal(await page.evaluate(() => window.testAudio.reduce((n, a) => n + a.testLoops, 0)), 0);
  report.checks.push('Новый запуск восстановил звук без старого пожара');
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(JSON.stringify(report));
} catch (error) {
  report.failure = String(error);
  report.state = await page?.evaluate(() => ({ burning: window.tvox?.heist?.sim.fire.burningCount, eye: window.tvox?.heist?.eye, active: window.tvox?.heist?.inventory.active, pitch: window.tvox?.heist?.pitch, locked: !!document.pointerLockElement, audio: window.testAudio?.map(a => ({ state: a.state, loops: a.testLoops })) })).catch(() => null);
  throw error;
} finally {
  writeFileSync(join(out, 'browser.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  server.kill('SIGTERM');
}
