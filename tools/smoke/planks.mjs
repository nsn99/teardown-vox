#!/usr/bin/env node
/** Два нажатия строят пандус; удержание не создаёт обрезков; игрок поднимается. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const root = process.cwd();
const out = resolve(root, 'shots/planks');
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
  await page.waitForFunction(() => !!document.pointerLockElement);
  await page.mouse.move(240, 135);
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const t = window.tvox, h = t.heist, w = h.sim.world;
    const id = t.stand('foundation', 0, 0, 0, 2);
    const sample = w.bodies.get(id), Body = sample.constructor, Shape = sample.shapes[0].constructor;
    const material = sample.shapes[0].data[0];
    for (const b of [...w.bodies.values()]) w.removeBody(b);
    const floor = new Shape({ sx: 60, sy: 2, sz: 80, voxelSize: .1, grounded: true });
    floor.fill({}, material);floor.transform.position = { x: -3, y: -.2, z: -4 };
    w.addBody(new Body({ kind: 'static', shapes: [floor] }));
    const platform = new Shape({ sx: 15, sy: 10, sz: 10, voxelSize: .1, grounded: true });
    platform.fill({}, material);platform.transform.position = { x: -.75, y: 0, z: -1.5 };
    w.addBody(new Body({ kind: 'static', shapes: [platform] }));
    t.renderer.setQuality('low');t.renderer.setDaylight('day');t.renderer.prime();
    t.look(0, .02, 3.2, 0, 0);
    window.builtPlanks = () => [...w.bodies.values()].filter(b => b.tags.has('built') && !b.destroyed);
  });
  await page.keyboard.press('Digit7');
  await page.waitForFunction(() => window.tvox.heist.inventory.active === 'planks');
  const aimAndPress = async target => page.evaluate(p => {
    const h = window.tvox.heist, eye = h.eye;
    const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z;
    h.yaw = Math.atan2(-dx, -dz);h.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    document.getElementById('view').dispatchEvent(new window.MouseEvent('mousedown', { button: 0, bubbles: true }));
  }, target);
  await aimAndPress({ x: 0, y: 0, z: 2 });
  await page.waitForFunction(() => window.tvox.heist.planks.anchor !== null);
  const anchor = await page.evaluate(() => window.tvox.heist.planks.anchor);
  await page.waitForTimeout(1200);
  assert.deepEqual(await page.evaluate(() => window.tvox.heist.planks.anchor), anchor);
  assert.equal(await page.evaluate(() => window.builtPlanks().length), 0);
  await page.dispatchEvent('#view', 'mouseup', { button: 0 });
  report.checks.push('Удержание первого нажатия выбирает одну точку и не создаёт блоков');
  await aimAndPress({ x: 0, y: 1, z: -.65 });
  await page.waitForFunction(() => window.builtPlanks().length === 1);
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => window.builtPlanks().length), 1);
  assert.equal(await page.evaluate(() => window.tvox.heist.planks.anchor), null);
  await page.dispatchEvent('#view', 'mouseup', { button: 0 });
  report.plank = await page.evaluate(() => {
    const b = window.builtPlanks()[0];
    return { kind: b.kind, volume: b.solidVoxels, anchors: b.shapes[0].attachmentAnchors.size };
  });
  assert.equal(report.plank.kind, 'static');
  assert.ok(report.plank.volume > 100);
  assert.ok(report.plank.anchors > 0);
  report.checks.push('Второе нажатие строит ровно один пандус; он остаётся на опорах');
  await page.evaluate(() => { window.tvox.heist.yaw = 0; window.tvox.heist.pitch = -.3; });
  await page.keyboard.down('KeyW');
  try { await page.waitForFunction(() => window.tvox.heist.playerPosition.z < -.65, null, { timeout: 20000 }); }
  finally { await page.keyboard.up('KeyW'); }
  report.player = await page.evaluate(() => window.tvox.heist.playerPosition);
  assert.ok(report.player.y > .95, 'Игрок должен подняться на платформу высотой 1 м без прыжка');
  report.checks.push('Игрок поднялся по пандусу на метровую платформу без прыжка');
  await page.evaluate(() => window.tvox.look(2, .02, 3.2, .5, -.25));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, 'ramp.png') });
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(JSON.stringify(report));
} catch (error) {
  report.failure = String(error);
  report.state = await page?.evaluate(() => ({
    eye: window.tvox?.heist?.eye, active: window.tvox?.heist?.inventory.active,
    anchor: window.tvox?.heist?.planks.anchor, planks: window.builtPlanks?.().length,
    locked: !!document.pointerLockElement, stats: window.tvox?.renderer.stats,
  })).catch(() => null);
  throw error;
} finally {
  writeFileSync(join(out, 'browser.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  server.kill('SIGTERM');
}
