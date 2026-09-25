#!/usr/bin/env node
/** Минутный пожар: прогресс ремеша под нагрузкой и завершение очереди. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const root = process.cwd();
const out = resolve(root, 'shots/fire-long');
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
  await page.goto('http://127.0.0.1:4193');
  await page.click('#btn-sandbox');
  await page.evaluate(async () => {
    const t = window.tvox;
    await t.captureStart(false);
    t.renderer.setQuality('low');
    t.look(11, 3, 11, 0, -.3);
    window.longFire = { appliedWhileBurning: 0, peakBurning: 0, samples: [] };
    const original = t.renderer.applyResult.bind(t.renderer);
    t.renderer.applyResult = r => {
      const before = t.renderer.landed;
      original(r);
      if (t.heist.sim.fire.burningCount > 100 && t.renderer.landed > before) window.longFire.appliedWhileBurning++;
    };
    t.heist.sim.fire.igniteArea(t.heist.sim.world, { x: 11, y: .35, z: 5 }, 2);
  });
  for (let i = 0; i < 120; i++) {
    await page.evaluate(() => {
      const t = window.tvox;
      t.captureStep(.5);
      window.longFire.peakBurning = Math.max(window.longFire.peakBurning, t.heist.sim.fire.burningCount);
    });
    // Дать воркерам и обработчикам ответа отработать между изменениями.
    await page.waitForTimeout(30);
    if (i % 20 === 19) {
      const sample = await page.evaluate(() => ({ seconds: window.tvox.heist.sim.world.time, burning: window.tvox.heist.sim.fire.burningCount, dirty: window.tvox.renderer.stats.dirty, applied: window.longFire.appliedWhileBurning }));
      report.checks.push(sample);
      console.log(JSON.stringify(sample));
    }
  }
  report.stress = await page.evaluate(() => {
    const t = window.tvox, h = t.heist;
    const before = h.sim.world.totalSolidVoxels();
    h.sim.fire.extinguish(h.sim.world, { x: 11, y: .35, z: 5 }, 30, 2);
    return { ...window.longFire, before, after: h.sim.world.totalSolidVoxels(), workers: t.renderer.stats.workers, burning: h.sim.fire.burningCount };
  });
  assert.ok(report.stress.peakBurning >= 3000);
  assert.ok(report.stress.appliedWhileBurning > 20, 'Ремеш должен показывать прогресс до тушения');
  assert.ok(report.stress.workers > 0);
  assert.equal(report.stress.before, report.stress.after, 'Тушение не удаляет воксели');
  assert.equal(report.stress.burning, 0);
  await page.waitForFunction(() => window.tvox.renderer.stats.dirty === 0);
  await page.waitForFunction(() => window.tvox.renderer.queue.active === 0);
  await page.screenshot({ path: join(out, 'after-fire.png') });
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(JSON.stringify(report));
} catch (error) {
  report.failure = String(error);
  report.state = await page?.evaluate(() => ({ burning: window.tvox?.heist?.sim.fire.burningCount, eye: window.tvox?.heist?.eye, active: window.tvox?.heist?.inventory.active, pitch: window.tvox?.heist?.pitch, locked: !!document.pointerLockElement, stats: window.tvox?.renderer.stats })).catch(() => null);
  throw error;
} finally {
  writeFileSync(join(out, 'browser.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  server.kill('SIGTERM');
}
